import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { type BoundaryRepo, boundaryRepo } from "../../test-helpers/boundary-repo.js";
import {
  crossingsOf,
  entryLines,
  ledgerOf,
  ledgerText,
  reportOf,
} from "../../test-helpers/library-report.js";
import { SHOP_TYPES, shopManifests } from "../../test-helpers/shop-workspace.js";
import { sourceUnit } from "../../test-helpers/source-unit.js";
import { MIGRATED_REASON } from "../migrate.js";
import { ALL_TABLES, readTables, tableFactsOf } from "./tables.js";

const API = "services/api";
const at = (rel: string): string => `${API}/${rel}`;
const lines = (...source: string[]): string => `${source.join("\n")}\n`;

const BOTH = ["table-declared-outside-tables", "table-written-outside-owner"];
const RULES = {
  features: { [API]: ["orders", "billing", "shipping", "audit"] },
  tableOwnership: BOTH,
};

let repo: BoundaryRepo | null = null;
const open = (files: Record<string, string>, rules: unknown = RULES): BoundaryRepo => {
  repo = boundaryRepo(".", { ...shopManifests([API]), ...files }, rules);
  return repo;
};
afterEach(() => repo?.dispose());

const tablesOf = (table: string, name = table): string =>
  lines(
    'import { pgTable, text } from "drizzle-orm/pg-core";',
    `export const ${table} = pgTable("${name}", { id: text("id").primaryKey() });`,
  );

// `[kind, importer, table or constructor]` of the table crossings a `--json` run lists.
const tableRows = (run: BoundaryRepo, kind: string): string[][] =>
  crossingsOf(run.run({ json: true })).filter(([k]) => k === kind);

// Four features that each own their tables. Five files write a table they do not own, one in every
// way a file reaches a neighbour's table object; the rest read, join, reference or write their own.
const ORDERS_TABLES = "../../../orders/adapters/driven/tables";
const FOUR: Record<string, string> = {
  [at("src/orders/adapters/driven/tables.ts")]: tablesOf("orders"),
  [at("src/billing/adapters/driven/tables.ts")]: tablesOf("invoices"),
  [at("src/audit/adapters/driven/tables.ts")]: tablesOf("entries", "audit_entries"),
  [at("src/shipping/adapters/driven/tables.ts")]: lines(
    'import { pgTable, text } from "drizzle-orm/pg-core";',
    `import { orders } from "${ORDERS_TABLES}";`,
    'export const shipments = pgTable("shipments", {',
    '  orderId: text("order_id").references(() => orders.id),',
    "});",
  ),
  // The writes.
  [at("src/billing/adapters/driven/invoice-store.ts")]: lines(
    'import { invoices } from "./tables";',
    `import { orders } from "${ORDERS_TABLES}";`,
    "export const place = (db: Db) => db.insert(invoices).values({}).then(() => db.insert(orders));",
  ),
  [at("src/shipping/adapters/driven/shipment-store.ts")]: lines(
    `import { orders as o } from "${ORDERS_TABLES}";`,
    "export const ship = (db: Db) => db.update(o).set({});",
  ),
  [at("src/audit/adapters/driven/audit-store.ts")]: lines(
    `import * as t from "${ORDERS_TABLES}";`,
    "export const forget = (db: Db) => db.delete(t.orders);",
  ),
  [at("src/main.ts")]: lines(
    'import { invoices } from "./billing/adapters/driven/tables";',
    "export const seed = (db: Db) => db.insert(invoices);",
  ),
  [at("src/lib/seed.ts")]: lines(
    'import { entries } from "../audit/adapters/driven/tables";',
    "export const seed = (db: Db) => db.insert(entries);",
  ),
  // Clean: a read join, a feature writing its own table, a type-only import, a test.
  [at("src/shipping/adapters/driven/shipment-reads.ts")]: lines(
    'import { shipments } from "./tables";',
    `import { orders } from "${ORDERS_TABLES}";`,
    "export const list = (db: Db) => db.select().from(shipments).innerJoin(orders, eq(1, 1));",
  ),
  [at("src/orders/adapters/driven/order-store.ts")]: lines(
    'import { orders } from "./tables";',
    "export const place = (db: Db) => db.insert(orders).values({});",
  ),
  [at("src/billing/adapters/driven/order-shape.ts")]: lines(
    `import type { orders } from "${ORDERS_TABLES}";`,
    "export const place = (db: Db) => db.insert(orders);",
  ),
  [at("src/billing/adapters/driven/order-inline-type.ts")]: lines(
    `import { type orders } from "${ORDERS_TABLES}";`,
    "export const place = (db: Db) => db.insert(orders);",
  ),
  [at("src/billing/adapters/driven/invoice-store.test.ts")]: lines(
    `import { orders } from "${ORDERS_TABLES}";`,
    "export const seed = (db: Db) => db.insert(orders);",
  ),
};

