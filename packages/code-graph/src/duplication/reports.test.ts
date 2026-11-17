import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CLONE_FILES, CLUMP_FILES } from "./acceptance.fixture.js";

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));
const roots: string[] = [];

function fixture(files: Readonly<Record<string, string>>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-duplication-"));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

function run(root: string, ...flags: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", CLI, root, ...flags], {
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function report(root: string, ...flags: string[]) {
  const result = run(root, ...flags, "--json");
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("expression clone reports", () => {
  it("finds the same expression in three differently named, branchless functions", () => {
    const result = report(fixture(CLONE_FILES), "--clones");
    expect(result.clones).toHaveLength(1);
    expect(result.clones[0]).toMatchObject({
      nodeCount: 14,
      fileCount: 3,
      sites: [
        { file: "a.ts", functionId: "a.ts:first", startLine: 1 },
        { file: "b.ts", functionId: "b.ts:second", startLine: 1 },
        { file: "c.ts", functionId: "c.ts:third", startLine: 1 },
      ],
    });
  });

  it("ignores tiny expressions and expressions occurring in only two files", () => {
    const root = fixture({
      "a.ts": CLONE_FILES["a.ts"] ?? "",
      "b.ts": CLONE_FILES["b.ts"] ?? "",
      "c.ts": "export function third() { return { ok: true }; }",
      "d.ts": "export function fourth() { return { ok: true }; }",
      "e.ts": "export function fifth() { return { ok: true }; }",
    });
    expect(report(root, "--clones").clones).toEqual([]);
  });
});

describe("duplication report boundaries", () => {
  it("lists five files and all 144 clump sites in one deterministic report", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 5; i += 1) {
      files[`part${i}.ts`] =
        `export function sample${i}(f) { return { kind: "Bad", text: f.text, list: f.list }; }\n`;
    }
    files["calls.ts"] = Array.from(
      { length: 144 },
      (_, i) => `run(input${i}, schemaA, tableA, context${i}, "Item.${i}", { outage: O });`,
    ).join("\n");
    const root = fixture(files);
    const result = report(root, "--clones", "--clumps");
    expect(result.clones).toHaveLength(1);
    expect(result.clones[0].fileCount).toBe(5);
    expect(result.clumps).toHaveLength(1);
    expect(result.clumps[0]).toMatchObject({ values: ["O", "schemaA", "tableA"], siteCount: 144 });
    expect(result.clumps[0].sites).toHaveLength(144);
    expect(run(root, "--clones", "--clumps", "--json").stdout).toBe(
      run(root, "--clones", "--clumps", "--json").stdout,
    );
    const human = run(root, "--clones", "--clumps");
    expect(human.status).toBe(0);
    expect(human.stdout).toContain("5 files, 14 nodes");
    expect(human.stdout).toContain("at 144 sites");
  });

  it("retains a smaller clump when it occurs at more sites than a larger clump", () => {
    const root = fixture({
      "calls.ts": [
        "run(a, b, c, d);",
        "run(a, b, c, d);",
        "run(a, b, c, d);",
        "run(a, b, c, e);",
        "run(a, b, c, e);",
      ].join("\n"),
    });
    expect(report(root, "--clumps").clumps).toMatchObject([
      { values: ["a", "b", "c"], siteCount: 5 },
      { values: ["a", "b", "c", "d"], siteCount: 3 },
    ]);
  });

  it("preserves names and literals by default and broadens matching only when configured", () => {
    const root = fixture({
      ...CLONE_FILES,
      "c.ts":
        'export const third = (other) => ({ kind: "Different", text: other.text, list: other.list });',
      "settings.json": JSON.stringify({ cloneIgnoreIdentifiers: true, cloneIgnoreLiterals: true }),
    });
    expect(report(root, "--clones").clones).toEqual([]);
    expect(
      report(root, "--clones", "--duplication-config", path.join(root, "settings.json")).clones,
    ).toHaveLength(1);
  });

  it("keeps test files out and makes parse failures visible", () => {
    const root = fixture({
      ...CLONE_FILES,
      "c.ts": "function broken( {",
      "c.test.ts": CLONE_FILES["c.ts"] ?? "",
    });
    expect(report(root, "--clones")).toMatchObject({ clones: [], parseFailures: ["c.ts"] });
  });

  it("counts argument values, never property keys or repetitions confined to one argument", () => {
    const root = fixture({
      "calls.ts": [
        'run("label", { label: "other" });',
        'run({ a: "same", b: "same" });',
        "run(schemaA, tableA, { O: variable });",
        "run(schemaA, tableA, { O: different });",
        "run(schemaA, tableA, { O: another });",
      ].join("\n"),
    });
    expect(report(root, "--clumps")).toMatchObject({ clumps: [], repeatedArguments: [] });
  });

  it("rejects gate combinations and invalid settings without writing a ledger", () => {
    const root = fixture({ ...CLONE_FILES, "bad.json": '{"cloneMinNode": 5}' });
    const gate = run(root, "--clones", "--ci");
    expect(gate.status).toBe(2);
    expect(gate.stdout).toBe("");
    expect(gate.stderr).toContain("reports; run gates separately");
    const bad = run(root, "--clumps", "--duplication-config", path.join(root, "bad.json"));
    expect(bad.status).toBe(2);
    expect(bad.stdout).toBe("");
    expect(bad.stderr.trim().split("\n")).toHaveLength(1);
    expect(fs.readdirSync(root).sort()).toEqual(["a.ts", "b.ts", "bad.json", "c.ts"]);
  });
});

describe("data clump reports", () => {
  it("finds three named values travelling together, including an object property value", () => {
    const result = report(fixture(CLUMP_FILES), "--clumps");
    expect(result.clumps).toHaveLength(1);
    expect(result.clumps[0]).toMatchObject({
      callee: "run",
      values: ["O", "schemaA", "tableA"],
      siteCount: 3,
      sites: [{ file: "a.ts" }, { file: "b.ts" }, { file: "c.ts" }],
    });
  });

  it("reports a value repeated across arguments of one call, but no two-value clump", () => {
    const root = fixture({
      "a.ts": 'run(x, s, t, "A.b", { label: "A.b" });',
      "b.ts": Array.from({ length: 10 }, () => "f(a, b);").join("\n"),
    });
    const result = report(root, "--clumps");
    expect(result.clumps).toEqual([]);
    expect(result.repeatedArguments).toHaveLength(1);
    expect(result.repeatedArguments[0]).toMatchObject({
      callee: "run",
      value: '"A.b"',
      site: { file: "a.ts", startLine: 1 },
      arguments: [{ index: 3 }, { index: 4 }],
    });
  });
});
