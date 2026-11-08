import { describe, expect, it } from "vitest";
import { sourceUnit } from "../../test-helpers/source-unit.js";
import { type ExportEntry, exportEntriesOf } from "./exports.js";

const entriesOf = (...source: string[]): ExportEntry[] =>
  exportEntriesOf(sourceUnit(`${source.join("\n")}\n`).syntax);

// One row per way a module exports, with the entry ECMA-262 files it under (ParseModule, 16.2.1.7.1).
const FORMS: readonly (readonly [form: string, source: string[], entries: ExportEntry[]])[] = [
  [
    "export { t } from",
    ['export { t } from "m";'],
    [{ kind: "indirect", name: "t", source: "m", from: "t" }],
  ],
  [
    "export { t as u } from",
    ['export { t as u } from "m";'],
    [{ kind: "indirect", name: "u", source: "m", from: "t" }],
  ],
  ["export * from", ['export * from "m";'], [{ kind: "star", source: "m" }]],
  [
    "export * as ns from",
    ['export * as ns from "m";'],
    [{ kind: "namespace", name: "ns", source: "m" }],
  ],
  [
    "an imported binding, exported",
    ['import { t } from "m";', "export { t };"],
    [{ kind: "indirect", name: "t", source: "m", from: "t" }],
  ],
  [
    "an imported binding, exported under another name",
    ['import { t } from "m";', "export { t as u };"],
    [{ kind: "indirect", name: "u", source: "m", from: "t" }],
  ],
  [
    "an imported namespace, exported",
    ['import * as ns from "m";', "export { ns };"],
    [{ kind: "namespace", name: "ns", source: "m" }],
  ],
  [
    "an imported default, exported",
    ['import t from "m";', "export { t };"],
    [{ kind: "indirect", name: "t", source: "m", from: "default" }],
  ],
  [
    "export { default as t } from",
    ['export { default as t } from "m";'],
    [{ kind: "indirect", name: "t", source: "m", from: "default" }],
  ],
  [
    "a declaration",
    ["export const a = 1, { b, c: [d] } = e;", "export function f() {}", "export class G {}"],
    [
      { kind: "local", name: "a" },
      { kind: "local", name: "b" },
      { kind: "local", name: "d" },
      { kind: "local", name: "f" },
      { kind: "local", name: "G" },
    ],
  ],
  [
    "a local binding, exported",
    ["const t = 1;", "export { t, t as u };"],
    [
      { kind: "local", name: "t" },
      { kind: "local", name: "u" },
    ],
  ],
  ["export default", ["export default 1;"], [{ kind: "local", name: "default" }]],
  [
    "export import = require",
    ['export import ns = require("m");'],
    [{ kind: "namespace", name: "ns", source: "m" }],
  ],
  ["export =", ["const t = 1;", "export = t;"], [{ kind: "assignment" }]],
];

// A type leaves nothing at run time, so none of these is an entry.
const ERASED: readonly (readonly [form: string, source: string[]])[] = [
  ["export type { t } from", ['export type { t } from "m";']],
  ["export { type t } from", ['export { type t } from "m";']],
  ["export type * from", ['export type * from "m";']],
  ["export type * as ns from", ['export type * as ns from "m";']],
  ["export type { t }", ["const t = 1;", "export type { t };"]],
  ["export { type t }", ["const t = 1;", "export { type t };"]],
  ["an interface", ["export interface I {}"]],
  ["a type alias", ["export type T = string;"]],
  ["a type-only import, exported", ['import type { t } from "m";', "export { t };"]],
  ["an inline type-only import, exported", ['import { type t } from "m";', "export { t };"]],
  ["a type-only namespace, exported", ['import type * as ns from "m";', "export { ns };"]],
];

describe("a module's export table", () => {
  it.each(FORMS)("files %s under the entry ECMAScript gives it", (_form, source, entries) => {
    expect(entriesOf(...source)).toEqual(entries);
  });

  it.each(ERASED)("drops %s, which is erased at run time", (_form, source) => {
    expect(entriesOf(...source)).toEqual([]);
  });

  it("keeps the entries of a barrel in source order, mixing the forms", () => {
    expect(
      entriesOf(
        'import * as a from "./a";',
        'export { b } from "./b";',
        "export { a };",
        'export * from "./c";',
        "export const d = 1;",
      ),
    ).toEqual([
      { kind: "indirect", name: "b", source: "./b", from: "b" },
      { kind: "namespace", name: "a", source: "./a" },
      { kind: "star", source: "./c" },
      { kind: "local", name: "d" },
    ]);
  });
});
