// Fails on a range in what this repo installs (#795): every entry of the default and `code-graph`
// catalogs holds a full version. `fabrika guard catalog-guard check` proves a manifest uses a
// catalog and says nothing about what the entry holds. `catalogs.peers` stays ranges, since those
// are what users install against, and the `react-*` catalogs are not read.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKSPACE = path.resolve(
  fileURLToPath(new URL("../pnpm-workspace.yaml", import.meta.url)),
);

const IDENTIFIERS = "[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*";
const EXACT = new RegExp(
  `^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(-${IDENTIFIERS})?(\\+${IDENTIFIERS})?$`,
);

const PINNED_CATALOGS = [
  ["default", (workspace) => workspace?.catalog],
  ["code-graph", (workspace) => workspace?.catalogs?.["code-graph"]],
];

const isExact = (value) => typeof value === "string" && EXACT.test(value);

const isFilledMap = (value) =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).length > 0;

/**
 * One line per thing wrong in `source`, a pnpm-workspace.yaml's text. The failsafe schema keeps
 * every scalar as the text it was written as, so `1.20` is reported as `1.20` and not as a number.
 */
function pinOffenders(source) {
  const workspace = parse(source, { schema: "failsafe" });
  return PINNED_CATALOGS.flatMap(([name, read]) => {
    const catalog = read(workspace);
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

describe("exact pins in the default and code-graph catalogs", () => {
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
  ])("fails on %s", (_, source, catalog) => {
    expect(pinOffenders(source)).toEqual([
      `${catalog} catalog: missing or empty`,
    ]);
  });

  it("does not read a range in catalogs.peers or a react-* catalog", () => {
    expect(
      pinOffenders(
        `${CLEAN_DEFAULT}catalogs:\n  code-graph:\n    tsup: 8.5.1\n  peers:\n    react: ^18 || ^19\n  react-18.2.0:\n    react: ^18\n`,
      ),
    ).toEqual([]);
  });

  it("holds for the real pnpm-workspace.yaml", () => {
    expect(pinOffenders(readFileSync(WORKSPACE, "utf8"))).toEqual([]);
  });
});
