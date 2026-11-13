import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { runHexagon } from "./cli.js";

const packageDir = fileURLToPath(new URL("../../", import.meta.url));
const fixtures = path.join(packageDir, "test/hexagon");
const cli = path.join(packageDir, "src/index.ts");
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hexagon-")));

afterAll(() => fs.rmSync(temporary, { recursive: true, force: true }));

function run(root: string, ...flags: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", cli, root, "--hexagon", ...flags], {
    cwd: packageDir,
    encoding: "utf8",
  });
}

// `ports.ts` holds two features, `Warehouse` and `Depot`, so that no pair of bags can name the one the
// factory builds: only a direct factory export does.
function feature(source: string): string {
  const root = fs.mkdtempSync(path.join(temporary, "feature-"));
  fs.cpSync(path.join(fixtures, "full"), root, { recursive: true });
  fs.appendFileSync(
    path.join(root, "ports.ts"),
    "export type Depot = {};\nexport type DepotDriven = {};\n",
  );
  fs.rmSync(path.join(root, "application"), { recursive: true });
  fs.mkdirSync(path.join(root, "application"));
  fs.writeFileSync(path.join(root, "application/factory.ts"), source);
  return root;
}

// What a run prints, in this process: the spawned runs below prove the flag reaches this function.
function print(root: string, json: boolean): string {
  const out: string[] = [];
  runHexagon(root, {
    json,
    pretty: false,
    emit: (text) => out.push(text),
    report: (error) => {
      throw new Error(error);
    },
  });
  return out.join("");
}

const inside = (group: string): string[] =>
  fs.readdirSync(path.join(fixtures, group)).map((name) => `${group}/${name}`);

// A feature whose main list is written with `&`, `extends` or an alias, one with no factory, and one
// whose main list is still not read.
const PORT_LIST_FIXTURES = [
  ...inside("composed"),
  "stock-keeping",
  "two-candidates",
  ...inside("unread"),
];

describe("--hexagon over composed and unread port lists", () => {
  it.each(PORT_LIST_FIXTURES)("prints %s as its expected files hold it, run twice", (name) => {
    const root = path.join(fixtures, name);
    for (const [extension, json] of [
      ["txt", false],
      ["json", true],
    ] as const) {
      const expected = fs.readFileSync(path.join(root, `expected.${extension}`), "utf8");
      expect(print(root, json)).toBe(expected);
      expect(print(root, json)).toBe(expected);
    }
  });

  it("names a feature with no factory by its pair, and none when two pairs could be it", () => {
    const stock = JSON.parse(print(path.join(fixtures, "stock-keeping"), true));
    expect(stock.feature).toBe("Stock");
    expect(stock.commands.map((member: { name: string }) => member.name)).toEqual([
      "count",
      "restock",
    ]);
    const unread = JSON.parse(print(path.join(fixtures, "unread/warehousing"), true));
    expect(unread.feature).toBe("Warehousing");
    expect(unread.commands.notRead.reason).toBe("union type");
    const two = JSON.parse(print(path.join(fixtures, "two-candidates"), true));
    expect(two.feature).toBeNull();
    expect(two.otherBags.map((bag: { name: string }) => bag.name)).toEqual([
      "Books",
      "BooksDriven",
      "Films",
      "FilmsDriven",
    ]);
  });

  it.each(
    inside("unread"),
  )("%s: a list not read is the Not read row, never an empty list", (name) => {
    const report = JSON.parse(print(path.join(fixtures, name), true));
    const lists = [report.commands, report.externalSystems];
    const unread = lists.filter((list) => !Array.isArray(list));
    expect(unread.length).toBeGreaterThan(0);
    for (const list of unread) expect(report.notRead).toContainEqual(list.notRead);
  });
});

describe("--hexagon", () => {
  it.each(["full", "unbagged", "not-read"])("prints %s deterministically", (name) => {
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
    ["export function createWarehouse() {}", "Warehouse"],
    ["export const createWarehouse = () => ({})", "Warehouse"],
    ["export const createWarehouse = function createInternal() {}", "Warehouse"],
    ["export const helper = function createWarehouse() {}", null],
    ["function createWarehouse() {} export { createWarehouse }", null],
    ["function local() {} export { local as createWarehouse }", null],
    ["export { createWarehouse } from 'outside'", null],
    ["export * as createWarehouse from 'outside'", null],
    ["export namespace Scope { export function createWarehouse() {} }", null],
    ["export default function createWarehouse() {}", null],
    ["export let createWarehouse = () => ({})", null],
  ])("with two features in ports.ts, only a direct factory export names one: %s", (source, expected) => {
    const result = run(feature(source), "--json");
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.feature).toBe(expected);
    if (expected === null)
      expect(report.otherBags.map((bag: { name: string }) => bag.name)).toContain("Warehouse");
  });

  it.each([[], ["--json"]])("names missing ports.ts with no output (%j)", (...flags) => {
    const root = path.join(fixtures, "missing");
    const result = run(root, ...flags);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`code-graph: missing ports.ts: ${path.join(root, "ports.ts")}\n`);
  });

  it.each(["ports.ts", "application/factory.ts"])("lists invalid %s", (file) => {
    const root = feature("");
    fs.writeFileSync(path.join(root, file), "export type Broken =");
    const result = run(root, "--json");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).notRead).toEqual([
      { file, line: 1, name: "<source>", reason: "cannot parse source" },
    ]);
  });

  it("fails on an unreadable application directory", () => {
    const root = feature("");
    fs.rmSync(path.join(root, "application"), { recursive: true });
    fs.writeFileSync(path.join(root, "application"), "");
    const result = run(root);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      `code-graph: cannot read directory: ${path.join(root, "application")}\n`,
    );
  });

  it("writes pretty JSON through --out, with no stdout document", () => {
    const destination = path.join(temporary, "hexagon.json");
    const root = path.join(fixtures, "not-read");
    const expected = JSON.parse(fs.readFileSync(path.join(root, "expected.json"), "utf8"));
    const text = `${JSON.stringify(expected, null, 2)}\n`;
    const result = run(root, "--json", "--pretty", "--out", destination);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(fs.readFileSync(destination, "utf8")).toBe(text);
    expect(result.stderr).toBe(
      `code-graph: wrote ${Buffer.byteLength(text)} bytes to ${destination}\n`,
    );
  });
});
