import { afterEach, describe, expect, it } from "vitest";
import type { OwnersReport } from "../../owners/render.js";
import { type BoundaryRepo, boundaryRepo } from "../../test-helpers/boundary-repo.js";
import { ledgerOf, ledgerText, reportOf } from "../../test-helpers/library-report.js";
import { shopManifests } from "../../test-helpers/shop-workspace.js";
import { ledgerTargetOf } from "../ledger.js";
import type { BoundaryViolation } from "../violation.js";

// A rules file that lists both `tableOwnership` and `interpreters` judges a file under an interpreter
// root for B22 and B23 exactly as it judges a file in no feature, and the interpreter key adds B25
// beside them. Nothing but `place.kind === "feature"` in `judgeTables` says so, so this fixture does:
// it is the one place a change that exempts a root from either table kind goes red.
//
// One scope, `services/api`, with four features that each own one table, a schema barrel in no
// feature that re-exports `billing`'s, and one `queue` root of six files:
//
//  - `clean.ts` imports only its SDK.
//  - `own-table.ts` calls `pgTable`.
//  - `direct.ts` imports `orders`' tables file and writes the table.
//  - `via-barrel.ts` writes `billing`'s table through the barrel, which is no feature's file.
//  - `reads.ts` imports `audit`'s tables file and only selects.
//  - `direct.test.ts` is `direct.ts` again, in a test file.

const API = "services/api";
const at = (rel: string): string => `${API}/${rel}`;
const lines = (...source: string[]): string => `${source.join("\n")}\n`;

const tablesOf = (table: string, name = table): string =>
  lines(
    'import { pgTable, text } from "drizzle-orm/pg-core";',
    `export const ${table} = pgTable("${name}", { id: text("id").primaryKey() });`,
  );

const ROOT = "src/interpreters/queue";
const inRoot = (file: string): string => at(`${ROOT}/${file}`);

const CLEAN = inRoot("clean.ts");
const OWN_TABLE = inRoot("own-table.ts");
const DIRECT = inRoot("direct.ts");
const VIA_BARREL = inRoot("via-barrel.ts");
const READS = inRoot("reads.ts");
const DIRECT_TEST = inRoot("direct.test.ts");

const ORDERS_TABLES = at("src/orders/adapters/driven/tables.ts");
const AUDIT_TABLES = at("src/audit/adapters/driven/tables.ts");

// How the root's files spell the tables files they import.
const TO_ORDERS = "../../orders/adapters/driven/tables";
const TO_AUDIT = "../../audit/adapters/driven/tables";

const writesOrders = lines(
  `import { orders } from "${TO_ORDERS}";`,
  "export const place = (db: Db) => db.insert(orders).values({});",
);

const FILES: Record<string, string> = {
  ...shopManifests([API]),
  [ORDERS_TABLES]: tablesOf("orders"),
  [at("src/billing/adapters/driven/tables.ts")]: tablesOf("invoices"),
  [at("src/shipping/adapters/driven/tables.ts")]: tablesOf("shipments"),
  [AUDIT_TABLES]: tablesOf("entries", "audit_entries"),
  [at("src/schema.ts")]: 'export { invoices } from "./billing/adapters/driven/tables";\n',
  [CLEAN]: lines('import { enqueue } from "queue-sdk";', "export const run = enqueue;"),
  [OWN_TABLE]: tablesOf("outbox"),
  [DIRECT]: writesOrders,
  [VIA_BARREL]: lines(
    'import { invoices } from "../../schema";',
    "export const forget = (db: Db) => db.delete(invoices);",
  ),
  [READS]: lines(
    `import { entries } from "${TO_AUDIT}";`,
    "export const list = (db: Db) => db.select().from(entries);",
  ),
  [DIRECT_TEST]: writesOrders,
};

const TABLE_KINDS = ["table-declared-outside-tables", "table-written-outside-owner"];
const RULES = {
  features: { [API]: ["orders", "billing", "shipping", "audit"] },
  tableOwnership: TABLE_KINDS,
  interpreters: { [API]: { queue: { root: ROOT, modules: ["queue-sdk"] } } },
  testFiles: ["**/*.test.ts"],
};
const { interpreters: _interpreters, ...WITHOUT_INTERPRETERS } = RULES;
const { tableOwnership: _tableOwnership, ...WITHOUT_TABLES } = RULES;

