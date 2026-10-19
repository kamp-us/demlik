import { describe, expect, it } from "vitest";
import { sourceUnit } from "../test-helpers/source-unit.js";
import { importedNamesOf, importLiterals, runtimeSpecifiers } from "./imports.js";

const literalsOf = (source: string) =>
  importLiterals(sourceUnit(source).syntax).map((l) => [
    l.specifier,
    l.kind,
    l.typeOnly,
    l.runtime,
  ]);

// `typeOnly` is what the graph's `ImportEdge.typeOnly` has always said, and is frozen with the
// graph JSON; `runtime` is the separate answer to "does the file open this module when it runs".
describe("an import literal says what the graph says and whether the file runs the module", () => {
  const CASES: readonly (readonly [string, readonly (string | boolean)[]])[] = [
    ['import type { Stats } from "m";', ["m", "static", true, false]],
    ['import type Stats from "m";', ["m", "static", true, false]],
    ['import { type Stats } from "m";', ["m", "static", false, false]],
    ['import { type Stats, type Dirent } from "m";', ["m", "static", false, false]],
    ['import { type Stats, read } from "m";', ["m", "static", false, true]],
    ['import m, { type Stats } from "m";', ["m", "static", false, true]],
    ['import {} from "m";', ["m", "static", false, true]],
    ['import "m";', ["m", "static", false, true]],
    ['import m from "m";', ["m", "static", false, true]],
    ['import * as m from "m";', ["m", "static", false, true]],
    ['export type { Stats } from "m";', ["m", "export-from", true, false]],
    ['export type * from "m";', ["m", "export-from", true, false]],
    ['export { type Stats } from "m";', ["m", "export-from", false, false]],
    ['export { type Stats, read } from "m";', ["m", "export-from", false, true]],
    ['export {} from "m";', ["m", "export-from", false, true]],
    ['export * from "m";', ["m", "export-from", false, true]],
    ['export * as m from "m";', ["m", "export-from", false, true]],
    ['import type m = require("m");', ["m", "static", false, false]],
    ['import m = require("m");', ["m", "static", false, true]],
    ['type S = import("m").Stats;', ["m", "static", false, false]],
    ['type T = typeof import("m");', ["m", "static", false, false]],
    ['type R = Awaited<ReturnType<typeof import("m").read>>;', ["m", "static", false, false]],
    ['const m = await import("m");', ["m", "dynamic", false, true]],
    ['declare module "x" { import m from "m"; }', ["m", "static", false, false]],
  ];

  for (const [source, literal] of CASES) {
    it(source, () => expect(literalsOf(source)).toEqual([literal]));
  }
});

describe("the specifiers a file runs", () => {
  const runs = (source: string) => [...runtimeSpecifiers(sourceUnit(source).syntax)];

  it("is none for a file that only names types, in any spelling", () => {
    const types = [
      'import { type Stats } from "node:fs";',
      'export { type Stats } from "node:fs";',
      'import type fs = require("node:fs");',
      'export type S = import("node:fs").Stats;',
    ];
    for (const source of types) expect(runs(source), source).toEqual([]);
  });

  it("is the specifier as soon as one literal of it survives emit", () => {
    const source = 'import { type Stats } from "node:fs";\nimport fs from "node:fs";\n';
    expect(runs(source)).toEqual(["node:fs"]);
  });
});

describe("the names a file takes from each specifier", () => {
  const takes = (source: string) =>
    [...importedNamesOf(sourceUnit(source).syntax)].map(([specifier, imported]) => [
      specifier,
      [...imported.names].sort(),
      imported.unreadable,
    ]);

  const READABLE: readonly (readonly [string, readonly string[]])[] = [
    ['import { A } from "m";', ["A"]],
    ['import { A as B } from "m";', ["A"]],
    ['import { type A } from "m";', ["A"]],
    ['import type { A } from "m";', ["A"]],
    ['import { A, B as C, type D } from "m";', ["A", "B", "D"]],
    ['import { "a-b" as A } from "m";', ["a-b"]],
    ['export { A } from "m";', ["A"]],
    ['export { A as B } from "m";', ["A"]],
    ['export { type A } from "m";', ["A"]],
    ['export type { A } from "m";', ["A"]],
    ['declare module "x" { import { A } from "m"; }', ["A"]],
  ];
  for (const [source, names] of READABLE) {
    it(source, () => expect(takes(source)).toEqual([["m", names, false]]));
  }

  const UNREADABLE: readonly (readonly [string, readonly string[]])[] = [
    ['import m from "m";', []],
    ['import m, { A } from "m";', ["A"]],
    ['import * as m from "m";', []],
    ['import m, * as n from "m";', []],
    ['export * from "m";', []],
    ['export * as m from "m";', []],
    ['export type * from "m";', []],
    ['import "m";', []],
    ['import {} from "m";', []],
    ['export {} from "m";', []],
    ['import m = require("m");', []],
    ['const m = await import("m");', []],
    ['type T = import("m").A;', []],
  ];
  for (const [source, names] of UNREADABLE) {
    it(`${source} takes a name no one can read`, () =>
      expect(takes(source)).toEqual([["m", names, true]]));
  }

  it("sums every declaration of one specifier, and keeps the specifiers apart", () => {
    const source = [
      'import { A } from "m";',
      'import type { B } from "m";',
      'export { C } from "m";',
      'import { D } from "m/sub";',
      "export const local = 1;",
      "export { local as renamed };",
    ].join("\n");
    expect(takes(source)).toEqual([
      ["m", ["A", "B", "C"], false],
      ["m/sub", ["D"], false],
    ]);
    expect(takes(`${source}\nimport * as ns from "m";`)).toContainEqual([
      "m",
      ["A", "B", "C"],
      true,
    ]);
  });
});
