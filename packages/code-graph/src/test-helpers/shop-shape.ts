import { SHOP_TYPES, shopManifests } from "./shop-workspace.js";

// The synthetic workspace the application-shape rules are tested against: five libraries of the
// five types, and one hexagonal scope, `services/api`, with the features `orders`, `billing` and
// `shipping`. Every name is made up. It plants fourteen crossings across B1, B8, B9, B15 and B16,
// and clean files beside them that must produce nothing: entry files of named re-exports, an
// `application/` file using everything its allowlist lets it, a read through a declared file, and
// four test files that carry code that would be a crossing outside the test role.

const lines = (...source: string[]): string => `${source.join("\n")}\n`;
const API = "services/api";
const ORDERS = `${API}/src/orders`;
const BILLING = `${API}/src/billing`;
const SHIPPING = `${API}/src/shipping`;

const LIBRARIES = {
  "packages/orders-contract": "contract",
  "packages/domain-kernel": "kernel",
  "packages/string-util": "util",
  "packages/db-adapter": "adapter",
  "packages/design-ui": "ui",
};

const MANIFESTS: Record<string, string> = {
  ...shopManifests([...Object.keys(LIBRARIES), API]),
  "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n  - "services/*"\n',
  [`${API}/wrangler.jsonc`]: JSON.stringify({ name: "api", d1_databases: [{ binding: "DB" }] }),
};

// The entry files of the libraries: four of named re-exports, and `string-util`'s, which declares.
const LIBRARY_FILES: Record<string, string> = {
  "packages/orders-contract/src/index.ts": lines(
    'export type { Order } from "./order";',
    'export { orderId } from "./order";',
  ),
  "packages/orders-contract/src/order.ts": lines(
    "export type Order = { id: string };",
    "export const orderId = (o: Order) => o.id;",
  ),
  "packages/domain-kernel/src/index.ts": lines(
    'export { type Total, total } from "./total";',
    'export { total as sum } from "./total";',
  ),
  "packages/domain-kernel/src/total.ts": lines(
    "export type Total = number;",
    "export const total = (xs: number[]): Total => xs.length;",
  ),
  "packages/domain-kernel/src/clock.test.ts": "export const stamp = Date.now();\n",
  "packages/string-util/src/index.ts": lines(
    "export function slug(s: string): string {",
    "  return s.toLowerCase();",
    "}",
  ),
  "packages/db-adapter/src/index.ts": 'export { default as connect } from "./connect";\n',
  "packages/db-adapter/src/connect.ts": "export default function connect() {}\n",
  "packages/design-ui/src/index.ts": 'export { Button } from "./button";\n',
  "packages/design-ui/src/button.ts": "export const Button = () => null;\n",
};

// What must stay clean in `services/api`.
const CLEAN: Record<string, string> = {
  [`${API}/src/lib/format.ts`]: "export const format = (n: number) => String(n);\n",
  [`${API}/src/generated/client.ts`]: "export const client = (db: unknown) => db;\n",
  [`${ORDERS}/index.ts`]: lines(
    'export { place } from "./application/place";',
    'export type { Port } from "./ports";',
  ),
  [`${ORDERS}/ports.ts`]: "export type Port = { place(id: string): void };\n",
  [`${ORDERS}/application/helpers.ts`]: "export const helper = 1;\n",
  [`${ORDERS}/application/place.ts`]: lines(
    'import { z } from "zod";',
    'import { orderId } from "@shop/orders-contract";',
    'import { total } from "@shop/domain-kernel";',
    'import { slug } from "@shop/string-util";',
    'import { format } from "../../lib/format";',
    'import { invoice } from "../../billing/index";',
    'import type { Port } from "../ports";',
    'import { helper } from "./helpers";',
    "export const place = [z, orderId, total, slug, format, invoice, helper] as unknown as Port;",
  ),
  [`${ORDERS}/adapters/driven/order-reads.ts`]: lines(
    'export const readOrders = (env: Env) => env.DB.prepare("SELECT id FROM orders");',
  ),
  [`${ORDERS}/adapters/driving/orders-http.ts`]: lines(
    'import { total } from "@shop/domain-kernel";',
    'import { readOrders } from "../driven/order-reads";',
    "export const handle = (env: Env) => [total([]), readOrders(env)];",
  ),
  [`${BILLING}/ports.ts`]: "export type Charge = { id: string };\n",
  [`${BILLING}/adapters/driven/invoice-reads.ts`]: lines(
    'export const readInvoice = (env: Env) => env.DB.prepare("SELECT id FROM invoices");',
  ),
  [`${SHIPPING}/ports.ts`]: "export type Ship = { id: string };\n",
  [`${SHIPPING}/adapters/driven/shipment-reads.ts`]: lines(
    'export const markShipped = (env: Env) => env.DB.prepare("UPDATE shipments SET shipped = 1");',
  ),
};

// The four test files: code that is a B10, B7, B8, B9 or B6 crossing anywhere else, and clean here.
const TESTS: Record<string, string> = {
  [`${ORDERS}/orders.test.ts`]: 'import { place } from "./index";\nexport const t = place;\n',
  [`${ORDERS}/application/place.test.ts`]: lines(
    'import { readOrders } from "../adapters/driven/order-reads";',
    "export const stamp = [Date.now(), readOrders];",
  ),
  [`${BILLING}/adapters/driving/http.test.ts`]: lines(
    'import { invoice } from "../../application/charge";',
    "export const t = () => console.log(invoice);",
  ),
};

// The fourteen crossings, in the files that carry them.
const PLANTED: Record<string, string> = {
  [`${BILLING}/index.ts`]: 'export * from "./application/charge";\n',
  [`${SHIPPING}/index.ts`]: 'export { ship } from "./application/ship";\nexport default {};\n',
  [`${ORDERS}/application/refund.ts`]:
    'import { drizzle } from "drizzle-orm";\nexport const refund = drizzle;\n',
  [`${BILLING}/application/charge.ts`]: lines(
    'import { Hono } from "hono";',
    'import * as Sentry from "@sentry/node";',
    "export const invoice = [Hono, Sentry];",
  ),
  [`${SHIPPING}/application/ship.ts`]: lines(
    'import type { D1Database } from "@cloudflare/workers-types";',
    'import { client } from "../../generated/client";',
    "export const ship = (db: D1Database) => client(db);",
  ),
  [`${ORDERS}/adapters/driving/orders-cron.ts`]: lines(
    'import { readOrders } from "../driven/order-reads";',
    "export const cron = readOrders;",
  ),
  [`${ORDERS}/adapters/driving/orders-types.ts`]: lines(
    'import type { Total } from "@shop/domain-kernel";',
    'import { readOrders } from "../driven/order-reads";',
    "export const types: [Total | null, typeof readOrders] = [null, readOrders];",
  ),
  [`${BILLING}/adapters/driving/billing-http.ts`]: lines(
    'import { total } from "@shop/domain-kernel";',
    'import { readInvoice } from "../driven/invoice-reads";',
    "export const handle = (env: Env) => [total([]), readInvoice(env)];",
  ),
  [`${SHIPPING}/adapters/driving/shipping-http.ts`]: lines(
    'import { total } from "@shop/domain-kernel";',
    'import { markShipped } from "../driven/shipment-reads";',
    "export const handle = (env: Env) => [total([]), markShipped(env)];",
  ),
  [`${BILLING}/adapters/driving/billing-log.ts`]: lines(
    'export const log = () => console.log("billing");',
  ),
  [`${SHIPPING}/shipping.test.ts`]: lines(
    'import { invoice } from "../billing/application/charge";',
    "export const t = invoice;",
  ),
};

export const SHAPE_FILES: Readonly<Record<string, string>> = {
  ...MANIFESTS,
  ...LIBRARY_FILES,
  ...CLEAN,
  ...TESTS,
  ...PLANTED,
};

export const SHAPE_KINDS_LISTED = [
  "index-not-exports-only",
  "application-import-outside-allowlist",
];

export const SHAPE_READ_ALLOWANCE = {
  [API]: {
    driven: [
      "src/orders/adapters/driven/order-reads.ts",
      "src/shipping/adapters/driven/shipment-reads.ts",
    ],
    decidedBy: ["kernel"],
  },
};

// The rules file with every new key declared, and the same with none of them.
export const SHAPE_RULES_WITHOUT_SHAPE = {
  features: { [API]: ["orders", "billing", "shipping"] },
  layout: { [API]: "hexagonal" },
  libraryRoots: ["packages"],
  libraryTypes: SHOP_TYPES,
  libraries: LIBRARIES,
  worldLibraries: ["drizzle-orm", "hono", "@sentry/*"],
};

export const SHAPE_RULES = {
  ...SHAPE_RULES_WITHOUT_SHAPE,
  applicationShape: SHAPE_KINDS_LISTED,
  applicationMayImport: ["contract", "kernel", "util"],
  pureDependencies: ["zod"],
  testFiles: ["**/*.test.ts"],
  readAllowance: SHAPE_READ_ALLOWANCE,
};

