import { afterEach, describe, expect, it } from "vitest";
import type { OwnersReport } from "../../owners/render.js";
import { type BoundaryRepo, boundaryRepo, type GateRun } from "../../test-helpers/boundary-repo.js";
import type { reportOf } from "../../test-helpers/library-report.js";
import type { TableCensus } from "./census.js";
import {
  API,
  CYCLE_WRITE,
  DIAMOND_WRITE,
  FEATURES,
  FOREIGN_KEYS,
  FORMS,
  OWNED,
  REEXPORT_FILES,
  RULES,
  SHIPPING_TABLES,
  STYLES,
  TWO_SPELLINGS,
  userFile,
} from "./reexport.fixture.js";
import {
  ALIASING,
  NEAR_MISSES,
  UNFOLLOWED_FILES,
  UNFOLLOWED_WRITES,
} from "./unfollowed.fixture.js";

const FILES = { ...REEXPORT_FILES, ...UNFOLLOWED_FILES, ...NEAR_MISSES };

let repos: BoundaryRepo[] = [];
const open = (files: Record<string, string> = FILES, rules: unknown = RULES): BoundaryRepo => {
  const repo = boundaryRepo(".", files, rules);
  repos.push(repo);
  return repo;
};
afterEach(() => {
  for (const repo of repos) repo.dispose();
  repos = [];
});

type Boundaries = ReturnType<typeof reportOf> & { readonly tables?: TableCensus };
const boundaries = (run: GateRun): Boundaries => JSON.parse(run.stdout);
const owners = (run: GateRun): OwnersReport => JSON.parse(run.stdout);

const byText = (a: string, b: string): number => a.localeCompare(b);

// B23's entries the barrels add: one per file per table, however many hops the name passed through.
const entry = (from: string, table: string, owner: string) => ({
  kind: "table-written-outside-owner",
  from,
  to: null,
  specifier: table,
  typeOnly: false,
  owner,
});

const EXPECTED_ENTRIES = [
  ...FORMS.flatMap((form) =>
    STYLES.map((style) => entry(userFile(form, style, "write"), form.table, form.owner)),
  ),
  entry(TWO_SPELLINGS, "orders", "orders"),
  entry(CYCLE_WRITE, "shipments", "shipping"),
  entry(DIAMOND_WRITE, "entries", "audit"),
].sort((a, b) => byText(a.from, b.from) || byText(a.specifier, b.specifier));

const FILES_SCANNED = Object.keys(FILES).filter((file) => file.endsWith(".ts")).length;

// Where a file sits, as the view prints it.
const driven = (feature: string) => ({ kind: "feature", feature, zone: "driven" });
const reach = (table: string, access: string, file: string, place: unknown) => ({
  table,
  access,
  file,
  place,
});

// Every row of the view for the fixture: the matrix of forms, the foreign keys, and the files beside
// them. A file that aliases a table in a variable still reads it.
function expectedReach(): Record<string, ReturnType<typeof reach>[]> {
  const rows: Record<string, ReturnType<typeof reach>[]> = Object.fromEntries(
    FEATURES.map((feature) => [feature, []]),
  );
  const put = (owner: string, row: ReturnType<typeof reach>) => rows[owner]?.push(row);
  for (const form of FORMS) {
    for (const style of STYLES) {
      for (const way of ["write", "read"] as const) {
        put(form.owner, reach(form.table, way, userFile(form, style, way), driven(form.user)));
      }
    }
  }
  const shipping = { kind: "feature", feature: "shipping", zone: "tables" };
  for (const form of FOREIGN_KEYS) {
    put(form.owner, reach(form.table, "foreign-key", SHIPPING_TABLES, shipping));
  }
  put("orders", reach("orders", "write", TWO_SPELLINGS, driven("billing")));
  put("shipping", reach("shipments", "write", CYCLE_WRITE, driven("audit")));
  put("audit", reach("entries", "write", DIAMOND_WRITE, driven("orders")));
  for (const file of ALIASING) put("orders", reach("orders", "read", file, driven("billing")));
  for (const list of Object.values(rows)) {
    list.sort((a, b) => byText(a.table, b.table) || byText(a.file, b.file));
  }
  return rows;
}

const EXPECTED_ROWS = Object.values(UNFOLLOWED_WRITES)
  .map(({ file, kind }) => ({ file, kind }))
  .sort((a, b) => byText(a.file, b.file));

const EXPECTED_CENSUS = {
  notFollowed: {
    "untraced-write": 2,
    "unloaded-module": 1,
    "default-export": 1,
    "ambiguous-star": 1,
    "export-equals": 1,
    "raw-sql": 1,
  },
  rows: EXPECTED_ROWS,
};

