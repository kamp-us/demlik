import { shopManifests } from "../test-helpers/shop-workspace.js";

// The synthetic repo the `--owners` view is tested against: one scope, `services/api`, with four
// features that each own tables, one worker with a D1 binding, and one technology with an interpreter.
// Every name is made up.
//
//  - `orders` declares `orders` and `orderLines` with `pgTable`, and an enum beside them.
//  - `billing` declares `invoices` on a `pgSchema` object, with `<schema>.table(…)`, and an enum.
//  - `shipping` declares `shipments`, with a foreign key to `orders`.
//  - `audit` declares `entries`, and has no `ports.ts`.

export const API = "services/api";
export const at = (rel: string): string => `${API}/${rel}`;

const lines = (...source: string[]): string => `${source.join("\n")}\n`;

const ORDERS_TABLES = "../../../orders/adapters/driven/tables";

const TABLES: Record<string, string> = {
  [at("src/orders/adapters/driven/tables.ts")]: lines(
    'import { pgEnum, pgTable, text } from "drizzle-orm/pg-core";',
    'export const orderStatus = pgEnum("order_status", ["open", "shipped"]);',
    'export const orders = pgTable("orders", { id: text("id").primaryKey() });',
    'export const orderLines = pgTable("order_lines", { id: text("id").primaryKey() });',
  ),
  [at("src/billing/adapters/driven/tables.ts")]: lines(
    'import { pgEnum, pgSchema, text } from "drizzle-orm/pg-core";',
    'const billing = pgSchema("billing");',
    'export const invoiceKind = pgEnum("invoice_kind", ["one-off", "recurring"]);',
    'export const invoices = billing.table("invoices", { id: text("id").primaryKey() });',
  ),
  [at("src/shipping/adapters/driven/tables.ts")]: lines(
    'import { pgTable, text } from "drizzle-orm/pg-core";',
    `import { orders } from "${ORDERS_TABLES}";`,
    'export const shipments = pgTable("shipments", {',
    '  orderId: text("order_id").references(() => orders.id),',
    "});",
  ),
  [at("src/audit/adapters/driven/tables.ts")]: lines(
    'import { pgTable, text } from "drizzle-orm/pg-core";',
    'export const entries = pgTable("audit_entries", { id: text("id").primaryKey() });',
  ),
};

// Three features with ports: `orders`, `billing` and `shipping`. `audit` has none.
const feature = (
  name: string,
  Name: string,
  commands: string,
  driven: string,
): [string, string] => [
  at(`src/${name}/ports.ts`),
  lines(
    `export type ForPlacing${Name} = (id: string) => Promise<void>;`,
    `export type ForStoring${Name} = (id: string) => Promise<void>;`,
    `export type ${Name} = { ${commands}: ForPlacing${Name} };`,
    `export type ${Name}Driven = { ${driven}: ForStoring${Name} };`,
  ),
];

const PORTS: Record<string, string> = {
  ...Object.fromEntries([
    feature("orders", "Orders", "place", "store"),
    feature("billing", "Billing", "charge", "ledger"),
    feature("shipping", "Shipping", "ship", "carrier"),
  ]),
  [at("src/orders/application/orders.ts")]: lines(
    'import type { Orders, OrdersDriven } from "../ports";',
    "export function createOrders(driven: OrdersDriven): Orders {",
    "  return { place: driven.store };",
    "}",
  ),
  [at("src/billing/application/billing.ts")]: lines(
    'import type { Billing, BillingDriven } from "../ports";',
    "export function createBilling(driven: BillingDriven): Billing {",
    "  return { charge: driven.ledger };",
    "}",
  ),
  [at("src/shipping/application/shipping.ts")]: lines(
    'import type { Shipping, ShippingDriven } from "../ports";',
    "export function createShipping(driven: ShippingDriven): Shipping {",
    "  return { ship: driven.carrier };",
    "}",
  ),
};