// `[scope, kind, from, to ?? specifier]` of the fourteen crossings a `--ci` run must list.
export const SHAPE_CROSSINGS: readonly (readonly [string, string, string, string])[] = [
  [
    "packages/string-util",
    "index-not-exports-only",
    "packages/string-util/src/index.ts",
    "declaration",
  ],
  [API, "index-not-exports-only", `${BILLING}/index.ts`, "export *"],
  [API, "index-not-exports-only", `${SHIPPING}/index.ts`, "export default"],
  [API, "application-import-outside-allowlist", `${ORDERS}/application/refund.ts`, "drizzle-orm"],
  [API, "application-import-outside-allowlist", `${BILLING}/application/charge.ts`, "hono"],
  [API, "application-import-outside-allowlist", `${BILLING}/application/charge.ts`, "@sentry/node"],
  [
    API,
    "application-import-outside-allowlist",
    `${SHIPPING}/application/ship.ts`,
    "@cloudflare/workers-types",
  ],
  [
    API,
    "application-import-outside-allowlist",
    `${SHIPPING}/application/ship.ts`,
    `${API}/src/generated/client.ts`,
  ],
  [
    API,
    "driving-reaches-driven",
    `${ORDERS}/adapters/driving/orders-cron.ts`,
    `${ORDERS}/adapters/driven/order-reads.ts`,
  ],
  [
    API,
    "driving-reaches-driven",
    `${ORDERS}/adapters/driving/orders-types.ts`,
    `${ORDERS}/adapters/driven/order-reads.ts`,
  ],
  [
    API,
    "driving-reaches-driven",
    `${BILLING}/adapters/driving/billing-http.ts`,
    `${BILLING}/adapters/driven/invoice-reads.ts`,
  ],
  [
    API,
    "driving-reaches-driven",
    `${SHIPPING}/adapters/driving/shipping-http.ts`,
    `${SHIPPING}/adapters/driven/shipment-reads.ts`,
  ],
  [API, "door-outside-driven-adapter", `${BILLING}/adapters/driving/billing-log.ts`, "console"],
  [API, "cross-feature", `${SHIPPING}/shipping.test.ts`, `${BILLING}/application/charge.ts`],
];