// The same two things done by files in no feature, for a root file's rows to be compared with.
const LOOSE_DECLARE = at("src/loose-declare.ts");
const LOOSE_WRITE = at("src/loose-write.ts");
const LOOSE: Record<string, string> = {
  [LOOSE_DECLARE]: tablesOf("stray"),
  [LOOSE_WRITE]: lines(
    'import { orders } from "./orders/adapters/driven/tables";',
    "export const place = (db: Db) => db.insert(orders).values({});",
  ),
};

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

const B22 = "table-declared-outside-tables";
const B23 = "table-written-outside-owner";
const B25 = "interpreter-imports-feature";
const CODE: Record<string, string> = { [B22]: "B22", [B23]: "B23", [B25]: "B25" };

const violationsOf = (run: BoundaryRepo): BoundaryViolation[] =>
  reportOf(run.run({ json: true })).scopes.flatMap((scope) => scope.violations);

// The codes of the rules each file draws, whatever order the report lists them in.
const codesByFile = (run: BoundaryRepo): Record<string, string[]> => {
  const rows = violationsOf(run);
  return Object.fromEntries(
    [...new Set(rows.map((row) => row.from))].map((file) => [
      file,
      rows
        .filter((row) => row.from === file)
        .map((row) => CODE[row.kind] ?? row.kind)
        .sort(),
    ]),
  );
};

const keysOf = (row: object): string[] => Object.keys(row).sort();

// The plain report, row by row. `scanned` counts the files, six of them in the root.
const HEADER = "services/api — features: audit, billing, orders, shipping";
const scanned = (violations: number): string[] => [
  HEADER,
  `  scanned 11 files — ${violations} violation(s)`,
];
const B25_ROWS = [
  `  B25 ${B25} ${DIRECT_TEST} -> ${ORDERS_TABLES}  ("${TO_ORDERS}")`,
  `  B25 ${B25} ${DIRECT} -> ${ORDERS_TABLES}  ("${TO_ORDERS}")`,
  `  B25 ${B25} ${READS} -> ${AUDIT_TABLES}  ("${TO_AUDIT}")`,
];
const B22_ROWS = [`  B22 ${B22} ${OWN_TABLE} -> pgTable`];
const B23_ROWS = [
  `  B23 ${B23} ${DIRECT} -> orders  [owner: orders]`,
  `  B23 ${B23} ${VIA_BARREL} -> invoices  [owner: billing]`,
];
const CENSUS =
  "tables: 0 not followed (untraced-write 0, unloaded-module 0, default-export 0, ambiguous-star 0, export-equals 0, raw-sql 0)";

// The same rows as `--json` lists them: the three B25, then B22, then the two B23.
const JSON_ROWS = [
  {
    kind: B25,
    from: DIRECT_TEST,
    to: ORDERS_TABLES,
    toFeature: "orders",
    specifier: TO_ORDERS,
    typeOnly: false,
  },
  {
    kind: B25,
    from: DIRECT,
    to: ORDERS_TABLES,
    toFeature: "orders",
    specifier: TO_ORDERS,
    typeOnly: false,
  },
  {
    kind: B25,
    from: READS,
    to: AUDIT_TABLES,
    toFeature: "audit",
    specifier: TO_AUDIT,
    typeOnly: false,
  },
  { kind: B22, from: OWN_TABLE, to: null, specifier: "pgTable", typeOnly: false },
  { kind: B23, from: DIRECT, to: null, specifier: "orders", owner: "orders", typeOnly: false },
  {
    kind: B23,
    from: VIA_BARREL,
    to: null,
    specifier: "invoices",
    owner: "billing",
    typeOnly: false,
  },
];
const NOT_FOLLOWED = {
  "untraced-write": 0,
  "unloaded-module": 0,
  "default-export": 0,
  "ambiguous-star": 0,
  "export-equals": 0,
  "raw-sql": 0,
};