// How a file reaches a table another feature owns, in every spelling the view lists: a named
// import, an alias, a namespace member, and a namespace member through a barrel.
const REACH: Record<string, string> = {
  // `write`: a named import, an alias and a namespace member.
  [at("src/billing/adapters/driven/invoice-store.ts")]: lines(
    'import { invoices } from "./tables";',
    `import { orders } from "${ORDERS_TABLES}";`,
    "export const place = (db: Db) => db.insert(invoices).then(() => db.insert(orders));",
  ),
  [at("src/shipping/adapters/driven/shipment-store.ts")]: lines(
    `import { orders as o } from "${ORDERS_TABLES}";`,
    "export const ship = (db: Db) => db.update(o).set({});",
  ),
  [at("src/audit/adapters/driven/audit-store.ts")]: lines(
    `import * as t from "${ORDERS_TABLES}";`,
    "export const forget = (db: Db) => db.delete(t.orders);",
  ),
  // `read`: a named import beside a write of its own table, and a namespace member.
  [at("src/shipping/adapters/driven/shipment-reads.ts")]: lines(
    'import { shipments } from "./tables";',
    `import { orders } from "${ORDERS_TABLES}";`,
    "export const list = (db: Db) => db.select().from(shipments).innerJoin(orders, eq(1, 1));",
  ),
  [at("src/audit/adapters/driven/audit-reads.ts")]: lines(
    `import * as t from "${ORDERS_TABLES}";`,
    "export const lines = (db: Db) => db.select().from(t.orderLines);",
  ),
  // `write` through a schema barrel, which sits in no feature: the table is `orders`'s all the same.
  [at("src/drizzle/schema.ts")]: lines('export * from "../orders/adapters/driven/tables";'),
  [at("src/audit/adapters/driven/via-barrel.ts")]: lines(
    'import * as schema from "../../../drizzle/schema";',
    "export const forget = (db: Db) => db.delete(schema.orderLines);",
  ),
  // A file in no feature and a `lib` file, each writing one table and reading another.
  [at("src/main.ts")]: lines(
    `import { invoices } from "./billing/adapters/driven/tables";`,
    `import { entries } from "./audit/adapters/driven/tables";`,
    "export const seed = (db: Db, env: Env) => {",
    '  env.DB.prepare("select 1");',
    "  return [db.insert(invoices), db.select().from(entries)];",
    "};",
  ),
  [at("src/lib/seed.ts")]: lines(
    `import { entries } from "../audit/adapters/driven/tables";`,
    `import { orders } from "../orders/adapters/driven/tables";`,
    "export const seed = (db: Db) => [db.insert(entries), db.select().from(orders)];",
  ),
};

// Everything the view lists nothing for. Each file imports a table or a name of a table file, and
// none of them reaches a table another feature owns.
const SILENT: Record<string, string> = {
  [at("src/orders/adapters/driven/order-store.ts")]: lines(
    'import { orders } from "./tables";',
    "export const place = (db: Db, env: Env) => {",
    '  env.DB.prepare("select 1");',
    "  return db.insert(orders);",
    "};",
  ),
  [at("src/billing/adapters/driven/order-shape.ts")]: lines(
    `import type { orders } from "${ORDERS_TABLES}";`,
    `import { type orderLines } from "${ORDERS_TABLES}";`,
    "export type Shape = [typeof orders, typeof orderLines];",
  ),
  [at("src/billing/adapters/driven/order-status.ts")]: lines(
    `import { orderStatus } from "${ORDERS_TABLES}";`,
    "export const open = orderStatus.enumValues;",
  ),
  [at("src/audit/adapters/driven/spread.ts")]: lines(
    `import * as t from "${ORDERS_TABLES}";`,
    "export const every = { ...t };",
    "export const take = (x: unknown) => x;",
    "export const taken = take(t);",
  ),
  [at("src/billing/adapters/driven/rebound.ts")]: lines(
    `import { orders } from "${ORDERS_TABLES}";`,
    "export const place = (db: Db, orders: Row) => db.insert(orders);",
  ),
  [at("src/billing/adapters/driven/reexport.ts")]: lines(
    `import { orders } from "${ORDERS_TABLES}";`,
    `export { orders };`,
    `export { orderLines } from "${ORDERS_TABLES}";`,
  ),
  [at("src/billing/adapters/driven/member.ts")]: lines(
    `import { orders } from "${ORDERS_TABLES}";`,
    "export const note = (row: { orders: number }) => row.orders;",
  ),
  [at("src/billing/adapters/driven/invoice-store.test.ts")]: lines(
    `import { orders } from "${ORDERS_TABLES}";`,
    "export const seed = (db: Db) => db.insert(orders);",
  ),
};

