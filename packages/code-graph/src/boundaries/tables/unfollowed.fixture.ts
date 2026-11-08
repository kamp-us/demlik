import { at, BARRELS, lines, tablesOf } from "./reexport.fixture.js";
import type { UnfollowedKind } from "./unfollowed.js";

// What no re-export can be followed through, one file for each kind of the census: a variable and a
// helper's result (two files of one kind), a module the run does not load, a chain that ends at a
// default export, an ambiguous star, a module that exports with `=`, and raw SQL.
const unfollowed = (kind: UnfollowedKind, name: string) => ({
  kind,
  file: at(`src/billing/adapters/driven/${name}.ts`),
});

export const UNFOLLOWED_WRITES = {
  variable: unfollowed("untraced-write", "untraced-variable"),
  helper: unfollowed("untraced-write", "untraced-helper"),
  unloaded: unfollowed("unloaded-module", "unloaded"),
  default: unfollowed("default-export", "default-chain"),
  ambiguous: unfollowed("ambiguous-star", "ambiguous"),
  equals: unfollowed("export-equals", "export-equals"),
  raw: unfollowed("raw-sql", "raw-sql"),
};

// The two files that alias a table read it: that is a reach, which they also leave unfollowed.
export const ALIASING = [UNFOLLOWED_WRITES.variable.file, UNFOLLOWED_WRITES.helper.file];

export const UNFOLLOWED_FILES: Record<string, string> = {
  [UNFOLLOWED_WRITES.variable.file]: lines(
    'import { orders } from "../../../orders";',
    "export const go = (db: Db) => { const table = orders; return db.insert(table); };",
  ),
  [UNFOLLOWED_WRITES.helper.file]: lines(
    'import { orders } from "../../../orders";',
    "declare function pick(table: unknown): unknown;",
    "export const go = (db: Db) => db.insert(pick(orders));",
  ),
  [UNFOLLOWED_WRITES.unloaded.file]: lines(
    'import { orders } from "@shop/outside";',
    "export const go = (db: Db) => db.insert(orders);",
  ),
  [UNFOLLOWED_WRITES.default.file]: lines(
    `import { parcels } from "${BARRELS}/defaults";`,
    "export const go = (db: Db) => db.insert(parcels);",
  ),
  [UNFOLLOWED_WRITES.ambiguous.file]: lines(
    `import { orders } from "${BARRELS}/ambiguous";`,
    "export const go = (db: Db) => db.insert(orders);",
  ),
  [UNFOLLOWED_WRITES.equals.file]: lines(
    `import { orders } from "${BARRELS}/legacy";`,
    "export const go = (db: Db) => db.insert(orders);",
  ),
  [UNFOLLOWED_WRITES.raw.file]: lines(
    `export const go = (db: Db) => db.execute(sql\`INSERT INTO orders (id) VALUES (\${1})\`);`,
  ),
  [at("src/drizzle/defaults.ts")]: lines('export { default as parcels } from "./default-source";'),
  [at("src/drizzle/default-source.ts")]: lines("export default {};"),
  [at("src/drizzle/ambiguous.ts")]: lines(
    `export * from "${tablesOf("orders")}";`,
    'export * from "./shadow";',
  ),
  [at("src/drizzle/shadow.ts")]: lines("export const orders = 1;"),
  [at("src/drizzle/legacy.ts")]: lines("const tables = {};", "export = tables;"),
};

// Each of these looks like a write that cannot be followed and is not one: a string key, a type, an
// enum, a statement that only mentions the words.
export const NEAR_MISSES: Record<string, string> = {
  [at("src/billing/adapters/driven/near-misses.ts")]: lines(
    'import { pgEnum } from "drizzle-orm/pg-core";',
    'import type { orderLines } from "../../../orders/adapters/driven/tables";',
    `import defaulted from "${BARRELS}/default-source";`,
    'import { thing } from "@shop/outside";',
    "export type Shape = typeof orderLines;",
    "export const mentioned = [defaulted, thing];",
    "const seen = new Map<string, number>();",
    'export const forget = () => seen.delete("orders");',
    'export const actions = pgEnum("action", ["insert", "update", "delete"]);',
    "export const enumText = \"CREATE TYPE action AS ENUM ('insert', 'update', 'delete')\";",
    'export const prose = "update the row, then set it aside";',
  ),
};
