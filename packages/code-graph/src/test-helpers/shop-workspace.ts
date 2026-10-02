import path from "node:path";

// The synthetic workspace the library rules are tested against: a hexagonal `services/api` scope
// with two features, and eight packages under `packages/`, seven of them declared as libraries of
// the five types the issue's example names. Every package is named `@shop/<directory>`.

export const SHOP_TYPES = {
  contract: { imports: ["contract", "util"], pure: true },
  kernel: { imports: ["kernel", "contract", "util"], pure: true },
  util: { imports: ["util"], pure: true },
  adapter: {
    imports: ["contract", "kernel", "util"],
    pure: false,
    importedFrom: ["driven"],
  },
  ui: { imports: ["ui", "contract", "kernel", "util"], pure: true },
};

export const SHOP_LIBRARIES = {
  "packages/orders-contract": "contract",
  "packages/billing-contract": "contract",
  "packages/domain-kernel": "kernel",
  "packages/string-util": "util",
  "packages/clock-adapter": "adapter",
  "packages/db-adapter": "adapter",
  "packages/design-ui": "ui",
};

export const SHOP_RULES = {
  features: { "services/api": ["orders", "billing"] },
  layout: { "services/api": "hexagonal" },
  libraryRoots: ["packages"],
  libraryTypes: SHOP_TYPES,
  libraries: SHOP_LIBRARIES,
  worldLibraries: ["drizzle-orm", "hono", "@sentry/*"],
};

export const SHOP_TSCONFIG = JSON.stringify({
  compilerOptions: { module: "esnext", moduleResolution: "bundler", strict: true },
});

// A `package.json` naming each directory `@shop/<directory>`, and the root `tsconfig.json` every
// scope's module resolution reads.
export function shopManifests(dirs: readonly string[]): Record<string, string> {
  const entries = dirs.map((dir) => [
    `${dir}/package.json`,
    JSON.stringify({ name: `@shop/${path.basename(dir)}` }),
  ]);
  return { "tsconfig.json": SHOP_TSCONFIG, ...Object.fromEntries(entries) };
}

export const SHOP_PACKAGES = [...Object.keys(SHOP_LIBRARIES), "packages/scratch"];

const lines = (...source: string[]): string => `${source.join("\n")}\n`;

// What the issue plants: the clean files that must produce nothing, and the twelve crossings that
// must be listed exactly: one `library-undeclared` (`packages/scratch`), four `library-imports-up`,
// four `impure-library` and three `adapter-library-imported-outside-driven`.
export const SHOP_SOURCES: Record<string, string> = {
  "packages/orders-contract/src/index.ts": lines(
    'import { b } from "@shop/billing-contract";',
    'import { u } from "@shop/string-util";',
    'import { z } from "zod";',
    'import { k } from "@shop/domain-kernel";',
    "export const o = [b, u, z, k];",
  ),
  "packages/orders-contract/src/clock.ts": "export const now = Date.now();\n",
  "packages/orders-contract/src/types.ts": lines(
    'import type { Context } from "hono";',
    "export type C = Context;",
  ),
  "packages/billing-contract/src/index.ts": "export const b = 1;\n",
  "packages/domain-kernel/src/index.ts": lines(
    'import { o } from "@shop/orders-contract";',
    'import { u } from "@shop/string-util";',
    "export const k = [o, u];",
  ),
  "packages/domain-kernel/src/store.ts": lines(
    'import { drizzle } from "drizzle-orm";',
    "export const store = drizzle;",
  ),
  "packages/domain-kernel/src/k.ts": lines(
    'import { s } from "@shop/scratch";',
    "export const k = s;",
  ),
  "packages/string-util/src/index.ts": "export const u = 1;\n",
  "packages/string-util/src/x.ts": lines(
    'import { schema } from "@shop/orders-contract/schema";',
    "export const x = schema;",
  ),
  "packages/string-util/src/log.ts": lines(
    'import { init } from "@sentry/node";',
    "export const log = init;",
  ),
  "packages/clock-adapter/src/index.ts": lines(
    'import { k } from "@shop/domain-kernel";',
    'import { Hono } from "hono";',
    'import { store } from "@shop/db-adapter";',
    "export const clock = [k, Hono, store, fetch];",
  ),
  "packages/db-adapter/src/index.ts": lines(
    'import { k } from "@shop/domain-kernel";',
    'import { drizzle } from "drizzle-orm";',
    "export const store = [k, drizzle];",
  ),
  "packages/design-ui/src/index.ts": lines(
    'import { k } from "@shop/domain-kernel";',
    "export const ui = k;",
  ),
  "packages/design-ui/src/theme.ts": lines(
    'import type { Clock } from "@shop/clock-adapter";',
    "export type Theme = Clock;",
  ),
  "packages/scratch/src/index.ts": "export const s = 1;\n",
  "services/api/src/main.ts": lines(
    'import { clock } from "@shop/clock-adapter";',
    "export const main = clock;",
  ),
  "services/api/src/orders/index.ts": "export const orders = 1;\n",
  "services/api/src/orders/application/place.ts": lines(
    'import { store } from "@shop/db-adapter";',
    "export const place = store;",
  ),
  "services/api/src/orders/adapters/driven/clock.ts": lines(
    'import { clock } from "@shop/clock-adapter";',
    "export const driven = clock;",
  ),
  "services/api/src/billing/index.ts": "export const billing = 1;\n",
  "services/api/src/billing/adapters/driven/db.ts": lines(
    'import { store } from "@shop/db-adapter";',
    "export const db = store;",
  ),
  "services/api/src/billing/adapters/driving/http.ts": lines(
    'import { store } from "@shop/db-adapter";',
    "export const http = store;",
  ),
};

// `[kind, importer or package, target or door]` of each planted crossing, as the report lists it.
export const SHOP_CROSSINGS: readonly (readonly [string, string, string])[] = [
  ["library-undeclared", "packages/scratch", "scratch"],
  ["library-imports-up", "packages/orders-contract/src/index.ts", "packages/domain-kernel"],
  ["library-imports-up", "packages/string-util/src/x.ts", "packages/orders-contract"],
  ["library-imports-up", "packages/clock-adapter/src/index.ts", "packages/db-adapter"],
  ["library-imports-up", "packages/design-ui/src/theme.ts", "packages/clock-adapter"],
  ["impure-library", "packages/orders-contract/src/clock.ts", "Date.now"],
  ["impure-library", "packages/domain-kernel/src/store.ts", "drizzle-orm"],
  ["impure-library", "packages/string-util/src/log.ts", "@sentry/node"],
  ["impure-library", "packages/orders-contract/src/types.ts", "hono"],
  ["adapter-library-imported-outside-driven", "services/api/src/main.ts", "packages/clock-adapter"],
  [
    "adapter-library-imported-outside-driven",
    "services/api/src/orders/application/place.ts",
    "packages/db-adapter",
  ],
  [
    "adapter-library-imported-outside-driven",
    "services/api/src/billing/adapters/driving/http.ts",
    "packages/db-adapter",
  ],
];