describe("a table reaches its users through a re-export", () => {
  it("lists a write through every form, in every style, as B23 entries and nothing else", () => {
    const report = boundaries(open().run({ json: true }));
    expect(report.scopes).toEqual([
      {
        scope: API,
        features: [...FEATURES].sort(byText),
        filesScanned: FILES_SCANNED,
        violations: EXPECTED_ENTRIES,
      },
    ]);
  });

  it("lists the same reach in the view: every form and style written and read, and the foreign keys", () => {
    const run = open().owners({ json: true });
    expect(run.code).toBe(0);
    const reachOf = expectedReach();
    expect(owners(run)).toEqual({
      scopes: [
        {
          scope: API,
          features: [...FEATURES].sort(byText).map((feature) => ({
            feature,
            tables: [...OWNED[feature]].sort(byText),
            reach: reachOf[feature],
            commands: [],
            externalSystems: [],
          })),
          workers: [],
          technologies: [],
          notFollowed: EXPECTED_ROWS,
        },
      ],
      notRead: [],
    });
  });

  it("keeps the view's writes and B23's entries one list", () => {
    const repo = open();
    const gate = boundaries(repo.run({ json: true }))
      .scopes.flatMap((scope) => scope.violations)
      .map((violation) => [
        violation.from,
        violation.specifier,
        "owner" in violation ? violation.owner : "",
      ])
      .sort();
    const written = owners(repo.owners({ json: true }))
      .scopes.flatMap((scope) => scope.features)
      .flatMap((owned) =>
        owned.reach
          .filter((row) => row.access === "write")
          .map((row) => [row.file, row.table, owned.feature]),
      )
      .sort();
    expect(gate).toHaveLength(EXPECTED_ENTRIES.length);
    expect(written).toEqual(gate);
  });

  it("prints the same bytes twice, for the gate and for the view", () => {
    const repo = open();
    for (const options of [{ json: true }, {}]) {
      expect(repo.run(options).stdout).toBe(repo.run(options).stdout);
      expect(repo.owners(options).stdout).toBe(repo.owners(options).stdout);
    }
  });

  it("follows nothing through a type-only re-export, an enum or a circle that defines no such name", () => {
    const touched = [
      "type-only.ts",
      "enum-read.ts",
      "cycle-ghost.ts",
      "own.ts",
      "schema-write.test.ts",
      "near-misses.ts",
    ];
    const files = new Set([
      ...boundaries(open().run({ json: true })).scopes.flatMap((s) =>
        s.violations.map((v) => v.from),
      ),
      ...owners(open().owners({ json: true })).scopes.flatMap((scope) =>
        scope.features.flatMap((owned) => owned.reach.map((row) => row.file)),
      ),
      ...EXPECTED_ROWS.map((row) => row.file),
    ]);
    for (const name of touched) {
      expect(
        Object.keys(FILES).some((file) => file.endsWith(name)),
        name,
      ).toBe(true);
      expect(
        [...files].some((file) => file.endsWith(name)),
        name,
      ).toBe(false);
    }
  });
});

describe("what is still not followed is counted and listed, never dropped", () => {
  it("adds one to the kind in the census and one row to the view, and the two counts are equal", () => {
    const repo = open();
    const census = boundaries(repo.run({ json: true })).tables;
    expect(census).toEqual(EXPECTED_CENSUS);
    const rows = owners(repo.owners({ json: true })).scopes.flatMap((scope) => scope.notFollowed);
    expect(rows).toEqual(census?.rows);
    expect(rows).toHaveLength(Object.values(census?.notFollowed ?? {}).reduce((a, b) => a + b, 0));
  });

  it("prints the census beside the violations and a Not followed block in the view", () => {
    const repo = open();
    const plain = repo.run().stdout.trimEnd().split("\n");
    const at = plain.findIndex((line) => line.startsWith("tables: "));
    expect(plain.slice(at)).toEqual([
      "tables: 7 not followed (untraced-write 2, unloaded-module 1, default-export 1, ambiguous-star 1, export-equals 1, raw-sql 1)",
      ...EXPECTED_ROWS.map(
        ({ file, kind }) => `  ${file}  ${kind}  ${LABELS[kind as keyof typeof LABELS]}`,
      ),
    ]);
    const view = repo.owners().stdout;
    expect(view).toContain(
      [
        "  Not followed",
        ...EXPECTED_ROWS.map(
          ({ file, kind }) => `    ${file}  ${kind}  ${LABELS[kind as keyof typeof LABELS]}`,
        ),
        "",
        "Not read",
      ].join("\n"),
    );
  });

  it("prints explicit zeros when a table kind is listed and nothing is unfollowed", () => {
    const quiet = Object.fromEntries(
      Object.entries(FILES).filter(
        ([file]) => !Object.values(UNFOLLOWED_WRITES).some((row) => row.file === file),
      ),
    );
    const repo = open(quiet);
    expect(boundaries(repo.run({ json: true })).tables).toEqual({
      notFollowed: Object.fromEntries(Object.keys(EXPECTED_CENSUS.notFollowed).map((k) => [k, 0])),
      rows: [],
    });
    expect(repo.run().stdout).toContain(
      "tables: 0 not followed (untraced-write 0, unloaded-module 0, default-export 0, ambiguous-star 0, export-equals 0, raw-sql 0)",
    );
    expect(repo.owners().stdout).toContain("  Not followed\n    none\n");
  });

  it("prints no census where the rules file lists no table kind", () => {
    const { tableOwnership: _listed, ...bare } = RULES;
    const repo = open(FILES, bare);
    expect(boundaries(repo.run({ json: true })).tables).toBeUndefined();
    expect(repo.run().stdout).not.toContain("tables:");
    expect(repo.run({ json: true }).stdout).not.toContain('"tables"');
  });
});

const LABELS = {
  "untraced-write": "write whose table is not an import",
  "unloaded-module": "write whose table comes from a module the run did not load",
  "default-export": "write whose table is a default export",
  "ambiguous-star": "write whose table two export * both supply",
  "export-equals": "write whose table comes through an export = module",
  "raw-sql": "raw SQL that writes",
};
