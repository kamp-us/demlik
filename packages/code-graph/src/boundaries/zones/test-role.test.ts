import { afterEach, describe, expect, it } from "vitest";
import { type BoundaryRepo, boundaryRepo } from "../../test-helpers/boundary-repo.js";
import { crossingsOf, ledgerOf, sorted } from "../../test-helpers/library-report.js";
import { SHOP_TYPES, shopManifests } from "../../test-helpers/shop-workspace.js";
import type { BoundaryKind, BoundaryViolation } from "../violation.js";
import { isTestFile, judgedInTestFile } from "./test-role.js";

// One sample verdict per kind. `satisfies Record<BoundaryKind, …>` fails to compile here for a kind
// the table of `test-role.ts` has a row for and this list lacks, as it does there.
const sample = (kind: string): BoundaryViolation =>
  ({ kind, from: "a.ts", to: null, specifier: "x", typeOnly: false }) as BoundaryViolation;
const SAMPLES = {
  "cross-feature": sample("cross-feature"),
  "impure-rules": sample("impure-rules"),
  "lib-imports-feature": sample("lib-imports-feature"),
  "outside-imports-feature-internal": sample("outside-imports-feature-internal"),
  "door-outside-owner": sample("door-outside-owner"),
  "application-imports-adapter": sample("application-imports-adapter"),
  "impure-application": sample("impure-application"),
  "driving-reaches-driven": sample("driving-reaches-driven"),
  "door-outside-driven-adapter": sample("door-outside-driven-adapter"),
  "unknown-zone": sample("unknown-zone"),
  "library-undeclared": sample("library-undeclared"),
  "library-imports-up": sample("library-imports-up"),
  "impure-library": sample("impure-library"),
  "adapter-library-imported-outside-driven": sample("adapter-library-imported-outside-driven"),
  "index-not-exports-only": sample("index-not-exports-only"),
  "application-import-outside-allowlist": sample("application-import-outside-allowlist"),
  "binding-outside-driven-adapter": sample("binding-outside-driven-adapter"),
  "worker-call-cycle": sample("worker-call-cycle"),
  "relative-import-crosses-workspace": sample("relative-import-crosses-workspace"),
} as const satisfies Record<BoundaryKind, BoundaryViolation>;

