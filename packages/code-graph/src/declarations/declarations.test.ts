import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assembleGraph, assembleGraphWithEdges } from "../extract/assemble.js";
import { loadCheapProject, loadEdgeProject } from "../extract/project.js";
import { type DeclarationNode, type Graph, ThresholdsSchema } from "../schema.js";
import { findByName, renderFind } from "./find.js";

const DECLARED = `export type Alias = { a: number };
type LocalAlias = string;
export interface Shape { x: number }
interface LocalShape { y: number }
export enum Color { Red }
enum LocalColor { Blue }
export const enum Dir { Up }
const enum LocalDir { Down }
export class Base {}
class LocalClass {}
export abstract class Abstract {}
abstract class LocalAbstract {}
export const LIMIT = 3;
const local = 4;
export const arrow = () => 1;
const fnExpr = function () { return 2; };
let notConst = 1;
const { a, b } = { a: 1, b: 2 };
class Later {}
export { Later };
interface Twice { a: number }
interface Twice { b: number }
interface Merged { m: number }
const Merged = 1;
`;

const DEFAULT_CLASS = "export default class Widget {}\n";

const CONSUMER = `import { Base as Renamed, type Shape, LIMIT, Color } from "./declared";
import Widget from "./widget";
export { Alias } from "./declared";
export class Child extends Renamed implements Shape { x = 1; }
export const made = new Renamed();
export let typed: Shape | undefined;
export const value = LIMIT + 1;
export type Palette = typeof Color;
export const widget = new Widget();
export function shadow(): number { const LIMIT = 9; return LIMIT; }
export const bag = { LIMIT };
`;

const FILES: Record<string, string> = {
  "declared.ts": DECLARED,
  "widget.ts": DEFAULT_CLASS,
  "consumer.ts": CONSUMER,
  "anonymous.ts": "export default class {}\n",
};

function lineOf(source: string, marker: string): number {
  const index = source.indexOf(marker);
  if (index < 0) throw new Error(`marker not found: ${marker}`);
  return source.slice(0, index).split("\n").length;
}

let root = "";
let edges: Graph;
let cheap: Graph;

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-decls-")));
  fs.writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, module: "ESNext", target: "ES2022" } }),
  );
  for (const [file, source] of Object.entries(FILES)) {
    fs.writeFileSync(path.join(root, file), source);
  }
  const thresholds = ThresholdsSchema.parse({});
  const loaded = loadEdgeProject(root, "package", root);
  edges = assembleGraphWithEdges(loaded, thresholds, "package", loaded.tsConfigPath);
  cheap = assembleGraph(loadCheapProject(root), thresholds);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function node(graph: Graph, id: string): DeclarationNode {
  const found = graph.declarations.find((d) => d.id === id);
  if (found === undefined) throw new Error(`no declaration ${id}`);
  return found;
}

function usesIn(id: string, file: string): number[] {
  return (node(edges, id).uses ?? []).filter((u) => u.file === file).map((u) => u.line);
}

