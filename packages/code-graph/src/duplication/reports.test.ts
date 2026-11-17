import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadCheapProject } from "../extract/project.js";
import { nodeField } from "../syntax/file.js";
import { CLONE_FILES, CLUMP_FILES } from "./acceptance.fixture.js";
import { siteOf } from "./scan.js";
import { argumentValues } from "./values.js";

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

  it("ignores private identifiers only when configured", () => {
    const files: Record<string, string> = {
      "settings.json": JSON.stringify({ cloneIgnoreIdentifiers: true }),
    };
    for (const name of ["a", "b", "c"]) {
      files[`${name}.ts`] = [
        "export class Sample {",
        `#${name};`,
        `read() { return { kind: "Item", text: this.#${name}, list: this.#${name} }; }`,
        "}",
      ].join("\n");
    }
    const root = fixture(files);
    expect(report(root, "--clones").clones).toEqual([]);
    const result = report(
      root,
      "--clones",
      "--duplication-config",
      path.join(root, "settings.json"),
    );
    expect(result.parseFailures).toEqual([]);
    expect(result.clones).toMatchObject([
      {
        nodeCount: 14,
        fileCount: 3,
        sites: [{ file: "a.ts" }, { file: "b.ts" }, { file: "c.ts" }],
      },
    ]);
  });

  it("ignores JSX identifiers only when configured", () => {
    const root = fixture({
      "a.tsx": "export const first = <Alpha one={x} two={y} three={z} />;",
      "b.tsx": "export const second = <Beta one={x} two={y} three={z} />;",
      "c.tsx": "export const third = <Gamma one={x} two={y} three={z} />;",
      "settings.json": JSON.stringify({ cloneIgnoreIdentifiers: true }),
    });
    expect(report(root, "--clones").clones).toEqual([]);
    const result = report(
      root,
      "--clones",
      "--duplication-config",
      path.join(root, "settings.json"),
    );
    expect(result.clones).toMatchObject([{ nodeCount: 15, fileCount: 3 }]);
  });

  it("normalizes template text by option and decoded template escapes by default", () => {
    for (const [texts, settings] of [
      [["Alpha", "Beta", "Gamma"], { cloneIgnoreLiterals: true }],
      [["Alpha", String.raw`\u0041lpha`, String.raw`\x41lpha`], {}],
    ] as const) {
      const files: Record<string, string> = { "settings.json": JSON.stringify(settings) };
      for (const [index, text] of texts.entries()) {
        files[`${index}.ts`] =
          `export const sample${index} = { kind: \`${text}\`, text: f.text, list: f.list };`;
      }
      const root = fixture(files);
      const result = report(
        root,
        "--clones",
        "--duplication-config",
        path.join(root, "settings.json"),
      );
      expect
        .soft(result.clones, JSON.stringify(settings))
        .toMatchObject([{ nodeCount: 15, fileCount: 3 }]);
    }
  });

  it("keeps overflow numeric literals distinct from null across three files", () => {
    const root = fixture({
      "a.ts": "export const first = { kind: 1e400, text: f.text, list: f.list };",
      "b.ts": "export const second = { kind: null, text: f.text, list: f.list };",
      "c.ts": "export const third = { kind: 1e400, text: f.text, list: f.list };",
    });
    expect(report(root, "--clones").clones).toEqual([]);
    fs.writeFileSync(
      path.join(root, "b.ts"),
      "export const second = { kind: 10e399, text: f.text, list: f.list };",
    );
    expect(report(root, "--clones").clones).toMatchObject([{ nodeCount: 14, fileCount: 3 }]);
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

describe("duplication column ownership", () => {
  it("uses SyntaxFile columns for sites and argument values with CRLF and UTF-16 text", () => {
    const root = fixture({ "calls.ts": "/* 😀 */ run(\r\n  value,\r\n  value\r\n);" });
    const unit = loadCheapProject(root).sourceFiles[0];
    if (unit === undefined) throw new Error("missing source unit");
    const statement = unit.syntax.children(unit.syntax.program)[0];
    if (statement === undefined) throw new Error("missing statement");
    const call = nodeField(statement, "expression");
    if (call === null) throw new Error("missing call");
    const column = vi.spyOn(unit.syntax, "startColumn");
    try {
      expect(siteOf(unit, call, null)).toMatchObject({ startLine: 1, startColumn: 10 });
      expect.soft(column).toHaveBeenCalledWith(call);
      column.mockClear();
      expect(argumentValues(unit, call)).toEqual([
        { value: "value", kind: "name", index: 0, line: 2, column: 3 },
        { value: "value", kind: "name", index: 1, line: 3, column: 3 },
      ]);
      expect(column.mock.calls.map(([node]) => unit.syntax.textOf(node))).toEqual([
        "value",
        "value",
      ]);
    } finally {
      column.mockRestore();
    }
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
  it("reports this and super callees and their static member argument values", () => {
    const root = fixture({
      "calls.ts": [
        "class Sample extends Base { check() {",
        'this.run("A", "A");',
        'super.run("B", "B");',
        "run(this.a, this.a);",
        "run(super.a, super.a);",
        ...Array.from({ length: 3 }, () => "this.run(this.a, this.b, this.c);"),
        ...Array.from({ length: 3 }, () => "super.run(super.a, super.b, super.c);"),
        "} }",
      ].join("\n"),
    });
    const result = report(root, "--clumps");
    expect(result.parseFailures).toEqual([]);
    expect(result.clumps).toHaveLength(2);
    expect(result.clumps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          callee: "this.run",
          values: ["this.a", "this.b", "this.c"],
          siteCount: 3,
        }),
        expect.objectContaining({
          callee: "super.run",
          values: ["super.a", "super.b", "super.c"],
          siteCount: 3,
        }),
      ]),
    );
    expect(result.repeatedArguments).toMatchObject([
      { callee: "this.run", value: '"A"', arguments: [{ index: 0 }, { index: 1 }] },
      { callee: "super.run", value: '"B"', arguments: [{ index: 0 }, { index: 1 }] },
      { callee: "run", value: "this.a", arguments: [{ index: 0 }, { index: 1 }] },
      { callee: "run", value: "super.a", arguments: [{ index: 0 }, { index: 1 }] },
    ]);
  });

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