describe("the table of kinds a test file is judged by", () => {
  it("keeps B1-B5, B11, B12, B14, B18 and B19, and drops B6-B10, B13, B15, B16 and B17", () => {
    const kept = judgedInTestFile(Object.values(SAMPLES)).map((v) => v.kind);
    expect(kept).toEqual([
      "cross-feature",
      "impure-rules",
      "lib-imports-feature",
      "outside-imports-feature-internal",
      "door-outside-owner",
      "library-undeclared",
      "library-imports-up",
      "adapter-library-imported-outside-driven",
      "worker-call-cycle",
      "relative-import-crosses-workspace",
    ]);
  });

  it("matches a glob against the scope-relative path", () => {
    const tests = [/^.*\.test\.ts$/, /^test\//];
    expect(isTestFile(tests, "src/orders/orders.test.ts")).toBe(true);
    expect(isTestFile(tests, "test/e2e.ts")).toBe(true);
    expect(isTestFile(tests, "src/orders/orders.spec.ts")).toBe(false);
    expect(isTestFile([], "src/orders/orders.test.ts")).toBe(false);
  });
});

const API = "services/api";
const LEGACY = "services/legacy";
const at = (rel: string): string => `${API}/${rel}`;

// Every kind that judges a test file or not, as one snippet in one place. A snippet is written
// twice, as `<name>.test.ts` (a test) and `<name>.spec.ts` (no glob matches it), so the second is
// judged like source and the first only by the kinds the table keeps.
type Case = {
  readonly kind: BoundaryKind;
  readonly dir: string;
  readonly body: string;
  readonly inTests: boolean;
  readonly scope?: string;
};

const CASES: readonly Case[] = [
  {
    kind: "application-imports-adapter",
    dir: "src/orders/application",
    body: 'import { db } from "../adapters/driven/db";\nexport const x = db;\n',
    inTests: false,
  },
  {
    kind: "impure-application",
    dir: "src/orders/application",
    body: "export const x = Date.now();\n",
    inTests: false,
  },
  {
    kind: "driving-reaches-driven",
    dir: "src/orders/adapters/driving",
    body: 'import { use } from "../../application/use";\nexport const x = use;\n',
    inTests: false,
  },
  {
    kind: "door-outside-driven-adapter",
    dir: "src/orders/adapters/driving",
    body: 'export const x = () => console.log("x");\n',
    inTests: false,
  },
  {
    kind: "unknown-zone",
    dir: "src/orders",
    body: "export const x = 1;\n",
    inTests: false,
  },
  {
    kind: "impure-library",
    scope: "packages/util",
    dir: "src",
    body: "export const x = Date.now();\n",
    inTests: false,
  },
  {
    kind: "binding-outside-driven-adapter",
    dir: "src/orders/application",
    body: 'export const x = (env: Env) => env.CACHE.get("k");\n',
    inTests: false,
  },
  {
    kind: "cross-feature",
    dir: "src/orders/application",
    body: 'import { charge } from "../../billing/application/charge";\nexport const x = charge;\n',
    inTests: true,
  },
  {
    kind: "outside-imports-feature-internal",
    dir: "src",
    body: 'import { use } from "./orders/application/use";\nexport const x = use;\n',
    inTests: true,
  },
  {
    kind: "door-outside-owner",
    dir: "src/orders/adapters/driven",
    body: "export const x = process.env.MODE;\n",
    inTests: true,
  },
  {
    kind: "library-imports-up",
    scope: "packages/util",
    dir: "src",
    body: 'import { id } from "@shop/orders-contract";\nexport const x = id;\n',
    inTests: true,
  },
  {
    kind: "adapter-library-imported-outside-driven",
    dir: "src/orders/application",
    body: 'import { connect } from "@shop/db-adapter";\nexport const x = connect;\n',
    inTests: true,
  },
  {
    kind: "relative-import-crosses-workspace",
    dir: "src/orders/application",
    body: 'import { id } from "../../../../../packages/orders-contract/src/index";\nexport const x = id;\n',
    inTests: true,
  },
  {
    kind: "impure-rules",
    scope: LEGACY,
    dir: "src/cart/rules",
    body: 'import { db } from "../store/db";\nexport const x = db;\n',
    inTests: true,
  },
  {
    kind: "lib-imports-feature",
    scope: LEGACY,
    dir: "src/lib",
    body: 'import { db } from "../cart/store/db";\nexport const x = db;\n',
    inTests: true,
  },
];

const SUPPORT: Record<string, string> = {
  ...shopManifests([
    API,
    LEGACY,
    "packages/util",
    "packages/orders-contract",
    "packages/db-adapter",
  ]),
  [`${API}/wrangler.jsonc`]: JSON.stringify({ name: "api", kv_namespaces: [{ binding: "CACHE" }] }),
  [at("src/orders/index.ts")]: "export {};\n",
  [at("src/orders/application/use.ts")]: "export const use = 1;\n",
  [at("src/orders/adapters/driven/db.ts")]: "export const db = 1;\n",
  [at("src/orders/adapters/driven/env.ts")]: "export const mode = process.env.MODE;\n",
  [at("src/billing/index.ts")]: "export {};\n",
  [at("src/billing/application/charge.ts")]: "export const charge = 1;\n",
  "packages/util/src/index.ts": "export const util = 1;\n",
  "packages/orders-contract/src/index.ts": "export const id = 1;\n",
  "packages/db-adapter/src/index.ts": "export const connect = 1;\n",
  [`${LEGACY}/src/cart/index.ts`]: "export {};\n",
  [`${LEGACY}/src/cart/store/db.ts`]: "export const db = 1;\n",
};

const RULES = {
  features: { [API]: ["orders", "billing"], [LEGACY]: ["cart"] },
  layout: { [LEGACY]: "rules" },
  libraryTypes: SHOP_TYPES,
  libraries: {
    "packages/util": "util",
    "packages/orders-contract": "contract",
    "packages/db-adapter": "adapter",
  },
  doors: { [API]: { "process.env": ["src/orders/adapters/driven/env.ts"] } },
  acrossDeployables: ["binding-outside-driven-adapter", "relative-import-crosses-workspace"],
  testFiles: ["**/*.test.ts"],
};

const pathOf = (c: Case, name: string): string => `${c.scope ?? API}/${c.dir}/${c.kind}.${name}.ts`;

function files(): Record<string, string> {
  const written = CASES.flatMap((c) => [
    [pathOf(c, "test"), c.body],
    [pathOf(c, "spec"), c.body],
  ]);
  return { ...SUPPORT, ...Object.fromEntries(written) };
}

let repo: BoundaryRepo | null = null;
afterEach(() => repo?.dispose());

function listed(rules: Record<string, unknown>): string[][] {
  repo = boundaryRepo(".", files(), rules);
  return crossingsOf(repo.run({ json: true })).map(([kind, from]) => [kind ?? "", from ?? ""]);
}

// What the cases make a run list: each snippet once as a spec, and as a test only where its kind
// still judges one.
function expected(testRole: boolean): string[][] {
  return sorted(
    CASES.flatMap((c) => [
      [c.kind, pathOf(c, "spec")],
      ...(!testRole || c.inTests ? [[c.kind, pathOf(c, "test")]] : []),
    ]),
  );
}

describe("a file the testFiles globs match is zone-neutral", () => {
  it("judges a test by the kinds the table keeps, and a file no glob matches like source", () => {
    expect(listed(RULES)).toEqual(expected(true));
  });

  it("behaves as it does today without testFiles: every kind judges every file", () => {
    const { testFiles: _tests, ...without } = RULES;
    expect(listed(without)).toEqual(expected(false));
  });

  it("leaves a test beside a feature's index.ts out of B10, and keeps the entry for a source file", () => {
    repo = boundaryRepo(
      ".",
      {
        ...SUPPORT,
        [at("src/orders/orders.test.ts")]: "export const t = 1;\n",
        [at("src/orders/helpers.ts")]: "export const h = 1;\n",
      },
      RULES,
    );
    expect(crossingsOf(repo.run({ json: true }))).toEqual([
      ["unknown-zone", at("src/orders/helpers.ts"), "helpers.ts"],
    ]);
  });

  it("makes an entry holding only test files no B10 entry, and holding one source file an entry", () => {
    const only = { [at("src/orders/domain/a.test.ts")]: "export {};\n" };
    repo = boundaryRepo(".", { ...SUPPORT, ...only }, RULES);
    expect(crossingsOf(repo.run({ json: true }))).toEqual([]);
    repo.dispose();
    const mixed = { ...only, [at("src/orders/domain/b.ts")]: "export {};\n" };
    repo = boundaryRepo(".", { ...SUPPORT, ...mixed }, RULES);
    expect(crossingsOf(repo.run({ json: true }))).toEqual([
      ["unknown-zone", at("src/orders/domain"), "domain"],
    ]);
  });

  it("matches a glob against the scope-relative path, in a feature scope and in a library", () => {
    const body = "export const x = Date.now();\n";
    const written = {
      ...SUPPORT,
      [at("src/orders/application/a.spec.ts")]: body,
      [at("src/orders/application/b.ts")]: body,
      "packages/util/src/clock.mock.ts": body,
      "packages/util/src/clock.ts": body,
    };
    const globs = ["src/orders/application/*.spec.ts", "src/*.mock.ts"];
    repo = boundaryRepo(".", written, { ...RULES, testFiles: globs });
    expect(crossingsOf(repo.run({ json: true }))).toEqual([
      ["impure-application", at("src/orders/application/b.ts"), "Date.now"],
      ["impure-library", "packages/util/src/clock.ts", "Date.now"],
    ]);
  });

  it("records a test file's remaining crossings in the ledger like any other", () => {
    const crossFeature = CASES.find((c) => c.kind === "cross-feature") as Case;
    repo = boundaryRepo(".", files(), RULES);
    expect(repo.run({ acceptCrossings: true, reason: "legacy" }).code).toBe(0);
    expect(ledgerOf(repo).entries.map((e) => [e.kind, e.from])).toEqual(
      expect.arrayContaining([["cross-feature", pathOf(crossFeature, "test")]]),
    );
    expect(repo.run({ ci: true }).code).toBe(0);
  });
});