const FOUR_RULES = { ...RULES, testFiles: ["**/*.test.ts"] };

const FOUR_WRITES = [
  ["table-written-outside-owner", at("src/audit/adapters/driven/audit-store.ts"), "orders"],
  ["table-written-outside-owner", at("src/billing/adapters/driven/invoice-store.ts"), "orders"],
  ["table-written-outside-owner", at("src/lib/seed.ts"), "entries"],
  ["table-written-outside-owner", at("src/main.ts"), "invoices"],
  ["table-written-outside-owner", at("src/shipping/adapters/driven/shipment-store.ts"), "orders"],
];

// A lib file's import is also B3; it is the one crossing in the fixture that is not about tables.
const FOUR_CROSSINGS = [
  ...FOUR_WRITES,
  ["lib-imports-feature", at("src/lib/seed.ts"), at("src/audit/adapters/driven/tables.ts")],
].sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? "") || (a[1] ?? "").localeCompare(b[1] ?? ""));

describe("a team puts a table's single owner behind the merge gate", () => {
  it("lists a write of another feature's table however it is spelled, and nothing else", () => {
    const run = open(FOUR, FOUR_RULES);
    expect(crossingsOf(run.run({ json: true }))).toEqual(FOUR_CROSSINGS);
    expect(tableRows(run, "table-declared-outside-tables")).toEqual([]);
    const gated = run.run({ ci: true });
    expect(gated.code).toBe(1);
    expect(entryLines(gated.stdout)).toHaveLength(FOUR_CROSSINGS.length);
  });

  it("names the owner in the report and the failing gate, and keeps it out of the ledger", () => {
    const run = open(FOUR, FOUR_RULES);
    const owners = reportOf(run.run({ json: true }))
      .scopes.flatMap((scope) => scope.violations)
      .filter((v) => v.kind === "table-written-outside-owner")
      .map((v) => [v.from, "owner" in v ? v.owner : null]);
    expect(owners).toEqual([
      [at("src/audit/adapters/driven/audit-store.ts"), "orders"],
      [at("src/billing/adapters/driven/invoice-store.ts"), "orders"],
      [at("src/lib/seed.ts"), "audit"],
      [at("src/main.ts"), "billing"],
      [at("src/shipping/adapters/driven/shipment-store.ts"), "orders"],
    ]);
    const plain = run.run().stdout;
    expect(plain).toContain(
      `B23 table-written-outside-owner ${at("src/main.ts")} -> invoices  [owner: billing]`,
    );
    const failed = run.run({ ci: true });
    expect(failed.stdout).toContain(
      `B23 table-written-outside-owner  ${at("src/main.ts")} -> invoices  [owner: billing]`,
    );
    expect(failed.stdout).toContain(
      "Declare a table only in its feature's adapters/driven/tables.ts",
    );
    run.run({ acceptCrossings: true, reason: "legacy" });
    const entry = ledgerOf(run).entries.find((e) => e.from === at("src/main.ts"));
    expect(entry).toEqual({
      scope: API,
      kind: "table-written-outside-owner",
      from: at("src/main.ts"),
      to: null,
      specifier: "invoices",
      reason: "legacy",
    });
  });

  it("records the crossings, gates green byte for byte, and prunes each as it is fixed", () => {
    const run = open(FOUR, FOUR_RULES);
    expect(run.run({ ci: true }).code).toBe(1);
    expect(run.run({ acceptCrossings: true, reason: "legacy" }).code).toBe(0);
    expect(ledgerOf(run).entries).toHaveLength(FOUR_CROSSINGS.length);
    const seeded = ledgerText(run);
    const first = run.run({ ci: true });
    const second = run.run({ ci: true });
    expect([first.code, second.code]).toEqual([0, 0]);
    expect(second.stdout).toBe(first.stdout);
    expect(ledgerText(run)).toBe(seeded);

    run.remove(at("src/main.ts"));
    const fixed = run.run({ ci: true });
    expect(fixed.code).toBe(0);
    expect(fixed.stdout).toContain("pruned 1 boundary-ledger.json entry whose crossing is gone:");
    expect(ledgerOf(run).entries).toHaveLength(FOUR_CROSSINGS.length - 1);
  });

  it("seeds the entries on --migrate-ceilings and never counts them against a ceiling", () => {
    const run = open(FOUR, FOUR_RULES);
    const ceilings = (api: number) =>
      fs.writeFileSync(run.legacyFile, JSON.stringify({ default: 0, scopes: { [API]: api } }));
    ceilings(0);
    const refused = run.run({ migrateCeilings: true });
    expect(refused.code).toBe(2);
    expect(refused.errors.join("\n")).toContain(
      `${API}: 1 crossing(s) against a recorded ceiling of 0`,
    );
    ceilings(1);
    expect(run.run({ migrateCeilings: true }).code).toBe(0);
    const entries = ledgerOf(run).entries;
    expect(entries).toHaveLength(FOUR_CROSSINGS.length);
    expect(entries.every((entry) => entry.reason === MIGRATED_REASON)).toBe(true);
    expect(run.run({ ci: true }).code).toBe(0);
  });
});

