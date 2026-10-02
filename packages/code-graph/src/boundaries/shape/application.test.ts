import { afterEach, describe, expect, it } from "vitest";
import { apiRepo, at } from "../../test-helpers/api-repo.js";
import type { BoundaryRepo } from "../../test-helpers/boundary-repo.js";
import { SHOP_TYPES, shopManifests } from "../../test-helpers/shop-workspace.js";
import type { BoundaryViolation } from "../violation.js";

const B16 = "application-import-outside-allowlist";
const USE = "src/orders/application/use.ts";

const LIBRARIES = {
  "packages/orders-contract": "contract",
  "packages/string-util": "util",
  "packages/design-ui": "ui",
  "packages/db-adapter": "adapter",
};
const RULES = {
  libraryTypes: SHOP_TYPES,
  libraries: LIBRARIES,
  applicationShape: [B16],
  applicationMayImport: ["contract", "kernel", "util"],
  pureDependencies: ["zod"],
};
// A package no library names, beside the declared ones.
const PACKAGES = shopManifests([...Object.keys(LIBRARIES), "packages/stray"]);

// The files a use case could import, each its own kind of target.
const TARGETS: Record<string, string> = {
  "src/orders/ports.ts": "export type Port = unknown;\n",
  "src/orders/index.ts": 'export type { Port } from "./ports";\n',
  "src/orders/helpers.ts": "export const helper = 1;\n",
  "src/orders/application/helpers.ts": "export const helper = 1;\n",
  "src/orders/adapters/driven/db.ts": "export const db = 1;\n",
  "src/billing/index.ts": "export {};\n",
  "src/billing/application/charge.ts": "export const charge = 1;\n",
  "src/lib/format.ts": "export const format = 1;\n",
  "src/generated/client.ts": "export const client = 1;\n",
};

let repo: BoundaryRepo | null = null;
afterEach(() => repo?.dispose());

type Row = [kind: string, to: string | null, specifier: string, typeOnly: boolean];

// What the run lists for `use.ts`, whatever the kind.
function judge(source: string, rules: Record<string, unknown> = {}): Row[] {
  repo = apiRepo({ ...TARGETS, [USE]: source }, { ...RULES, ...rules }, PACKAGES);
  const report = JSON.parse(repo.run({ json: true }).stdout) as {
    scopes: { violations: (BoundaryViolation & { to: string | null })[] }[];
  };
  return report.scopes
    .flatMap((scope) => scope.violations)
    .filter((v) => v.from === at(USE))
    .map((v) => [v.kind, v.to, v.specifier, v.typeOnly]);
}

const outside = (specifier: string, to: string | null = null, typeOnly = false): Row => [
  B16,
  to,
  specifier,
  typeOnly,
];

describe("B16 judges what an application/ file imports against an allowlist", () => {
  it.each([
    ["its own ports.ts", 'import type { Port } from "../ports";\nexport type P = Port;\n'],
    ["its own application/", 'import { helper } from "./helpers";\nexport const h = helper;\n'],
    ["another feature's index.ts", 'import {} from "../../billing/index";\n'],
    ["a lib folder", 'import { format } from "../../lib/format";\nexport const f = format;\n'],
    [
      "a library of a listed type",
      'import { orderId } from "@shop/orders-contract";\nexport const o = orderId;\n',
    ],
    [
      "that library by a subpath",
      'import { x } from "@shop/orders-contract/sub";\nexport const o = x;\n',
    ],
    ["a pureDependencies package", 'import { z } from "zod";\nexport const o = z;\n'],
    ["that package by a subpath", 'import { z } from "zod/v4";\nexport const o = z;\n'],
    ["nothing at all", "export const o = 1;\n"],
  ])("allows %s", (_, source) => {
    expect(judge(source)).toEqual([]);
  });

  it.each([
    [
      "an ORM",
      'import { drizzle } from "drizzle-orm";\nexport const o = drizzle;\n',
      outside("drizzle-orm"),
    ],
    [
      "an HTTP framework",
      'import { Hono } from "hono";\nexport const o = Hono;\n',
      outside("hono"),
    ],
    [
      "an SDK",
      'import * as Sentry from "@sentry/node";\nexport const o = Sentry;\n',
      outside("@sentry/node"),
    ],
    [
      "a generated file outside every feature and lib",
      'import { client } from "../../generated/client";\nexport const o = client;\n',
      outside("../../generated/client", at("src/generated/client.ts")),
    ],
    [
      "an undeclared workspace package",
      'import { x } from "@shop/stray";\nexport const o = x;\n',
      outside("@shop/stray"),
    ],
    [
      "a library whose type is not listed",
      'import { Button } from "@shop/design-ui";\nexport const o = Button;\n',
      outside("@shop/design-ui"),
    ],
    [
      "its own feature's index.ts",
      'import type { Port } from "../index";\nexport type P = Port;\n',
      outside("../index", at("src/orders/index.ts"), true),
    ],
    [
      "an entry of its own feature that no zone names",
      'import { helper } from "../helpers";\nexport const o = helper;\n',
      outside("../helpers", at("src/orders/helpers.ts")),
    ],
    [
      "a path the scope does not load",
      'import { x } from "./missing";\nexport const o = x;\n',
      outside("./missing"),
    ],
    [
      "a type-only import, which names the technology",
      'import type { D1Database } from "@cloudflare/workers-types";\nexport type D = D1Database;\n',
      outside("@cloudflare/workers-types", null, true),
    ],
    [
      "a node: builtin that is no door",
      'import { join } from "node:path";\nexport const o = join;\n',
      outside("node:path"),
    ],
  ])("reports %s as one entry", (_, source, row) => {
    expect(judge(source)).toEqual([row]);
  });

  it("makes two imports of one target one entry: the first specifier of the file's edges, type-only when all are", () => {
    expect(
      judge('import { a } from "hono";\nimport type { B } from "hono";\nexport const o = [a];\n'),
    ).toEqual([outside("hono")]);
    expect(
      judge(
        'import type { B } from "hono";\nimport type { C } from "hono";\nexport type O = [B, C];\n',
      ),
    ).toEqual([outside("hono", null, true)]);
    expect(
      judge(
        'import { a } from "../../generated/client";\nimport { b } from "../../generated/../generated/client";\nexport const o = [a, b];\n',
      ),
    ).toEqual([outside("../../generated/../generated/client", at("src/generated/client.ts"))]);
  });

  it("judges each specifier of a package: a subpath is its own entry", () => {
    expect(judge('import "drizzle-orm";\nimport "drizzle-orm/d1";\n')).toEqual([
      outside("drizzle-orm"),
      outside("drizzle-orm/d1"),
    ]);
  });

  it("judges export-from and dynamic imports as imports", () => {
    expect(judge('export { x } from "hono";\nexport const o = import("drizzle-orm");\n')).toEqual([
      outside("drizzle-orm"),
      outside("hono"),
    ]);
  });

  it("allows no library when the rules file names none in applicationMayImport", () => {
    const source = 'import { orderId } from "@shop/orders-contract";\nexport const o = orderId;\n';
    expect(judge(source, { applicationMayImport: [] })).toEqual([outside("@shop/orders-contract")]);
  });
});

