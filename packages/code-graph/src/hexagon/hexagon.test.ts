import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const packageDir = fileURLToPath(new URL("../../", import.meta.url));
const fixtures = path.join(packageDir, "test/hexagon");
const cli = path.join(packageDir, "src/index.ts");
let temporary = "";

beforeAll(() => {
  temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-hexagon-")));
});

afterAll(() => fs.rmSync(temporary, { recursive: true, force: true }));

function run(root: string, ...flags: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", cli, root, "--hexagon", ...flags], {
    cwd: packageDir,
    encoding: "utf8",
  });
}

describe("--hexagon", () => {
  it.each(["full", "unbagged"])("prints exact text and sorted JSON for %s, repeatably", (name) => {
    const root = path.join(fixtures, name);
    for (const [extension, flags] of [
      ["txt", []],
      ["json", ["--json"]],
    ] as const) {
      const expected = fs.readFileSync(path.join(root, `expected.${extension}`), "utf8");
      for (let repeat = 0; repeat < 2; repeat++) {
        const result = run(root, ...flags);
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        expect(result.stdout).toBe(expected);
      }
    }
  });

  it.each([
    "renamed-exports",
    "parenthesized",
    "merged-interfaces",
    "interface-port",
  ])("prints the exact inventory for %s", (name) => {
    const root = path.join(fixtures, name);
    const result = run(root);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(fs.readFileSync(path.join(root, "expected.txt"), "utf8"));
  });

  it.each([
    ["generic-bag", "1: cannot read Base: generic bag"],
    ["index-signature", "3: cannot read Warehouse: index-signature bag"],
  ])("refuses %s with an exact diagnostic and no report", (name, detail) => {
    const root = path.join(fixtures, name);
    for (const flags of [[], ["--json"]]) {
      const result = run(root, ...flags);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(`code-graph: ${path.join(root, "ports.ts")}:${detail}\n`);
    }
  });

  it.each([[], ["--json"]])("names missing ports.ts with no output (%j)", (...flags) => {
    const root = path.join(fixtures, "missing");
    const result = run(root, ...flags);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`code-graph: missing ports.ts: ${path.join(root, "ports.ts")}\n`);
  });

  it("writes pretty JSON through --out, with no stdout document", () => {
    const destination = path.join(temporary, "hexagon.json");
    const root = path.join(fixtures, "full");
    const result = run(root, "--json", "--pretty", "--out", destination);
    const expected = JSON.parse(fs.readFileSync(path.join(root, "expected.json"), "utf8"));
    const text = `${JSON.stringify(expected, null, 2)}\n`;
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(fs.readFileSync(destination, "utf8")).toBe(text);
    expect(result.stderr).toBe(
      `code-graph: wrote ${Buffer.byteLength(text)} bytes to ${destination}\n`,
    );
  });

  it.each([
    ["ports.ts", "export type Broken =", "cannot parse"],
    ["application/broken.ts", "export function broken( {", "cannot parse"],
    ["adapters/driven/broken.ts", "export const broken =", "cannot parse"],
    ["ports.ts", "export type A = B; export type B = A;", "cyclic bag in ports.ts: A"],
  ])("refuses invalid source in %s (%s)", (file, source, message) => {
    const root = fs.mkdtempSync(path.join(temporary, "invalid-"));
    fs.cpSync(path.join(fixtures, "full"), root, { recursive: true });
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), source);
    const result = run(root, "--json");
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    const detail = message === "cannot parse" ? `${message} ${path.join(root, file)}` : message;
    expect(result.stderr).toBe(`code-graph: ${detail}\n`);
  });
});