// A table constructor in every spelling a file gets one by, in every place but a tables file.
const DECLARATIONS: Record<string, string> = {
  [at("src/orders/adapters/driven/tables.ts")]: tablesOf("orders"),
  [at("src/billing/adapters/driven/tables.ts")]: lines(
    'import { sqliteTable as table } from "drizzle-orm/sqlite-core";',
    'export const invoices = table("invoices", {});',
  ),
  [at("src/orders/adapters/driven/order-extra.ts")]: lines(
    'import { pgTable as table } from "drizzle-orm/pg-core";',
    'export const extra = table("extra", {});',
  ),
  [at("src/billing/adapters/driven/invoice-ns.ts")]: lines(
    'import * as pg from "drizzle-orm/pg-core";',
    'export const t = pg.pgTable("t", {});',
  ),
  [at("src/billing/application/two.ts")]: lines(
    'import { pgTable } from "drizzle-orm/pg-core";',
    'import { sqliteTable as lite } from "drizzle-orm/sqlite-core";',
    'export const a = pgTable("a", {});',
    'export const b = pgTable("b", {});',
    'export const c = lite("c", {});',
  ),
  [at("src/main.ts")]: lines(
    'import { mysqlTable } from "drizzle-orm/mysql-core";',
    'export const m = mysqlTable("m", {});',
  ),
  [at("src/lib/fixtures.ts")]: lines(
    'import { sqliteTable } from "drizzle-orm/sqlite-core";',
    'export const s = sqliteTable("s", {});',
  ),
  // Clean: a function of the same name that the file defines or takes from elsewhere, a mention,
  // a constructor of the wrong dialect's module.
  [at("src/orders/adapters/driven/own-helper.ts")]: lines(
    "function pgTable(name: string) { return name; }",
    'export const n = pgTable("n");',
  ),
  [at("src/orders/adapters/driven/table-helper.ts")]: "export const pgTable = (n: string) => n;\n",
  [at("src/orders/adapters/driven/from-elsewhere.ts")]: lines(
    'import { pgTable } from "./table-helper";',
    'export const n = pgTable("n");',
  ),
  [at("src/orders/adapters/driven/mentions.ts")]: lines(
    '// call pgTable("x") only in tables.ts',
    "export const note = 'pgTable(\"x\")';",
  ),
  [at("src/orders/adapters/driven/wrong-module.ts")]: lines(
    'import { pgTable } from "drizzle-orm/sqlite-core";',
    'export const w = pgTable("w", {});',
  ),
};

describe("a table is declared only in its feature's adapters/driven/tables.ts", () => {
  it("lists a constructor called anywhere else, once per file per constructor", () => {
    const run = open(DECLARATIONS);
    expect(tableRows(run, "table-declared-outside-tables")).toEqual([
      ["table-declared-outside-tables", at("src/billing/adapters/driven/invoice-ns.ts"), "pgTable"],
      ["table-declared-outside-tables", at("src/billing/application/two.ts"), "pgTable"],
      ["table-declared-outside-tables", at("src/billing/application/two.ts"), "sqliteTable"],
      ["table-declared-outside-tables", at("src/lib/fixtures.ts"), "sqliteTable"],
      ["table-declared-outside-tables", at("src/main.ts"), "mysqlTable"],
      ["table-declared-outside-tables", at("src/orders/adapters/driven/order-extra.ts"), "pgTable"],
    ]);
    expect(crossingsOf(run.run({ json: true }))).toHaveLength(6);
    expect(run.run().stdout).toContain(
      `B22 table-declared-outside-tables ${at("src/main.ts")} -> mysqlTable`,
    );
  });
});