describe("one import, one verdict: another kind's import is that kind's alone", () => {
  it("leaves another feature's internals to B1", () => {
    expect(
      judge(
        'import { charge } from "../../billing/application/charge";\nexport const o = charge;\n',
      ),
    ).toEqual([
      [
        "cross-feature",
        at("src/billing/application/charge.ts"),
        "../../billing/application/charge",
        false,
      ],
    ]);
  });

  it("leaves the feature's own adapters/ to B6", () => {
    expect(judge('import { db } from "../adapters/driven/db";\nexport const o = db;\n')).toEqual([
      [
        "application-imports-adapter",
        at("src/orders/adapters/driven/db.ts"),
        "../adapters/driven/db",
        false,
      ],
    ]);
  });

  it("leaves an adapter library imported outside a driven adapter to B14", () => {
    expect(
      judge('import { connect } from "@shop/db-adapter";\nexport const o = connect;\n'),
    ).toEqual([
      ["adapter-library-imported-outside-driven", "packages/db-adapter", "@shop/db-adapter", false],
    ]);
  });

  it("leaves a module door opened at run time to B7, and judges a type-only one itself", () => {
    expect(
      judge('import { readFileSync } from "node:fs";\nexport const o = readFileSync;\n'),
    ).toEqual([["impure-application", null, "node:fs", false]]);
    expect(judge('import type { Stats } from "node:fs";\nexport type S = Stats;\n')).toEqual([
      outside("node:fs", null, true),
    ]);
    expect(judge('import { type Stats } from "node:fs";\nexport type S = Stats;\n')).toEqual([
      outside("node:fs"),
    ]);
  });
});

describe("B16 runs only where it is asked to", () => {
  const SOURCE = 'import { drizzle } from "drizzle-orm";\nexport const o = drizzle;\n';
  const NARROWING = { applicationMayImport: [], pureDependencies: [] };

  it("never runs while the kind is not listed", () => {
    expect(judge(SOURCE, { ...NARROWING, applicationShape: [] })).toEqual([]);
    repo?.dispose();
    const other = { ...NARROWING, applicationShape: ["index-not-exports-only"] };
    expect(judge(SOURCE, other)).toEqual([]);
  });

  it("never runs in a rules-layout feature", () => {
    expect(judge(SOURCE, { layout: {} })).toEqual([]);
  });

  it.each([
    "src/orders/adapters/driven/x.ts",
    "src/orders/adapters/driving/x.ts",
    "src/orders/ports.ts",
    "src/orders/index.ts",
    "src/lib/x.ts",
    "src/x.ts",
  ])("never runs on %s, which is not application/", (file) => {
    repo = apiRepo({ ...TARGETS, [file]: SOURCE }, RULES, PACKAGES);
    const report = JSON.parse(repo.run({ json: true }).stdout) as {
      scopes: { violations: { kind: string; from: string }[] }[];
    };
    const found = report.scopes.flatMap((scope) => scope.violations);
    expect(found.filter((v) => v.kind === B16)).toEqual([]);
  });
});
