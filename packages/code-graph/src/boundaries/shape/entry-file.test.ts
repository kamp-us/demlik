import { afterEach, describe, expect, it } from "vitest";
import { API, apiRepo, at } from "../../test-helpers/api-repo.js";
import type { BoundaryRepo } from "../../test-helpers/boundary-repo.js";
import { crossingsOf, ledgerOf } from "../../test-helpers/library-report.js";
import { shopManifests } from "../../test-helpers/shop-workspace.js";
import { sourceUnit } from "../../test-helpers/source-unit.js";
import { firstOffendingForm } from "./entry-file.js";

const formOf = (source: string): string | null => firstOffendingForm(sourceUnit(source).syntax);

describe("what keeps an entry file from being named re-exports", () => {
  it.each([
    ['export { a } from "./a";'],
    ['export type { A } from "./a";'],
    ['export { type A, b } from "./a";'],
    ['export { a as b } from "./a";'],
    ['export { default as c } from "./a";'],
    ['export { a } from "./a";\nexport type { B } from "./b";'],
    ["// only a comment\n"],
    [""],
  ])("takes %j as named re-exports", (source) => {
    expect(formOf(source)).toBeNull();
  });

  // One case per label of the table, and the forms that fall under it.
  it.each([
    ["export *", 'export * from "./a";'],
    ["export *", 'export * as ns from "./a";'],
    ["export *", 'export type * from "./a";'],
    ["export default", "export default {};"],
    ["export default", "export default function f() {}"],
    ["local export", "export { a };"],
    ["local export", "export type { A };"],
    ["import", 'import { a } from "./a";'],
    ["import", 'import type { A } from "./a";'],
    ["declaration", "export const a = 1;"],
    ["declaration", "export function f() {}"],
    ["declaration", "export class C {}"],
    ["declaration", "export type A = string;"],
    ["declaration", "export interface I {}"],
    ["declaration", "export enum E { A }"],
    ["declaration", "const a = 1;"],
    ["declaration", "function f() {}"],
    ["declaration", "type A = string;"],
    ["statement", "run();"],
    ["statement", '"use strict";'],
    ["statement", 'export {} from "./a";'],
    ["statement", "export = a;"],
    ["statement", "namespace N {}"],
  ])("labels the first offending form %j for %j", (label, source) => {
    expect(formOf(source)).toBe(label);
  });

  it("names the first offending form in source order, not the worst", () => {
    expect(formOf('export { a } from "./a";\nexport default {};\nexport const b = 1;')).toBe(
      "export default",
    );
    expect(formOf('export const b = 1;\nexport * from "./a";')).toBe("declaration");
  });
});

describe("B15 judges an entry file of a declared library and of a hexagonal feature", () => {
  let repo: BoundaryRepo | null = null;
  afterEach(() => repo?.dispose());

  const RULES = { applicationShape: ["index-not-exports-only"] };
  const REEXPORT = 'export { a } from "./application/a";\n';
  const files = (entries: Record<string, string>) => ({
    "src/billing/application/a.ts": "export const a = 1;\n",
    "src/billing/index.ts": REEXPORT,
    "src/orders/index.ts": REEXPORT,
    ...entries,
  });
  // The B15 entries of a `--json` run, whatever else it lists.
  const crossings = (run: BoundaryRepo) =>
    crossingsOf(run.run({ json: true })).filter(([kind]) => kind === "index-not-exports-only");

  it("is clean on named re-exports, and on an empty file", () => {
    repo = apiRepo(files({ "src/orders/index.ts": "" }), RULES);
    expect(crossings(repo)).toEqual([]);
  });

  it.each([
    ["export *", 'export * from "./a";\n'],
    ["export default", "export default {};\n"],
    ["local export", "export { a };\n"],
    ["import", 'import { a } from "./a";\n'],
    ["declaration", "export const a = 1;\n"],
    ["statement", "run();\n"],
  ])("reports %j as one entry per file, specifier the form", (form, body) => {
    repo = apiRepo(files({ "src/billing/index.ts": `${REEXPORT}${body}${body}` }), RULES);
    expect(crossings(repo)).toEqual([["index-not-exports-only", at("src/billing/index.ts"), form]]);
    expect(repo.run({ acceptCrossings: true, reason: "r" }).code).toBe(0);
    expect(ledgerOf(repo).entries).toEqual([
      {
        scope: API,
        kind: "index-not-exports-only",
        from: at("src/billing/index.ts"),
        to: null,
        specifier: form,
        reason: "r",
      },
    ]);
  });

  it("judges a declared library's src/index.ts, in the library's own scope", () => {
    const libraries = {
      libraryTypes: { util: { imports: ["util"], pure: true } },
      libraries: { "packages/util": "util" },
    };
    repo = apiRepo(
      files({}),
      { ...RULES, ...libraries },
      {
        ...shopManifests(["packages/util"]),
        "packages/util/src/index.ts": "export const x = 1;\n",
        "packages/util/src/schema/index.ts": "export const schema = 1;\n",
        "packages/util/src/util.ts": "export const util = 1;\n",
      },
    );
    const run = repo.run({ json: true });
    const scopes = JSON.parse(run.stdout).scopes as { scope: string; violations: unknown[] }[];
    expect(Object.fromEntries(scopes.map((s) => [s.scope, s.violations.length]))).toEqual({
      [API]: 0,
      "packages/util": 1,
    });
    expect(crossings(repo)).toEqual([
      ["index-not-exports-only", "packages/util/src/index.ts", "declaration"],
    ]);
  });

  it("judges neither an inner barrel, a file not named index.ts, nor a rules-layout feature", () => {
    repo = apiRepo(
      files({
        "src/orders/application/index.ts": "export const x = 1;\n",
        "src/orders/barrel.ts": "export const y = 1;\n",
        "src/billing/index.tsx": "export const z = 1;\n",
      }),
      RULES,
    );
    expect(crossings(repo)).toEqual([]);
    const rules = { ...RULES, layout: { [API]: "rules" } };
    repo.dispose();
    repo = apiRepo(files({ "src/orders/index.ts": "export const x = 1;\n" }), rules);
    expect(crossings(repo)).toEqual([]);
  });

  it("judges nothing while the kind is not listed", () => {
    const body = files({ "src/orders/index.ts": "export const x = 1;\n" });
    for (const rules of [
      {},
      { applicationShape: [] },
      { applicationShape: ["application-import-outside-allowlist"] },
    ]) {
      repo?.dispose();
      repo = apiRepo(body, rules);
      expect(crossings(repo)).toEqual([]);
    }
  });

  it("makes a file that fixes its first form and keeps another a new entry, and prunes the old", () => {
    repo = apiRepo(
      files({ "src/orders/index.ts": 'export * from "./a";\nexport const x = 1;\n' }),
      RULES,
    );
    expect(repo.run({ acceptCrossings: true, reason: "legacy" }).code).toBe(0);
    repo.put(at("src/orders/index.ts"), "export const x = 1;\n");
    const failed = repo.run({ ci: true });
    expect(failed.code).toBe(1);
    expect(failed.stdout).toContain(`${at("src/orders/index.ts")} -> declaration`);
    expect(failed.stdout).toContain("pruned 1 boundary-ledger.json entry");
    expect(failed.stdout).toContain(`${at("src/orders/index.ts")} -> export *`);
  });
});