// A write in every form the first argument can take, and every way a file reads a table.
const WRITES: Record<string, string> = {
  [at("src/orders/adapters/driven/tables.ts")]: lines(
    'import { pgTable, text } from "drizzle-orm/pg-core";',
    'export const orders = pgTable("orders", { id: text("id") });',
    'export const orderLines = pgTable("order_lines", { id: text("id") });',
  ),
  [at("src/billing/adapters/driven/optional.ts")]: lines(
    `import { orders, orderLines } from "${ORDERS_TABLES}";`,
    "export const a = (db?: Db) => db?.insert(orders);",
    "export const b = (tx: Tx) => tx.update?.(orderLines);",
    "export class S { constructor(private db: Db) {} go() { return this.db.delete(orderLines); } }",
  ),
  [at("src/billing/adapters/driven/repeat.ts")]: lines(
    `import { orders } from "${ORDERS_TABLES}";`,
    "export const a = (db: Db) => db.insert(orders);",
    "export const b = (db: Db) => db.update(orders);",
    "export const c = (db: Db) => db.delete(orders);",
  ),
  [at("src/billing/adapters/driven/reads.ts")]: lines(
    `import { orders, orderLines } from "${ORDERS_TABLES}";`,
    "export const a = (db: Db) => db.select().from(orders).innerJoin(orderLines, eq(1, 1));",
    "export const b = (db: Db) => db.insert(other, orders);",
  ),
};

describe("a write is a call of insert, update or delete that takes the imported table first", () => {
  it("reads an optional call and any receiver, and counts a table once per file", () => {
    const run = open(WRITES);
    expect(tableRows(run, "table-written-outside-owner")).toEqual([
      ["table-written-outside-owner", at("src/billing/adapters/driven/optional.ts"), "orderLines"],
      ["table-written-outside-owner", at("src/billing/adapters/driven/optional.ts"), "orders"],
      ["table-written-outside-owner", at("src/billing/adapters/driven/repeat.ts"), "orders"],
    ]);
  });
});

// Everything the kinds do not see, each next to the one write they do.
const NOT_SEEN: Record<string, string> = {
  [at("src/orders/adapters/driven/tables.ts")]: tablesOf("orders"),
  [at("src/orders/index.ts")]: 'export { orders } from "./adapters/driven/tables";\n',
  [at("src/drizzle/schema.ts")]: 'export { orders } from "../orders/adapters/driven/tables";\n',
  [at("src/billing/adapters/driven/seen.ts")]: lines(
    `import { orders } from "${ORDERS_TABLES}";`,
    "export const w = (db: Db) => db.insert(orders);",
  ),
  [at("src/billing/adapters/driven/through-index.ts")]: lines(
    'import { orders as planTable } from "../../../orders";',
    "export const w = (db: Db) => db.insert(planTable);",
  ),
  [at("src/billing/adapters/driven/through-barrel.ts")]: lines(
    'import * as schema from "../../../drizzle/schema";',
    "export const w = (db: Db) => db.delete(schema.orders);",
  ),
  [at("src/billing/adapters/driven/variable.ts")]: lines(
    `import { orders } from "${ORDERS_TABLES}";`,
    "export const w = (db: Db) => { const t = orders; return db.insert(t); };",
  ),
  [at("src/billing/adapters/driven/helper.ts")]: lines(
    `import { orders } from "${ORDERS_TABLES}";`,
    "export const w = (db: Db) => insertInto(db, orders);",
  ),
  [at("src/billing/adapters/driven/default-import.ts")]: lines(
    `import orders from "${ORDERS_TABLES}";`,
    "export const w = (db: Db) => db.insert(orders);",
  ),
  [at("src/billing/adapters/driven/dynamic.ts")]: lines(
    `export const w = async (db: Db) => { const { orders } = await import("${ORDERS_TABLES}"); return db.insert(orders); };`,
    `export const r = (db: Db) => { const { orders } = require("${ORDERS_TABLES}"); return db.insert(orders); };`,
  ),
  [at("src/billing/adapters/driven/computed.ts")]: lines(
    `import { orders } from "${ORDERS_TABLES}";`,
    'export const w = (db: Db) => db["insert"](orders);',
  ),
  [at("src/billing/adapters/driven/raw-sql.ts")]: lines(
    "export const w = (db: Db) => db.execute(sql`INSERT INTO orders (id) VALUES (1)`);",
  ),
  [at("src/billing/adapters/driven/rebound.ts")]: lines(
    `import { orders } from "${ORDERS_TABLES}";`,
    "export const w = (db: Db, orders: Row) => db.insert(orders);",
  ),
  [at("src/billing/adapters/driven/schema-table.ts")]: lines(
    'import { pgSchema, pgEnum, pgSequence, pgView } from "drizzle-orm/pg-core";',
    'const billing = pgSchema("billing");',
    'export const plan = billing.table("plan", {});',
    'export const kind = pgEnum("kind", ["a"]);',
    'export const seq = pgSequence("seq");',
    'export const v = pgView("v").as((qb) => qb.select().from(plan));',
  ),
};