// The binding is `DB`, a D1 database of the one worker `services/api`, whose `main` is `src/main.ts`.
// `bindingOwners` narrows it to `order-store.ts`. A site sits in the worker's `main` (in `REACH`),
// one in an owner, and one in `orders`' application, outside a driven adapter. A test file holds a
// fourth, which the gate's census lists and the view does not.
const BINDING: Record<string, string> = {
  [at("wrangler.jsonc")]: JSON.stringify({
    name: "api",
    main: "src/main.ts",
    d1_databases: [{ binding: "DB" }],
  }),
  [at("src/orders/application/place.ts")]: lines(
    "export const count = (env: Env) => env.DB.prepare('select count(*) from orders');",
  ),
  [at("src/orders/adapters/driven/order-store.test.ts")]: lines(
    "export const probe = (env: Env) => env.DB.prepare('select 1');",
  ),
};

// One technology, `queue`, whose interpreter sits under `src/interpreters/queue`. Four files outside
// the root import from it, each a different way: `billing` and `shipping` by a value import, `orders`
// by a type-only import and `audit` by a re-export. `inner.ts` imports the root from inside it, so it
// is no reach. `outbox.ts` sits in the root and reads a table `orders` owns, a reach row whose place
// is the interpreter.
const QUEUE_ROOT = "../../../interpreters/queue/index";
const INTERPRETER: Record<string, string> = {
  [at("src/interpreters/queue/index.ts")]: "export const send = (message: string) => message;\n",
  [at("src/billing/adapters/driven/enqueue.ts")]: lines(
    `import { send } from "${QUEUE_ROOT}";`,
    "export const enqueue = (id: string) => send(id);",
  ),
  [at("src/orders/adapters/driven/queue-shape.ts")]: lines(
    `import type { send } from "${QUEUE_ROOT}";`,
    "export type Send = typeof send;",
  ),
  [at("src/audit/adapters/driven/queue-reexport.ts")]: lines(
    `export { send } from "${QUEUE_ROOT}";`,
  ),
  [at("src/interpreters/queue/inner.ts")]: lines(
    'import { send } from "./index";',
    "export const again = (id: string) => send(id);",
  ),
  [at("src/interpreters/queue/outbox.ts")]: lines(
    'import { orderLines } from "../../orders/adapters/driven/tables";',
    "export const pending = (db: Db) => db.select().from(orderLines);",
  ),
  [at("src/shipping/adapters/driven/carrier.ts")]: lines(
    `import { shipments } from "./tables";`,
    `import { send } from "${QUEUE_ROOT}";`,
    "export const notify = (db: Db) => [db.insert(shipments), send('shipped')];",
  ),
};

export const OWNERS_FILES: Record<string, string> = {
  ...shopManifests([API]),
  ...TABLES,
  ...PORTS,
  ...REACH,
  ...SILENT,
  ...BINDING,
  ...INTERPRETER,
};

export const OWNERS_RULES = {
  features: { [API]: ["orders", "billing", "shipping", "audit"] },
  tableOwnership: ["table-declared-outside-tables", "table-written-outside-owner"],
  acrossDeployables: ["binding-outside-driven-adapter"],
  bindingOwners: { [API]: { DB: ["src/orders/adapters/driven/order-store.ts"] } },
  interpreters: {
    [API]: { queue: { root: "src/interpreters/queue", modules: ["@shop/queue-sdk"] } },
  },
  testFiles: ["**/*.test.ts"],
};
