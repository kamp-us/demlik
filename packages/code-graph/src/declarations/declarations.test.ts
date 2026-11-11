import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assembleGraph, assembleGraphWithEdges } from "../extract/assemble.js";
import { loadCheapProject, loadEdgeProject } from "../extract/project.js";
import {
  type DeclarationNode,
  type Graph,
  ThresholdsSchema,
  type UseSite,
  UseSiteSchema,
} from "../schema.js";
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

const KINDS = `import { Base, Color, LIMIT, type Shape, arrow } from "./declared";
import * as D from "./declared";
import Lim = D.LIMIT;
export { LIMIT as Limit } from "./declared";
export type OnlyType = typeof LIMIT;
export const both: typeof LIMIT = LIMIT;
export const text = LIMIT.toFixed(2) + LIMIT.toString();
export const red = Color.Red;
export const viaNamespace = D.LIMIT.toFixed(1);
export const mixed = LIMIT.valueOf() + LIMIT.Zeta + LIMIT.alpha + LIMIT.valueOf();
declare const unknownValue: unknown;
declare function mixin<T>(base: T): T;
export const cast = unknownValue as Shape;
export const checked = { x: 1 } satisfies Shape;
export const table = new Map<string, Shape>();
export const guard = (v: unknown): v is Shape => v !== null;
export const kindName = typeof LIMIT;
export const chained = LIMIT.toFixed(1).length;
export const optional = LIMIT?.toFixed;
export const wrapped = (LIMIT).toFixed(1) + LIMIT!.toPrecision(2) + (LIMIT as number).toExponential();
export const bracket = Color["Red"];
export const shorthand = { LIMIT };
export let picked: Color.Red;
export type RedType = typeof Color.Red;
export const Specialized = Base<string>;
export class Mixed extends mixin(Base) {}
export class Typed extends Array<Shape> {}
export class Dotted extends Color.Red {}
export class Sub extends Base {}
export class Impl implements Shape { x = 1; }
export interface Wider extends Shape { z: number }
export function useArrow(): number { return arrow(); }
export default LIMIT;
`;