describe("what the table kinds do not see reports nothing", () => {
  it("leaves every case alone but the one write it does see", () => {
    const run = open(NOT_SEEN);
    expect(crossingsOf(run.run({ json: true }))).toEqual([
      ["table-written-outside-owner", at("src/billing/adapters/driven/seen.ts"), "orders"],
    ]);
  });
});

// A port-layout scope and a library, each with a constructor call and a write of an imported binding
// named like a table, beside a per-feature scope that is judged.
const PORTS = "services/ports";
const LIBRARY = "packages/util";
const UNJUDGED: Record<string, string> = {
  ...shopManifests([PORTS, LIBRARY]),
  [at("src/orders/adapters/driven/tables.ts")]: tablesOf("orders"),
  [at("src/orders/adapters/driven/stray.ts")]: tablesOf("stray"),
  [`${PORTS}/src/driven-adapters/tables.ts`]: tablesOf("orders"),
  [`${PORTS}/src/driven-adapters/store.ts`]: lines(
    'import { orders } from "./tables";',
    "export const w = (db: Db) => db.insert(orders);",
  ),
  [`${LIBRARY}/src/tables.ts`]: tablesOf("orders"),
  [`${LIBRARY}/src/fixtures.ts`]: lines(
    'import { orders } from "./tables";',
    "export const w = (db: Db) => db.insert(orders);",
  ),
};
const UNJUDGED_RULES = {
  features: { [API]: ["orders"], [PORTS]: ["application", "driving-adapters", "driven-adapters"] },
  libraryTypes: SHOP_TYPES,
  libraries: { [LIBRARY]: "util" },
  tableOwnership: BOTH,
};

describe("only a scope laid out per feature is judged", () => {
  it("judges a port-layout scope and a library by neither kind", () => {
    const run = open(UNJUDGED, UNJUDGED_RULES);
    expect(crossingsOf(run.run({ json: true }))).toEqual([
      ["table-declared-outside-tables", at("src/orders/adapters/driven/stray.ts"), "pgTable"],
    ]);
  });
});

describe("a rules file that does not list a table kind behaves as it did", () => {
  it("reports, gates and writes the same bytes with the key absent or empty, and no table row", () => {
    const { tableOwnership: _listed, ...absent } = FOUR_RULES;
    const outputs = [absent, { ...absent, tableOwnership: [] }].map((rules) => {
      const run = open(FOUR, rules);
      const plain = run.run().stdout;
      const json = run.run({ json: true }).stdout;
      const gated = run.run({ ci: true });
      expect(run.run({ acceptCrossings: true, reason: "r" }).code).toBe(0);
      const written = ledgerText(run);
      run.dispose();
      return [plain, json, gated.code, gated.stdout, written];
    });
    expect(outputs[1]).toEqual(outputs[0]);
    const [plain, json, , gated, written] = outputs[0] ?? [];
    for (const text of [plain, json, gated, written]) {
      expect(text).not.toMatch(/B2[23]|table-(declared|written)/);
    }
    expect(json).not.toContain('"owner"');
  });

  it("reads no table fact from a file when no kind is listed", () => {
    const { tableOwnership: _listed, ...absent } = FOUR_RULES;
    const run = open(FOUR, absent);
    expect(crossingsOf(run.run({ json: true }))).toEqual([
      ["lib-imports-feature", at("src/lib/seed.ts"), at("src/audit/adapters/driven/tables.ts")],
    ]);
  });
});

