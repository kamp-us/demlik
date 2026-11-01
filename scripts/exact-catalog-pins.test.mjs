// Fails on a range in what this repo installs (#795, #814): every entry of every catalog except
// `peers` holds a full version, and the catalog names come from the file, so a new catalog is read
// from the day it is added. `fabrika guard catalog-guard check` proves a manifest uses a catalog
// and says nothing about what the entry holds. `catalogs.peers` stays ranges, since those are what
// users install against.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse, parseDocument } from "yaml";

const WORKSPACE = path.resolve(
  fileURLToPath(new URL("../pnpm-workspace.yaml", import.meta.url)),
);

const IDENTIFIERS = "[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*";
const EXACT = new RegExp(
  `^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(-${IDENTIFIERS})?(\\+${IDENTIFIERS})?$`,
);

const isExact = (value) => typeof value === "string" && EXACT.test(value);

const isMap = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFilledMap = (value) => isMap(value) && Object.keys(value).length > 0;

/**
 * Every catalog to read, as `[name, entries]`. `default` and `code-graph` are listed even when the
 * file lacks them, so losing one is reported rather than read as nothing to check.
 */
function catalogsToRead(workspace) {
  const named = isMap(workspace?.catalogs) ? workspace.catalogs : {};
  return [
    ["default", workspace?.catalog],
    ...Object.entries({ "code-graph": undefined, ...named }).filter(
      ([name]) => name !== "peers",
    ),
  ];
}

/**
 * One line per thing wrong in `source`, a pnpm-workspace.yaml's text. The failsafe schema keeps
 * every scalar as the text it was written as, so `1.20` is reported as `1.20` and not as a number.
 */
function pinOffenders(source) {
  const workspace = parse(source, { schema: "failsafe" });
  return catalogsToRead(workspace).flatMap(([name, catalog]) => {
    if (!isFilledMap(catalog)) return [`${name} catalog: missing or empty`];
    return Object.entries(catalog)
      .filter(([, value]) => !isExact(value))
      .map(
        ([dependency, value]) =>
          `${name} catalog: ${dependency} is ${JSON.stringify(value)}`,
      );
  });
}

const CLEAN_DEFAULT = "catalog:\n  typescript: 5.7.3\n";
const CLEAN_CODE_GRAPH = "catalogs:\n  code-graph:\n    tsup: 8.5.1\n";

const REAL_SOURCE = readFileSync(WORKSPACE, "utf8");

/** The real file's text with each `[catalog, dependency, value]` set, adding what is not there. */
function realSourceWith(edits) {
  const document = parseDocument(REAL_SOURCE, { schema: "failsafe" });
  for (const [catalog, dependency, value] of edits) {
    document.setIn(["catalogs", catalog, dependency], value);
  }
  return String(document);
}

describe("exact pins in every catalog except peers", () => {
  it.each([
    "^1.2.3",
    "~1.2.3",
    ">=1.2.3",
    "1.x",
    "1",
    "1.2",
    "*",
    "latest",
    "1.2.3 || 2.0.0",
    "1.2.3 - 2.0.0",
    "npm:foo@^1.2.3",
  ])("flags %s in either catalog, naming the catalog, package and value", (value) => {
    const quoted = JSON.stringify(value);
    expect(
      pinOffenders(
        `catalog:\n  left-pad: ${quoted}\ncatalogs:\n  code-graph:\n    left-pad: ${quoted}\n`,
      ),
    ).toEqual([
      `default catalog: left-pad is ${quoted}`,
      `code-graph catalog: left-pad is ${quoted}`,
    ]);
  });

  it("reports an unquoted number as it was written", () => {
    expect(
      pinOffenders(`catalog:\n  left-pad: 1.20\n${CLEAN_CODE_GRAPH}`),
    ).toEqual(['default catalog: left-pad is "1.20"']);
  });

  it.each([
    "1.2.3",
    "4.0.0-rc.117",
    "7.0.0-dev.20260707.2",
  ])("passes %s in either catalog", (value) => {
    expect(
      pinOffenders(
        `catalog:\n  left-pad: ${value}\ncatalogs:\n  code-graph:\n    left-pad: ${value}\n`,
      ),
    ).toEqual([]);
  });

  it.each([
    ["no default catalog", CLEAN_CODE_GRAPH, "default"],
    ["an empty default catalog", `catalog: {}\n${CLEAN_CODE_GRAPH}`, "default"],
    ["a blank default catalog", `catalog:\n${CLEAN_CODE_GRAPH}`, "default"],
    ["no catalogs key", CLEAN_DEFAULT, "code-graph"],
    [
      "a renamed code-graph catalog",
      `${CLEAN_DEFAULT}catalogs:\n  graph:\n    tsup: 8.5.1\n`,
      "code-graph",
    ],
    [
      "an empty code-graph catalog",
      `${CLEAN_DEFAULT}catalogs:\n  code-graph: {}\n`,
      "code-graph",
    ],
    [
      "a catalogs key that is not a map",
      `${CLEAN_DEFAULT}catalogs: ^1\n`,
      "code-graph",
    ],
    [
      "a new catalog with no entries",
      `${CLEAN_DEFAULT}${CLEAN_CODE_GRAPH}  tools: {}\n`,
      "tools",
    ],
  ])("fails on %s", (_, source, catalog) => {
    expect(pinOffenders(source)).toEqual([
      `${catalog} catalog: missing or empty`,
    ]);
  });

  it("skips a range in catalogs.peers and passes a new exact catalog", () => {
    expect(
      pinOffenders(
        `${CLEAN_DEFAULT}${CLEAN_CODE_GRAPH}  peers:\n    react: ^18 || ^19\n  tools:\n    left-pad: 1.3.0\n`,
      ),
    ).toEqual([]);
  });

  it("holds for the real pnpm-workspace.yaml", () => {
    expect(pinOffenders(REAL_SOURCE)).toEqual([]);
  });

  it.each([
    [
      "a new catalog holding a range",
      [["tools", "left-pad", "^1.3.0"]],
      ['tools catalog: left-pad is "^1.3.0"'],
    ],
    [
      "two new catalogs, both reported in one run",
      [
        ["tools", "left-pad", "^1.3.0"],
        ["build", "is-odd", "~3.0.1"],
      ],
      [
        'tools catalog: left-pad is "^1.3.0"',
        'build catalog: is-odd is "~3.0.1"',
      ],
    ],
    [
      "a catalog whose name only starts with peers",
      [["peers-dev", "left-pad", "^1.3.0"]],
      ['peers-dev catalog: left-pad is "^1.3.0"'],
    ],
    [
      "a range in an existing react-* catalog",
      [["react-18.2.0", "react", "^18"]],
      ['react-18.2.0 catalog: react is "^18"'],
    ],
  ])("flags %s when added to the real file", (_, edits, offenders) => {
    expect(pinOffenders(realSourceWith(edits))).toEqual(offenders);
  });

  it.each([
    ["a new catalog of exact versions", [["tools", "left-pad", "1.3.0"]]],
    ["another range in catalogs.peers", [["peers", "left-pad", "^1.3.0"]]],
  ])("passes %s when added to the real file", (_, edits) => {
    expect(pinOffenders(realSourceWith(edits))).toEqual([]);
  });
});