describe("declaration nodes — one per top-level declaration, by kind (SPEC §6 A1)", () => {
  it.each([
    ["Alias", "type-alias", true],
    ["LocalAlias", "type-alias", false],
    ["Shape", "interface", true],
    ["LocalShape", "interface", false],
    ["Color", "enum", true],
    ["LocalColor", "enum", false],
    ["Dir", "enum", true],
    ["LocalDir", "enum", false],
    ["Base", "class", true],
    ["LocalClass", "class", false],
    ["Abstract", "class", true],
    ["LocalAbstract", "class", false],
    ["LIMIT", "constant", true],
    ["local", "constant", false],
    ["Later", "class", true],
  ] as const)("%s is one %s node, exported: %s", (name, kind, exported) => {
    const nodes = edges.declarations.filter((d) => d.file === "declared.ts" && d.name === name);
    expect(nodes.map((d) => [d.kind, d.isExported])).toEqual([[kind, exported]]);
    expect(nodes[0]?.line).toBe(lineOf(DECLARED, `${name} `));
  });

  it("a default-export class is one exported class node under its own name", () => {
    expect(edges.declarations.filter((d) => d.file === "widget.ts")).toMatchObject([
      { id: "widget.ts:class:Widget", kind: "class", isExported: true, line: 1 },
    ]);
    expect(edges.declarations.filter((d) => d.file === "anonymous.ts")).toMatchObject([
      { id: "anonymous.ts:class:default", isExported: true, uses: [] },
    ]);
  });

  it("a const bound to an arrow or a function expression stays one function node", () => {
    const names = edges.declarations.map((d) => d.name);
    expect(names).not.toContain("arrow");
    expect(names).not.toContain("fnExpr");
    expect(edges.functions.filter((f) => f.name === "arrow").map((f) => f.kind)).toEqual(["arrow"]);
  });

  it("let, var and destructured bindings get no node", () => {
    const names = edges.declarations.map((d) => d.name);
    for (const name of ["notConst", "a", "b"]) expect(names).not.toContain(name);
  });

  it("merged declarations keep one node each, with ids that never collide", () => {
    expect(edges.declarations.filter((d) => d.name === "Twice").map((d) => d.id)).toEqual([
      "declared.ts:interface:Twice#0",
      "declared.ts:interface:Twice#1",
    ]);
    expect(edges.declarations.filter((d) => d.name === "Merged").map((d) => d.id)).toEqual([
      "declared.ts:interface:Merged",
      "declared.ts:constant:Merged",
    ]);
    const ids = [...edges.declarations, ...edges.functions].map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("declaration uses — resolved by the type checker (SPEC §8 C6)", () => {
  it("finds a class through a renamed import, `new` and `extends`", () => {
    expect(usesIn("declared.ts:class:Base", "consumer.ts")).toEqual([
      lineOf(CONSUMER, "import { Base"),
      lineOf(CONSUMER, "export class Child"),
      lineOf(CONSUMER, "export const made"),
    ]);
  });

  it("finds an interface through `implements` and a type position", () => {
    expect(usesIn("declared.ts:interface:Shape", "consumer.ts")).toEqual([
      lineOf(CONSUMER, "import { Base"),
      lineOf(CONSUMER, "export class Child"),
      lineOf(CONSUMER, "export let typed"),
    ]);
  });

  it("finds a type alias through a re-export", () => {
    expect(usesIn("declared.ts:type-alias:Alias", "consumer.ts")).toEqual([
      lineOf(CONSUMER, "export { Alias }"),
    ]);
  });

  it("finds an enum through `typeof`", () => {
    expect(usesIn("declared.ts:enum:Color", "consumer.ts")).toContain(
      lineOf(CONSUMER, "export type Palette"),
    );
  });

  it("finds a constant in a value position and a shorthand property, not a same-named local", () => {
    expect(usesIn("declared.ts:constant:LIMIT", "consumer.ts")).toEqual([
      lineOf(CONSUMER, "import { Base"),
      lineOf(CONSUMER, "export const value"),
      lineOf(CONSUMER, "export const bag"),
    ]);
  });

  it("finds a default-export class through its default import", () => {
    expect(usesIn("widget.ts:class:Widget", "consumer.ts")).toEqual([
      lineOf(CONSUMER, "import Widget"),
      lineOf(CONSUMER, "export const widget"),
    ]);
  });

  it("a declaration's own name is not a use of it", () => {
    expect(usesIn("declared.ts:class:LocalClass", "declared.ts")).toEqual([]);
    expect(usesIn("declared.ts:class:Later", "declared.ts")).toEqual([
      lineOf(DECLARED, "export { Later }"),
    ]);
  });
});

describe("declaration uses without the edge pass", () => {
  it("are null on every node, never an empty list", () => {
    expect(cheap.declarations.length).toBe(edges.declarations.length);
    expect(cheap.declarations.every((d) => d.uses === null)).toBe(true);
  });
});

describe("--find — every node of a bare name, as data", () => {
  it("lists a function and a declaration of one name side by side", () => {
    expect(findByName(edges, "Merged").map((m) => m.kind)).toEqual(["interface", "constant"]);
    expect(findByName(edges, "arrow")).toMatchObject([{ kind: "arrow", isExported: true }]);
  });

  it("answers with an empty list and exit 0 when nothing matches", () => {
    const result = renderFind(edges, "Nothing", false);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout ?? "")).toEqual({
      name: "Nothing",
      scope: "package",
      matches: [],
    });
  });

  it("refuses a graph without the edge pass", () => {
    expect(renderFind(cheap, "LIMIT", false).exitCode).toBe(2);
  });
});