// The run says in one line why it will not start, and writes nothing, even when asked to accept.
function refusal(rules: unknown): string {
  const run = open(FOUR, rules);
  const refused = run.run({ acceptCrossings: true, reason: "r" });
  expect(refused.code).toBe(2);
  expect(refused.stdout).toBe("");
  expect(refused.errors).toHaveLength(1);
  expect(fs.existsSync(run.ledgerFile)).toBe(false);
  return refused.errors[0] ?? "";
}

describe("a bad tableOwnership exits 2 with one line and writes nothing", () => {
  it("refuses a kind that is not one of the two, naming the key and the word", () => {
    const message = refusal({ ...RULES, tableOwnership: ["table-writen-outside-owner"] });
    expect(message).toContain("tableOwnership");
    expect(message).toContain("table-written-outside-owner");
  });

  it("refuses a kind listed where no scope uses the per-feature layout", () => {
    const ports = { [PORTS]: ["application", "driving-adapters", "driven-adapters"] };
    for (const features of [ports, {}]) {
      const message = refusal({ features, tableOwnership: ["table-written-outside-owner"] });
      expect(message).toContain('"tableOwnership"');
      expect(message).toContain("per-feature");
    }
  });
});

// What one file's syntax says about tables, whichever kinds the rules file lists.
const factsOf = (source: string) => tableFactsOf(ALL_TABLES, sourceUnit(source).syntax);
const orders = { source: "./tables", table: "orders" };

describe("a file's references to the tables it imports", () => {
  it("lists a table once where the file reads it, a write included, in source order", () => {
    const facts = factsOf(
      lines(
        'import { orders, orderLines as lines } from "./tables";',
        "export const a = (db: Db) => db.select().from(lines).innerJoin(orders, eq(1, 1));",
        "export const b = (db: Db) => db.insert(orders);",
      ),
    );
    expect(facts.references).toEqual([{ source: "./tables", table: "orderLines" }, orders]);
    expect(facts.writes).toEqual([orders]);
  });

  it("reads a namespace through its member, and a namespace taken whole names no table", () => {
    const facts = factsOf(
      lines(
        'import * as t from "./tables";',
        "export const a = (db: Db) => db.select().from(t.orders);",
        "export const every = { ...t };",
        "export const taken = use(t);",
      ),
    );
    expect(facts.references).toEqual([orders]);
  });

  it("does not read a name that is only spelled: a member, a key, an export, a type or an import", () => {
    const facts = factsOf(
      lines(
        'import { orders, orderLines, invoices } from "./tables";',
        'import type { shipments } from "./tables";',
        'import { type entries } from "./tables";',
        "export const note = (row: { orders: number }) => row.orders;",
        "export const keyed = { orderLines: 1 };",
        "export type Shape = [typeof shipments, typeof entries];",
        "export { invoices };",
      ),
    );
    expect(facts.references).toEqual([]);
  });

  it("keeps neither reading of a name the file binds twice", () => {
    const facts = factsOf(
      lines(
        'import { orders } from "./tables";',
        "export const place = (db: Db, orders: Row) => db.insert(orders);",
      ),
    );
    expect([facts.references, facts.writes]).toEqual([[], []]);
  });

  it("reads nothing where the rules file lists no table kind", () => {
    const source = lines(
      'import { pgTable } from "drizzle-orm/pg-core";',
      'import { orders } from "./tables";',
      "export const a = pgTable('a', {});",
      "export const b = (db: Db) => db.insert(orders);",
    );
    const none = tableFactsOf(readTables({ tableOwnership: [] }), sourceUnit(source).syntax);
    expect(none).toEqual({ writes: [], references: [], constructors: [], declared: [] });
  });
});

describe("the tables a file declares", () => {
  it("lists a name exported bound to a constructor call or to a schema's table, and nothing else", () => {
    const facts = factsOf(
      lines(
        'import { pgEnum, pgSchema, pgTable, text } from "drizzle-orm/pg-core";',
        'const billing = pgSchema("billing");',
        'export const orderStatus = pgEnum("order_status", ["open"]);',
        'export const orders = pgTable("orders", { id: text("id").primaryKey() });',
        'export const invoices = billing.table("invoices", { id: text("id").primaryKey() });',
        'const hidden = pgTable("hidden", {});',
        "export const schema = billing;",
        "export const rows = [orders];",
      ),
    );
    expect(facts.declared).toEqual(["orders", "invoices"]);
    expect(facts.constructors).toEqual(["pgTable"]);
  });
});