const FILES: Record<string, string> = {
  "declared.ts": DECLARED,
  "widget.ts": DEFAULT_CLASS,
  "consumer.ts": CONSUMER,
  "kinds.ts": KINDS,
  "default-call.ts": 'import { LIMIT } from "./declared";\nexport default String(LIMIT);\n',
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

function siteAt(id: string, marker: string): UseSite | undefined {
  const line = lineOf(KINDS, marker);
  return (node(edges, id).uses ?? []).find((u) => u.file === "kinds.ts" && u.line === line);
}

describe("use sites say how the name is used there (SPEC §8 C6)", () => {
  const LIMIT_ID = "declared.ts:constant:LIMIT";

  it("an import specifier is an import", () => {
    expect(siteAt(LIMIT_ID, "import { Base")).toMatchObject({ kinds: ["import"], members: [] });
  });

  it("a default import and an `import x = …` are imports", () => {
    const widget = (node(edges, "widget.ts:class:Widget").uses ?? []).find(
      (u) => u.file === "consumer.ts" && u.line === lineOf(CONSUMER, "import Widget"),
    );
    expect(widget).toMatchObject({ kinds: ["import"], members: [] });
    expect(siteAt(LIMIT_ID, "import Lim")).toMatchObject({ kinds: ["import"], members: [] });
  });

  it("a re-export specifier and `export default X` are exports", () => {
    expect(siteAt(LIMIT_ID, "export { LIMIT")).toMatchObject({ kinds: ["export"], members: [] });
    expect(siteAt(LIMIT_ID, "export default")).toMatchObject({ kinds: ["export"], members: [] });
  });

  it("`typeof X` in a type is a type use", () => {
    expect(siteAt(LIMIT_ID, "export type OnlyType")).toMatchObject({
      kinds: ["type"],
      members: [],
    });
  });

  it("one line that uses the name as a type and as a value lists both kinds, sorted", () => {
    expect(siteAt(LIMIT_ID, "export const both")).toMatchObject({
      kinds: ["type", "value"],
      members: [],
    });
  });

  it("a value use names every member read off the name on that line, sorted", () => {
    expect(siteAt(LIMIT_ID, "export const text")).toMatchObject({
      kinds: ["value"],
      members: ["toFixed", "toString"],
    });
    expect(siteAt("declared.ts:enum:Color", "export const red")).toMatchObject({
      kinds: ["value"],
      members: ["Red"],
    });
  });

  it("a name reached through a namespace import keeps the member read off it", () => {
    expect(siteAt(LIMIT_ID, "export const viaNamespace")).toMatchObject({
      kinds: ["value"],
      members: ["toFixed"],
    });
  });

  it("members are listed once each, in code-unit order (capitals first)", () => {
    expect(siteAt(LIMIT_ID, "export const mixed")).toMatchObject({
      kinds: ["value"],
      members: ["Zeta", "alpha", "valueOf"],
    });
  });

  it("a class `extends` is a value use; `implements` and an interface `extends` are type uses", () => {
    expect(siteAt("declared.ts:class:Base", "export class Sub")).toMatchObject({
      kinds: ["value"],
    });
    expect(siteAt("declared.ts:interface:Shape", "export class Impl")).toMatchObject({
      kinds: ["type"],
    });
    expect(siteAt("declared.ts:interface:Shape", "export interface Wider")).toMatchObject({
      kinds: ["type"],
    });
  });

  it("the type of `as` and `satisfies`, a type argument and a type predicate are type uses", () => {
    const SHAPE_ID = "declared.ts:interface:Shape";
    for (const marker of ["cast", "checked", "table", "guard"]) {
      expect(siteAt(SHAPE_ID, `export const ${marker}`)).toMatchObject({ kinds: ["type"] });
    }
    expect(siteAt(SHAPE_ID, "export class Typed")).toMatchObject({ kinds: ["type"] });
  });

  it("the JavaScript `typeof x` operator and an instantiation expression are value uses", () => {
    expect(siteAt(LIMIT_ID, "export const kindName")).toMatchObject({ kinds: ["value"] });
    expect(siteAt("declared.ts:class:Base", "export const Specialized")).toMatchObject({
      kinds: ["value"],
      members: [],
    });
  });

  it("a class `extends` is a value use of a name inside a call", () => {
    expect(siteAt("declared.ts:class:Base", "export class Mixed")).toMatchObject({
      kinds: ["value"],
      members: [],
    });
  });

  it("only the first property of a chain is a member, optional chaining included", () => {
    expect(siteAt(LIMIT_ID, "export const chained")).toMatchObject({ members: ["toFixed"] });
    expect(siteAt(LIMIT_ID, "export const optional")).toMatchObject({ members: ["toFixed"] });
  });

  it("parentheses, `!` and `as` around the name do not hide the member read off it", () => {
    expect(siteAt(LIMIT_ID, "export const wrapped")).toMatchObject({
      kinds: ["value"],
      members: ["toExponential", "toFixed", "toPrecision"],
    });
  });

  it("an element access, a shorthand property and a qualified name list no member", () => {
    const COLOR_ID = "declared.ts:enum:Color";
    expect(siteAt(COLOR_ID, "export const bracket")).toMatchObject({
      kinds: ["value"],
      members: [],
    });
    expect(siteAt(LIMIT_ID, "export const shorthand")).toMatchObject({
      kinds: ["value"],
      members: [],
    });
    expect(siteAt(COLOR_ID, "export let picked")).toMatchObject({ kinds: ["type"], members: [] });
    expect(siteAt(COLOR_ID, "export type RedType")).toMatchObject({ kinds: ["type"], members: [] });
  });

  it("a dotted name in a heritage clause is a property access and lists its member", () => {
    expect(siteAt("declared.ts:enum:Color", "export class Dotted")).toMatchObject({
      kinds: ["value"],
      members: ["Red"],
    });
  });

  it("`export default` of an expression that only contains the name is a value use", () => {
    const line = 2;
    const site = (node(edges, LIMIT_ID).uses ?? []).find(
      (u) => u.file === "default-call.ts" && u.line === line,
    );
    expect(site).toMatchObject({ kinds: ["value"], members: [] });
  });

  it("a function's call sites from --find are value uses with no members", () => {
    const [match] = findByName(edges, "arrow");
    expect(match?.uses).toEqual([
      {
        file: "kinds.ts",
        line: lineOf(KINDS, "export function useArrow"),
        kinds: ["value"],
        members: [],
      },
    ]);
  });

  it("every use site of every declaration carries both fields", () => {
    const sites = edges.declarations.flatMap((d) => d.uses ?? []);
    expect(sites.length).toBeGreaterThan(0);
    for (const site of sites) expect(UseSiteSchema.safeParse(site).success).toBe(true);
    for (const site of sites) expect(site.kinds.length).toBeGreaterThan(0);
    expect(UseSiteSchema.safeParse({ file: "a.ts", line: 1 }).success).toBe(false);
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