const plainOf = (...rows: string[]): string => `${rows.join("\n")}\n`;

describe("a file under an interpreter root is a file in no feature for the table kinds", () => {
  it("earns B22 for a declaration, B23 for a write and B25 for the import of a tables file, each alone or together", () => {
    const run = open();
    expect(codesByFile(run)).toEqual({
      [OWN_TABLE]: ["B22"],
      [DIRECT]: ["B23", "B25"],
      [VIA_BARREL]: ["B23"],
      [READS]: ["B25"],
      [DIRECT_TEST]: ["B25"],
    });
    expect(codesByFile(run)[CLEAN]).toBeUndefined();
  });

  it("prints the whole report and the rows of --json, the same bytes on every run", () => {
    const run = open();
    const plain = run.run();
    expect(plain.code).toBe(0);
    expect(plain.stdout).toBe(
      plainOf(...scanned(6), ...B25_ROWS, ...B22_ROWS, ...B23_ROWS, CENSUS),
    );

    const json = run.run({ json: true });
    expect(reportOf(json)).toEqual({
      scopes: [
        {
          scope: API,
          features: ["audit", "billing", "orders", "shipping"],
          filesScanned: 11,
          violations: JSON_ROWS,
        },
      ],
      tables: { notFollowed: NOT_FOLLOWED, rows: [] },
    });
    expect(run.run().stdout).toBe(plain.stdout);
    expect(run.run({ json: true }).stdout).toBe(json.stdout);
  });

  it("lets each key add its own kinds to a root and change none of the other's", () => {
    const both = open();
    const rows = violationsOf(both);
    const kindsOf = (...kinds: string[]) => rows.filter((row) => kinds.includes(row.kind));

    const tables = open(FILES, WITHOUT_INTERPRETERS);
    expect(tables.run().stdout).toBe(plainOf(...scanned(3), ...B22_ROWS, ...B23_ROWS, CENSUS));
    expect(violationsOf(tables)).toEqual(kindsOf(B22, B23));

    const interpreters = open(FILES, WITHOUT_TABLES);
    expect(interpreters.run().stdout).toBe(plainOf(...scanned(3), ...B25_ROWS));
    expect(violationsOf(interpreters)).toEqual(kindsOf(B25));
    expect(reportOf(interpreters.run({ json: true }))).not.toHaveProperty("tables");
  });

  it("gives a root file's B22 and B23 the row of a file in no feature, and names no place", () => {
    const run = open({ ...FILES, ...LOOSE });
    const rows = violationsOf(run);
    const rowOf = (kind: string, from: string): BoundaryViolation => {
      const found = rows.find((row) => row.kind === kind && row.from === from);
      if (found === undefined) throw new Error(`no ${kind} row for ${from}`);
      return found;
    };

    // The `--json` row: the keys are the whole of what it says, and none is a place.
    expect(keysOf(rowOf(B22, OWN_TABLE))).toEqual(keysOf(rowOf(B22, LOOSE_DECLARE)));
    expect(keysOf(rowOf(B23, DIRECT))).toEqual(keysOf(rowOf(B23, LOOSE_WRITE)));
    expect(keysOf(rowOf(B22, OWN_TABLE))).toEqual(["from", "kind", "specifier", "to", "typeOnly"]);
    expect(keysOf(rowOf(B23, DIRECT))).toEqual([
      "from",
      "kind",
      "owner",
      "specifier",
      "to",
      "typeOnly",
    ]);

    // The plain row, once the file is taken out of it.
    const plain = run.run().stdout.split("\n");
    const plainRow = (code: string, from: string): string | undefined =>
      plain
        .find((row) => row.startsWith(`  ${code} `) && row.includes(` ${from} `))
        ?.replace(from, "<file>");
    expect(plainRow("B22", OWN_TABLE)).toBe(`  B22 ${B22} <file> -> pgTable`);
    expect(plainRow("B22", OWN_TABLE)).toBe(plainRow("B22", LOOSE_DECLARE));
    expect(plainRow("B23", DIRECT)).toBe(`  B23 ${B23} <file> -> orders  [owner: orders]`);
    expect(plainRow("B23", DIRECT)).toBe(plainRow("B23", LOOSE_WRITE));

    // The ledger entry, which keeps no owner.
    expect(run.run({ acceptCrossings: true, reason: "legacy" }).code).toBe(0);
    const entryOf = (kind: string, from: string) => {
      const found = ledgerOf(run).entries.find((e) => e.kind === kind && e.from === from);
      if (found === undefined) throw new Error(`no ${kind} entry for ${from}`);
      return found;
    };
    const entryKeys = ["from", "kind", "reason", "scope", "specifier", "to"];
    expect(keysOf(entryOf(B22, OWN_TABLE))).toEqual(keysOf(entryOf(B22, LOOSE_DECLARE)));
    expect(keysOf(entryOf(B23, DIRECT))).toEqual(keysOf(entryOf(B23, LOOSE_WRITE)));
    expect(keysOf(entryOf(B22, OWN_TABLE))).toEqual(entryKeys);
    expect(keysOf(entryOf(B23, DIRECT))).toEqual(entryKeys);
  });

  it("is accepted by name like any crossing: six entries, and a gate that then passes byte for byte", () => {
    const run = open();
    expect(run.run({ ci: true }).code).toBe(1);
    expect(run.run({ acceptCrossings: true, reason: "legacy" }).code).toBe(0);
    const entries = ledgerOf(run).entries;
    expect(entries.map((e) => [e.kind, e.from, ledgerTargetOf(e)])).toEqual([
      [B25, DIRECT_TEST, ORDERS_TABLES],
      [B25, DIRECT, ORDERS_TABLES],
      [B25, READS, AUDIT_TABLES],
      [B22, OWN_TABLE, "pgTable"],
      [B23, DIRECT, "orders"],
      [B23, VIA_BARREL, "invoices"],
    ]);
    expect(entries.every((entry) => entry.reason === "legacy")).toBe(true);

    const seeded = ledgerText(run);
    const first = run.run({ ci: true });
    const second = run.run({ ci: true });
    expect([first.code, second.code]).toEqual([0, 0]);
    expect(first.stdout).toContain("6 recorded crossing(s), none new");
    expect(second.stdout).toBe(first.stdout);
    expect(ledgerText(run)).toBe(seeded);
  });

  it("is the same reach in the --owners view, at the place `interpreter queue`, and its writes are the gate's B23", () => {
    const run = open();
    const owners: OwnersReport = JSON.parse(run.owners({ json: true }).stdout);
    const queue = { kind: "interpreter", technology: "queue" };
    const reach = owners.scopes
      .flatMap((scope) => scope.features)
      .flatMap((feature) => feature.reach.map((row) => ({ owner: feature.feature, ...row })))
      .sort((a, b) => a.file.localeCompare(b.file));
    expect(reach).toEqual([
      { owner: "orders", table: "orders", access: "write", file: DIRECT, place: queue },
      { owner: "audit", table: "entries", access: "read", file: READS, place: queue },
      { owner: "billing", table: "invoices", access: "write", file: VIA_BARREL, place: queue },
    ]);

    const cells = run
      .owners()
      .stdout.split("\n")
      .map((line) => line.trim().split(/ {2,}/));
    expect(cells).toContainEqual(["orders", "write", DIRECT, "interpreter queue"]);
    expect(cells).toContainEqual(["entries", "read", READS, "interpreter queue"]);
    expect(cells).toContainEqual(["invoices", "write", VIA_BARREL, "interpreter queue"]);

    // The view and the gate read one function, and this is what keeps them from drifting apart.
    const viewWrites = reach
      .filter((row) => row.access === "write")
      .map((row) => [row.file, row.owner, row.table]);
    const gateWrites = violationsOf(run).flatMap((row) =>
      row.kind === B23 ? [[row.from, row.owner, row.specifier]] : [],
    );
    expect(viewWrites).toEqual(gateWrites);
  });
});
