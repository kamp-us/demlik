import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveBoundaryRules } from "../config.js";
import { type BoundaryRepo, boundaryRepo, type GateRun } from "../test-helpers/boundary-repo.js";
import { type BoundaryViolation, isDoorUse } from "./analyze.js";
import { type BoundaryLedger, ledgerTargetOf, readBoundaryLedger } from "./ledger.js";
import { MIGRATED_REASON } from "./migrate.js";

const SCOPE = "services/svc";

const FILES: Record<string, string> = {
  "tsconfig.json": JSON.stringify({
    compilerOptions: { module: "esnext", moduleResolution: "bundler", strict: true },
    include: ["src"],
  }),
  "src/audit-runs/index.ts": "export { save } from './store/db.js';\n",
  "src/audit-runs/store/db.ts": "export const save = 1;\n",
  "src/findings/index.ts": "export { run } from './flows/run.js';\n",
  "src/findings/store/repo.ts": "export const repo = 1;\n",
  "src/findings/flows/run.ts": [
    "import { save } from '../../audit-runs/index.js';",
    "import { save as raw } from '../../audit-runs/store/db.js';",
    "import { repo } from '../store/repo.js';",
    "export const run = save + raw + repo;",
  ].join("\n"),
  "src/findings/rules/helper.ts": "export const helper = 1;\n",
  "src/findings/rules/score.ts": [
    "import { helper } from './helper.js';",
    "import type { Wire } from '@acme/wire-contract';",
    "import { repo } from '../store/repo.js';",
    "import { z } from 'zod';",
    "export const score = helper + repo;",
    "export type W = Wire | typeof z;",
  ].join("\n"),
  "src/lib/util.ts": "import { run } from '../findings/index.js';\nexport const util = run;\n",
  "src/index.ts": "import { repo } from './findings/store/repo.js';\nexport const entry = repo;\n",
};

const RULES = {
  features: { [SCOPE]: ["audit-runs", "findings"] },
  lib: ["lib"],
  contracts: ["@acme/wire-contract"],
};

function ledgerOf(repo: BoundaryRepo): BoundaryLedger {
  const read = readBoundaryLedger(repo.ledgerFile);
  if (read.kind !== "read") throw new Error(`expected a readable ledger, got ${read.kind}`);
  return read.ledger;
}

describe("analyzeBoundaries over a real fixture's import edges", () => {
  let repo: BoundaryRepo;
  beforeAll(() => {
    repo = boundaryRepo(SCOPE, FILES, RULES);
  });
  afterAll(() => repo.dispose());

  const violations = (): BoundaryViolation[] => {
    const parsed: { scopes: { violations: BoundaryViolation[] }[] } = JSON.parse(
      repo.run({ json: true }).stdout,
    );
    return parsed.scopes.flatMap((s) => s.violations);
  };

  it("reports each kind once, at the edge that crosses", () => {
    expect(violations().map((v) => [v.kind, v.from, v.specifier])).toEqual([
      ["cross-feature", "services/svc/src/findings/flows/run.ts", "../../audit-runs/store/db.js"],
      ["impure-rules", "services/svc/src/findings/rules/score.ts", "../store/repo.js"],
      ["impure-rules", "services/svc/src/findings/rules/score.ts", "zod"],
      ["lib-imports-feature", "services/svc/src/lib/util.ts", "../findings/index.js"],
      ["outside-imports-feature-internal", "services/svc/src/index.ts", "./findings/store/repo.js"],
    ]);
  });

  it("allows another feature's index.ts, the same feature, rules/ siblings and contracts", () => {
    const found = violations();
    const specifiers = found.map((v) => v.specifier);
    expect(specifiers).not.toContain("../../audit-runs/index.js");
    expect(found.filter((v) => v.from.endsWith("flows/run.ts"))).toHaveLength(1);
    expect(specifiers).not.toContain("./helper.js");
    expect(specifiers).not.toContain("@acme/wire-contract");
  });

  it("judges a file outside every feature and lib: a feature's internal file is B4", () => {
    expect(violations().filter((v) => v.from.endsWith("svc/src/index.ts"))).toEqual([
      {
        kind: "outside-imports-feature-internal",
        from: "services/svc/src/index.ts",
        to: "services/svc/src/findings/store/repo.ts",
        toFeature: "findings",
        specifier: "./findings/store/repo.js",
        typeOnly: false,
      },
    ]);
  });

  it("renders the human view one line per violation, tagged with its rule", () => {
    const { code, stdout } = repo.run();
    expect(code).toBe(0);
    expect(stdout).toContain("services/svc — features: audit-runs, findings");
    expect(stdout).toContain(
      "B1 cross-feature       services/svc/src/findings/flows/run.ts -> services/svc/src/audit-runs/store/db.ts",
    );
    expect(stdout).toContain(
      "B2 impure-rules        services/svc/src/findings/rules/score.ts -> zod",
    );
    expect(stdout).toContain(
      "B4 outside-imports-feature-internal services/svc/src/index.ts -> services/svc/src/findings/store/repo.ts" +
        '  ("./findings/store/repo.js")',
    );
  });

  it("reports nothing when no scope declares features", () => {
    const empty = path.join(repo.root, "empty.json");
    fs.writeFileSync(empty, "{}");
    const { code, stdout } = repo.run({ rules: empty });
    expect(code).toBe(0);
    expect(stdout).toContain("nothing to check");
  });
});

describe("the boundary ledger records each crossing and fails only when one is new", () => {
  let repo: BoundaryRepo;
  beforeEach(() => {
    repo = boundaryRepo(SCOPE, FILES, RULES);
  });
  afterEach(() => repo.dispose());

  const accept = (reason = "known debt") => repo.run({ acceptCrossings: true, reason });

  it("writes one entry per crossing, keyed and sorted, and the gate passes on it", () => {
    expect(accept().code).toBe(0);
    const text = fs.readFileSync(repo.ledgerFile, "utf8");
    const { entries } = ledgerOf(repo);
    expect(entries.map((e) => [e.kind, e.from, e.to ?? e.specifier])).toEqual([
      [
        "cross-feature",
        "services/svc/src/findings/flows/run.ts",
        "services/svc/src/audit-runs/store/db.ts",
      ],
      [
        "impure-rules",
        "services/svc/src/findings/rules/score.ts",
        "services/svc/src/findings/store/repo.ts",
      ],
      ["impure-rules", "services/svc/src/findings/rules/score.ts", "zod"],
      ["lib-imports-feature", "services/svc/src/lib/util.ts", "services/svc/src/findings/index.ts"],
      [
        "outside-imports-feature-internal",
        "services/svc/src/index.ts",
        "services/svc/src/findings/store/repo.ts",
      ],
    ]);
    expect(entries.find((e) => e.specifier === "zod")).toEqual({
      scope: SCOPE,
      kind: "impure-rules",
      from: "services/svc/src/findings/rules/score.ts",
      to: null,
      specifier: "zod",
      reason: "known debt",
    });

    const { code, stdout } = repo.run({ ci: true });
    expect(code).toBe(0);
    expect(stdout).toContain("boundary ledger: PASS — 1 scope(s), 5 recorded crossing(s)");
    expect(fs.readFileSync(repo.ledgerFile, "utf8")).toBe(text);
  });

  it("fails on a crossing the ledger does not name, listing it", () => {
    accept();
    const kept = ledgerOf(repo).entries.filter((e) => e.kind !== "lib-imports-feature");
    fs.writeFileSync(repo.ledgerFile, JSON.stringify({ entries: kept }));
    const { code, stdout } = repo.run({ ci: true });
    expect(code).toBe(1);
    expect(stdout).toContain("BOUNDARY LEDGER FAILED — 1 crossing(s) not in boundary-ledger.json");
    expect(stdout).toContain(
      "services/svc  B3 lib-imports-feature  services/svc/src/lib/util.ts -> " +
        'services/svc/src/findings/index.ts  ("../findings/index.js")',
    );
    expect(stdout).toContain("--accept-crossings");
  });

  it("fails a change that removes one crossing and adds a different one in the same scope", () => {
    accept();
    repo.put("src/lib/util.ts", "export const util = 1;\n");
    repo.put(
      "src/lib/clock.ts",
      "import { save } from '../audit-runs/store/db.js';\nexport const clock = save;\n",
    );
    const { code, stdout } = repo.run({ ci: true, json: true });
    expect(code).toBe(1);
    const verdict: { unrecorded: { from: string }[]; pruned: { from: string }[] } =
      JSON.parse(stdout);
    expect(verdict.unrecorded.map((e) => e.from)).toEqual(["services/svc/src/lib/clock.ts"]);
    expect(verdict.pruned.map((e) => e.from)).toEqual(["services/svc/src/lib/util.ts"]);
    expect(ledgerOf(repo).entries).toHaveLength(4);
  });

  it("never fails on an entry whose crossing is gone: it prunes it and says so", () => {
    accept();
    const outOfReach = {
      scope: "services/other",
      kind: "cross-feature",
      from: "services/other/src/a/x.ts",
      to: "services/other/src/b/y.ts",
      specifier: "../b/y.js",
    };
    const stale = { ...outOfReach, scope: SCOPE, from: "services/svc/src/gone.ts" };
    fs.writeFileSync(
      repo.ledgerFile,
      JSON.stringify({ entries: [...ledgerOf(repo).entries, stale, outOfReach] }),
    );
    repo.put("src/index.ts", "export const entry = 1;\n");

    const { code, stdout } = repo.run({ ci: true });
    expect(code).toBe(0);
    expect(stdout).toContain("pruned 2 boundary-ledger.json entries whose crossing is gone:");
    expect(stdout).toContain("services/svc/src/gone.ts -> services/other/src/b/y.ts");
    expect(stdout).toContain("B4 outside-imports-feature-internal  services/svc/src/index.ts");
    const froms = ledgerOf(repo).entries.map((e) => e.from);
    expect(froms).not.toContain("services/svc/src/gone.ts");
    expect(froms).not.toContain("services/svc/src/index.ts");
    expect(froms).toContain("services/other/src/a/x.ts");
    expect(repo.run({ ci: true }).stdout).not.toContain("pruned");
  });

  it("refuses --accept-crossings without a non-empty --reason, writing nothing", () => {
    for (const reason of [undefined, "", "   "]) {
      const { code, errors } = repo.run({ acceptCrossings: true, reason });
      expect(code).toBe(2);
      expect(errors.join("\n")).toContain("--reason");
    }
    expect(fs.existsSync(repo.ledgerFile)).toBe(false);
  });

  it("adds only the unrecorded crossings, each with the reason given", () => {
    accept("first");
    repo.put(
      "src/lib/clock.ts",
      "import { save } from '../audit-runs/store/db.js';\nexport const clock = save;\n",
    );
    expect(repo.run({ ci: true }).code).toBe(1);
    const { code, stdout } = accept("clock reads the store until #1");
    expect(code).toBe(0);
    expect(stdout).toContain("accepted 1 crossing(s)");
    const reasons = ledgerOf(repo).entries.map((e) => [e.from, e.reason]);
    expect(reasons).toContainEqual([
      "services/svc/src/lib/clock.ts",
      "clock reads the store until #1",
    ]);
    expect(reasons.filter(([, r]) => r === "first")).toHaveLength(5);
    expect(repo.run({ ci: true }).code).toBe(0);
  });

  it("retires --boundaries --write-ceilings, naming --accept-crossings", () => {
    const { code, errors } = repo.run({ writeCeilings: true });
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("--accept-crossings");
    expect(fs.existsSync(repo.ledgerFile)).toBe(false);
    expect(fs.existsSync(repo.legacyFile)).toBe(false);
  });

  it("refuses --reason without --accept-crossings and two modes at once", () => {
    expect(repo.run({ ci: true, reason: "x" }).code).toBe(2);
    expect(repo.run({ ci: true, migrateCeilings: true }).code).toBe(2);
  });

  it("refuses a ledger that repeats an identity", () => {
    accept();
    const [first] = ledgerOf(repo).entries;
    fs.writeFileSync(
      repo.ledgerFile,
      JSON.stringify({ entries: [first, { ...first, specifier: "./other.js" }] }),
    );
    const { code, errors } = repo.run({ ci: true });
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("duplicate entry");
  });
});

describe("--migrate-ceilings seeds the ledger from the count file without loosening it", () => {
  let repo: BoundaryRepo;
  beforeEach(() => {
    repo = boundaryRepo(SCOPE, FILES, RULES);
  });
  afterEach(() => repo.dispose());

  const recordCount = (count: number) =>
    fs.writeFileSync(repo.legacyFile, JSON.stringify({ default: 0, scopes: { [SCOPE]: count } }));

  it("refuses the gate while only the count file stands, naming --migrate-ceilings", () => {
    recordCount(5);
    for (const flags of [{ ci: true }, { acceptCrossings: true, reason: "x" }]) {
      const { code, errors } = repo.run(flags);
      expect(code).toBe(2);
      expect(errors.join("\n")).toContain("--migrate-ceilings");
    }
    expect(fs.existsSync(repo.ledgerFile)).toBe(false);
  });

  it("seeds one entry per current crossing, deletes the count file, and then gates", () => {
    recordCount(6);
    const { code, stdout } = repo.run({ migrateCeilings: true });
    expect(code).toBe(0);
    expect(stdout).toContain("seeded boundary-ledger.json with 5 crossing(s)");
    expect(fs.existsSync(repo.legacyFile)).toBe(false);
    const { entries } = ledgerOf(repo);
    expect(entries).toHaveLength(5);
    expect(new Set(entries.map((e) => e.reason))).toEqual(new Set([MIGRATED_REASON]));
    expect(repo.run({ ci: true }).code).toBe(0);
  });

  it("refuses, writing nothing, when a scope crosses more than its recorded count", () => {
    recordCount(4);
    const before = fs.readFileSync(repo.legacyFile, "utf8");
    const { code, errors } = repo.run({ migrateCeilings: true });
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain(
      "services/svc: 5 crossing(s) against a recorded ceiling of 4",
    );
    expect(fs.existsSync(repo.ledgerFile)).toBe(false);
    expect(fs.readFileSync(repo.legacyFile, "utf8")).toBe(before);
  });

  it("refuses with no count file to migrate, or a ledger already there", () => {
    expect(repo.run({ migrateCeilings: true }).code).toBe(2);
    recordCount(5);
    fs.writeFileSync(repo.ledgerFile, JSON.stringify({ entries: [] }));
    expect(repo.run({ migrateCeilings: true }).code).toBe(2);
    expect(fs.existsSync(repo.legacyFile)).toBe(true);
  });
});

describe("B4 judges an importer outside every declared feature and every lib folder", () => {
  const OUTSIDE_SCOPE = "apps/web";
  const OUTSIDE_FILES: Record<string, string> = {
    "tsconfig.json": JSON.stringify({
      compilerOptions: { module: "esnext", moduleResolution: "bundler", strict: true },
      include: ["src", "scripts"],
    }),
    "src/billing/index.ts": "export { charge } from './flows/charge.js';\n",
    "src/billing/flows/charge.ts":
      "import { price } from '../rules/price.js';\nexport const charge = price;\n",
    "src/billing/rules/price.ts": "export const price = 1;\n",
    "src/billing/store/ledger.ts": "export const ledger = 1;\n",
    "src/main.ts": [
      "import { charge } from './billing/index.js';",
      "import { ledger } from './billing/store/ledger.js';",
      "import { price } from './billing/rules/price.js';",
      "export const main = charge + ledger + price;",
    ].join("\n"),
    "src/lib/clock.ts":
      "import { ledger } from '../billing/store/ledger.js';\nexport const clock = ledger;\n",
    "scripts/seed.ts":
      "import { ledger } from '../src/billing/store/ledger.js';\nexport const seed = ledger;\n",
  };
  let repo: BoundaryRepo;

  const found = (): BoundaryViolation[] => {
    const parsed: { scopes: { violations: BoundaryViolation[] }[] } = JSON.parse(
      repo.run({ json: true }).stdout,
    );
    return parsed.scopes.flatMap((s) => s.violations);
  };

  beforeAll(() => {
    repo = boundaryRepo(OUTSIDE_SCOPE, OUTSIDE_FILES, {
      features: { [OUTSIDE_SCOPE]: ["billing"] },
    });
  });
  afterAll(() => repo.dispose());

  it("allows the feature's index.ts and flags every other file, rules/ included, once per edge", () => {
    expect(found().map((v) => [v.kind, v.from, v.specifier])).toEqual([
      ["lib-imports-feature", "apps/web/src/lib/clock.ts", "../billing/store/ledger.js"],
      [
        "outside-imports-feature-internal",
        "apps/web/scripts/seed.ts",
        "../src/billing/store/ledger.js",
      ],
      ["outside-imports-feature-internal", "apps/web/src/main.ts", "./billing/rules/price.js"],
      ["outside-imports-feature-internal", "apps/web/src/main.ts", "./billing/store/ledger.js"],
    ]);
    expect(found().map((v) => v.specifier)).not.toContain("./billing/index.js");
  });

  it("leaves a lib importer to B3 alone", () => {
    expect(found().filter((v) => v.from.endsWith("src/lib/clock.ts"))).toEqual([
      {
        kind: "lib-imports-feature",
        from: "apps/web/src/lib/clock.ts",
        to: "apps/web/src/billing/store/ledger.ts",
        toFeature: "billing",
        specifier: "../billing/store/ledger.js",
        typeOnly: false,
      },
    ]);
  });

  it("records B4 crossings in the ledger: accepted, passing, then failed by one more edge", () => {
    expect(repo.run({ acceptCrossings: true, reason: "known" }).code).toBe(0);
    expect(ledgerOf(repo).entries).toHaveLength(4);
    expect(repo.run({ ci: true }).code).toBe(0);

    repo.put(
      "src/extra.ts",
      "import { ledger } from './billing/store/ledger.js';\nexport const extra = ledger;\n",
    );
    const { code, stdout } = repo.run({ ci: true });
    expect(code).toBe(1);
    expect(stdout).toContain("apps/web/src/extra.ts");
  });
});

describe("the boundary declaration is parsed at the config boundary", () => {
  let repo: BoundaryRepo;
  beforeAll(() => {
    repo = boundaryRepo(SCOPE, {}, RULES);
  });
  afterAll(() => repo.dispose());

  it("ships an empty feature map and no contract packages by default", () => {
    const defaults = resolveBoundaryRules(undefined, () => {});
    expect(defaults?.features).toEqual({});
    expect(defaults?.contracts).toEqual([]);
  });

  it("refuses a folder declared as both a feature and lib, or a path as a feature", () => {
    const errors: string[] = [];
    const both = path.join(repo.root, "both.json");
    fs.writeFileSync(both, JSON.stringify({ features: { [SCOPE]: ["lib"] } }));
    expect(resolveBoundaryRules(both, (m) => errors.push(m))).toBeNull();
    const nested = path.join(repo.root, "nested.json");
    fs.writeFileSync(nested, JSON.stringify({ features: { [SCOPE]: ["a/b"] } }));
    expect(resolveBoundaryRules(nested, (m) => errors.push(m))).toBeNull();
    expect(errors).toHaveLength(2);
  });
});

const TSCONFIG = JSON.stringify({
  compilerOptions: { module: "esnext", moduleResolution: "bundler", strict: true },
  include: ["src"],
});

const ledgerText = (repo: BoundaryRepo): string => fs.readFileSync(repo.ledgerFile, "utf8");

function violationsOf(run: GateRun): BoundaryViolation[] {
  const parsed: { scopes: { violations: BoundaryViolation[] }[] } = JSON.parse(run.stdout);
  return parsed.scopes.flatMap((s) => s.violations);
}

// `[kind, file under <scope>/src, target under <scope>/src or the door or entry]`.
function crossingsOf(scope: string, run: GateRun): string[][] {
  const root = `${scope}/src/`;
  return violationsOf(run).map((v) => [
    v.kind,
    v.from.replace(root, ""),
    ledgerTargetOf(v).replace(root, ""),
  ]);
}

const entryLines = (stdout: string): string[] =>
  stdout.split("\n").filter((line) => line.startsWith("  services/"));

describe("one scope moves to the hexagonal layout while another stays on rules/", () => {
  const API = "services/api";
  const LEGACY = "services/legacy";
  const FILES: Record<string, string> = {
    [`${API}/tsconfig.json`]: TSCONFIG,
    [`${API}/src/env.ts`]: "export const salt = process.env.SALT;\n",
    [`${API}/src/main.ts`]: [
      "import { charge } from './billing/index.js';",
      "import { stripe } from './billing/adapters/driven/stripe.js';",
      "import { handle } from './orders/adapters/driving/http.js';",
      "import { register } from './users/application/register.js';",
      "export const main = [charge, stripe, handle, register];",
    ].join("\n"),
    [`${API}/src/billing/index.ts`]: "export { charge } from './application/charge.js';\n",
    [`${API}/src/billing/ports.ts`]: "export type Gateway = { pay: (n: number) => number };\n",
    [`${API}/src/billing/application/charge.ts`]: [
      "import type { Gateway } from '../ports.js';",
      "import { z } from 'zod';",
      "import { stripe } from '../adapters/driven/stripe.js';",
      "export const charge = (g: Gateway) => [g, z, stripe, Date.now()];",
    ].join("\n"),
    [`${API}/src/billing/adapters/driving/webhook.ts`]:
      "import { charge } from '../../index.js';\nexport const webhook = charge;\n",
    [`${API}/src/billing/adapters/driven/stripe.ts`]:
      'export const stripe = () => fetch("https://stripe.test");\n',
    [`${API}/src/billing/domain/money.ts`]: "export const money = 1;\n",
    [`${API}/src/billing/domain/rate.ts`]: "export const rate = 1;\n",
    [`${API}/src/orders/index.ts`]: "export const flag = process.env.FLAG;\n",
    [`${API}/src/orders/ports.ts`]: "export type Order = { id: string };\n",
    [`${API}/src/orders/application/place.ts`]: [
      "import { handle } from '../adapters/driving/http.js';",
      "import { stripe } from '../../billing/adapters/driven/stripe.js';",
      "export const place = [handle, stripe];",
    ].join("\n"),
    [`${API}/src/orders/adapters/driving/http.ts`]: [
      "import type { Order } from '../../ports.js';",
      "import { flag } from '../../index.js';",
      "import { place } from '../../application/place.js';",
      "export const handle = (order: Order) => {",
      "  console.log(order, flag);",
      "  return place;",
      "};",
    ].join("\n"),
    [`${API}/src/orders/adapters/driven/repo.ts`]: "export const repo = 1;\n",
    [`${API}/src/orders/adapters/shared/retry.ts`]: "export const retry = 1;\n",
    [`${API}/src/users/index.ts`]: "export { register } from './application/register.js';\n",
    [`${API}/src/users/ports.ts`]: "export type User = { id: string };\n",
    [`${API}/src/users/application/register.ts`]:
      "export const register = () => [crypto.randomUUID(), process.env.SALT];\n",
    [`${API}/src/users/adapters/driving/cron.ts`]:
      "import { db } from '../driven/db.js';\nexport const cron = db;\n",
    [`${API}/src/users/adapters/driven/db.ts`]:
      'export const db = () => fetch("https://db.test");\n',
    [`${API}/src/shipping/index.ts`]: "export { quote } from './application/quote.js';\n",
    [`${API}/src/shipping/ports.ts`]: "export type Rate = number;\n",
    [`${API}/src/shipping/application/quote.ts`]:
      'import { readFileSync } from "node:fs";\nexport const quote = readFileSync;\n',
    [`${API}/src/shipping/adapters/driving/rpc.ts`]:
      'export const rpc = () => fetch("https://rpc.test");\n',
    [`${API}/src/shipping/adapters/driven/carrier.ts`]: "export const carrier = 1;\n",
    [`${API}/src/shipping/helpers.ts`]: "export const helper = 1;\n",
    [`${LEGACY}/tsconfig.json`]: TSCONFIG,
    [`${LEGACY}/src/cart/index.ts`]: "export { apply } from './application/apply.js';\n",
    [`${LEGACY}/src/cart/rules/total.ts`]: "export const total = () => Date.now();\n",
    [`${LEGACY}/src/cart/application/apply.ts`]:
      "import { store } from '../adapters/driven/store.js';\nexport const apply = store;\n",
    [`${LEGACY}/src/cart/adapters/driven/store.ts`]: "export const store = 1;\n",
  };
  const RULES = {
    features: { [API]: ["billing", "orders", "users", "shipping"], [LEGACY]: ["cart"] },
    lib: ["lib"],
    layout: { [API]: "hexagonal" },
    doors: {
      [API]: {
        fetch: ["src/billing/adapters/driven/stripe.ts"],
        "process.env": ["src/env.ts"],
      },
    },
  };
  const api = (file: string) => `${API}/src/${file}`;
  const SEVENTEEN = [
    [
      "application-imports-adapter",
      api("billing/application/charge.ts"),
      api("billing/adapters/driven/stripe.ts"),
    ],
    [
      "application-imports-adapter",
      api("orders/application/place.ts"),
      api("orders/adapters/driving/http.ts"),
    ],
    ["cross-feature", api("orders/application/place.ts"), api("billing/adapters/driven/stripe.ts")],
    ["door-outside-driven-adapter", api("orders/index.ts"), "process.env"],
    ["door-outside-driven-adapter", api("shipping/adapters/driving/rpc.ts"), "fetch"],
    ["door-outside-owner", api("users/adapters/driven/db.ts"), "fetch"],
    [
      "driving-reaches-driven",
      api("orders/adapters/driving/http.ts"),
      api("orders/application/place.ts"),
    ],
    [
      "driving-reaches-driven",
      api("users/adapters/driving/cron.ts"),
      api("users/adapters/driven/db.ts"),
    ],
    ["impure-application", api("billing/application/charge.ts"), "Date.now"],
    ["impure-application", api("shipping/application/quote.ts"), "node:fs"],
    ["impure-application", api("users/application/register.ts"), "crypto.randomUUID"],
    ["impure-application", api("users/application/register.ts"), "process.env"],
    ["outside-imports-feature-internal", api("main.ts"), api("users/application/register.ts")],
    ["unknown-zone", api("billing/domain"), "domain"],
    ["unknown-zone", api("orders/adapters/shared"), "adapters/shared"],
    ["unknown-zone", api("shipping/helpers.ts"), "helpers.ts"],
    ["impure-rules", `${LEGACY}/src/cart/rules/total.ts`, "Date.now"],
  ];

  let repo: BoundaryRepo;
  beforeEach(() => {
    repo = boundaryRepo(".", FILES, RULES);
  });
  afterEach(() => repo.dispose());

  const ledgered = () =>
    ledgerOf(repo).entries.map((e) => [e.kind, e.from, ledgerTargetOf(e), e.reason]);

  it("lists exactly the 17 crossings, gates on them, records them, and shrinks as they are fixed", () => {
    const failed = repo.run({ ci: true });
    expect(failed.code).toBe(1);
    expect(entryLines(failed.stdout)).toHaveLength(17);
    expect(failed.stdout).toContain(
      "services/api  B9 door-outside-driven-adapter  services/api/src/orders/index.ts -> process.env\n",
    );
    expect(failed.stdout).toContain(
      "services/api  B7 impure-application  services/api/src/shipping/application/quote.ts -> node:fs\n",
    );
    expect(failed.stdout).toContain(
      "services/api  B6 application-imports-adapter  services/api/src/billing/application/charge.ts" +
        " -> services/api/src/billing/adapters/driven/stripe.ts",
    );
    expect(failed.stdout).toContain(
      "services/api  B10 unknown-zone  services/api/src/billing/domain -> domain\n",
    );
    expect(failed.stdout).toContain("In a hexagonal feature");
    expect(fs.existsSync(repo.ledgerFile)).toBe(false);

    const report = repo.run();
    expect(report.code).toBe(0);
    expect(report.stdout.split("\n").filter((line) => /^ {2}B\d+ /.test(line))).toHaveLength(17);
    expect(
      violationsOf(repo.run({ json: true })).map((v) => [v.kind, v.from, ledgerTargetOf(v)]),
    ).toEqual(SEVENTEEN);

    const reason = "adopting the hexagonal layout";
    expect(repo.run({ acceptCrossings: true, reason }).code).toBe(0);
    expect(ledgered()).toEqual(SEVENTEEN.map((row) => [...row, reason]));
    const seeded = ledgerText(repo);
    const first = repo.run({ ci: true });
    const second = repo.run({ ci: true });
    expect([first.code, second.code]).toEqual([0, 0]);
    expect(second.stdout).toBe(first.stdout);
    expect(first.stdout).toContain("17 recorded crossing(s), none new");
    expect(ledgerText(repo)).toBe(seeded);

    repo.put(
      `${API}/src/users/adapters/driving/cron.ts`,
      [
        "import { db } from '../driven/db.js';",
        "import { register } from '../../application/register.js';",
        "export const cron = [db, register];",
      ].join("\n"),
    );
    const grown = repo.run({ ci: true });
    expect(grown.code).toBe(1);
    expect(entryLines(grown.stdout)).toEqual([
      "  services/api  B8 driving-reaches-driven  services/api/src/users/adapters/driving/cron.ts" +
        ' -> services/api/src/users/application/register.ts  ("../../application/register.js")',
    ]);
    expect(ledgerText(repo)).toBe(seeded);

    expect(repo.run({ acceptCrossings: true, reason: "cron reads users until #1" }).code).toBe(0);
    expect(ledgerOf(repo).entries).toHaveLength(18);
    repo.put(
      `${API}/src/billing/application/charge.ts`,
      [
        "import type { Gateway } from '../ports.js';",
        "import { z } from 'zod';",
        "export const charge = (g: Gateway) => [g, z, Date.now()];",
      ].join("\n"),
    );
    const shrunk = repo.run({ ci: true });
    expect(shrunk.code).toBe(0);
    expect(shrunk.stdout).toContain("pruned 1 boundary-ledger.json entry whose crossing is gone:");
    expect(entryLines(shrunk.stdout)).toEqual([
      "  services/api  B6 application-imports-adapter  services/api/src/billing/application/charge.ts" +
        ' -> services/api/src/billing/adapters/driven/stripe.ts  ("../adapters/driven/stripe.js")' +
        "  — adopting the hexagonal layout",
    ]);
    expect(ledgerOf(repo).entries).toHaveLength(17);
    const pruned = ledgerText(repo);
    expect(repo.run({ ci: true }).code).toBe(0);
    expect(ledgerText(repo)).toBe(pruned);
  });

  it("leaves the scope with no layout on rules/: application/ there is internal", () => {
    const legacy = violationsOf(repo.run({ json: true })).filter((v) => v.from.startsWith(LEGACY));
    expect(legacy.map((v) => [v.kind, v.from, v.specifier])).toEqual([
      ["impure-rules", `${LEGACY}/src/cart/rules/total.ts`, "Date.now"],
    ]);
  });
});

describe("the zones of a hexagonal feature, edge by edge", () => {
  const SCOPE = "packages/app";
  const FILES: Record<string, string> = {
    "tsconfig.json": TSCONFIG,
    "src/billing/index.ts": "export const front = 1;\n",
    "src/billing/ports.ts": "export const port = 1;\n",
    "src/billing/application/clean.ts": [
      "import { port } from '../ports.js';",
      "import { front } from '../index.js';",
      "import { other } from './other.js';",
      "import { users } from '../../users/index.js';",
      "import { util } from '../../lib/util.js';",
      "import { z } from 'zod';",
      "export const clean = [port, front, other, users, util, z];",
    ].join("\n"),
    "src/billing/application/other.ts": "export const other = 1;\n",
    "src/billing/application/disk.ts":
      'import { readFileSync } from "node:fs";\nexport const disk = readFileSync;\n',
    "src/billing/adapters/driven/env.ts": "export const env = process.env.X;\n",
    "src/billing/adapters/driven/files.ts":
      'import { readFileSync } from "node:fs";\nexport const files = readFileSync;\n',
    "src/billing/adapters/driven/leak.ts": "export const leak = process.env.Y;\n",
    "src/billing/adapters/driving/log.ts": 'export const log = () => console.log("x");\n',
    "src/billing/rules/price.ts": "export const price = 1;\n",
    "src/billing/assets/readme.md": "# not source\n",
    "src/users/index.ts": "export const users = 1;\n",
    "src/lib/util.ts": "export const util = 1;\n",
    "src/lib/wire.ts": [
      "import { env } from '../billing/adapters/driven/env.js';",
      "import { log } from '../billing/adapters/driving/log.js';",
      "export const wire = [env, log];",
    ].join("\n"),
    "src/main.ts": [
      "import { log } from './billing/adapters/driving/log.js';",
      "import { env } from './billing/adapters/driven/env.js';",
      "import { other } from './billing/application/other.js';",
      "import { port } from './billing/ports.js';",
      "export const main = [log, env, other, port];",
    ].join("\n"),
  };
  const RULES = {
    features: { [SCOPE]: ["billing", "users"] },
    layout: { [SCOPE]: "hexagonal" },
    doors: {
      [SCOPE]: {
        "process.env": ["src/billing/adapters/driven/env.ts"],
        "node:fs": ["src/billing/adapters/driven/files.ts"],
      },
    },
  };
  let repo: BoundaryRepo;
  beforeAll(() => {
    repo = boundaryRepo(SCOPE, FILES, RULES);
  });
  afterAll(() => repo.dispose());

  it("judges each zone by its own rule and nothing else", () => {
    expect(crossingsOf(SCOPE, repo.run({ json: true }))).toEqual([
      ["door-outside-owner", "billing/adapters/driven/leak.ts", "process.env"],
      ["impure-application", "billing/application/disk.ts", "node:fs"],
      ["lib-imports-feature", "lib/wire.ts", "billing/adapters/driven/env.ts"],
      ["lib-imports-feature", "lib/wire.ts", "billing/adapters/driving/log.ts"],
      ["outside-imports-feature-internal", "main.ts", "billing/application/other.ts"],
      ["outside-imports-feature-internal", "main.ts", "billing/ports.ts"],
      ["unknown-zone", "billing/rules", "rules"],
    ]);
  });

  it("lets application/ import its own ports.ts, index.ts, another feature's index.ts, lib and packages", () => {
    const found = violationsOf(repo.run({ json: true }));
    expect(found.filter((v) => v.from.endsWith("application/clean.ts"))).toEqual([]);
  });

  it("reports a module door in application/ as impure-application alone, never also B5", () => {
    const found = violationsOf(repo.run({ json: true }));
    expect(found.filter((v) => v.from.endsWith("application/disk.ts"))).toEqual([
      {
        kind: "impure-application",
        from: `${SCOPE}/src/billing/application/disk.ts`,
        feature: "billing",
        to: null,
        specifier: "node:fs",
        typeOnly: false,
      },
    ]);
  });

  it("leaves an undeclared door in a driving adapter alone, and a folder with no source silent", () => {
    const froms = violationsOf(repo.run({ json: true })).map((v) => v.from);
    expect(froms.some((from) => from.includes("driving/log.ts"))).toBe(false);
    expect(froms.some((from) => from.includes("assets"))).toBe(false);
  });

  it("labels the hexagonal kinds B6 to B10 in the human report", () => {
    const { stdout } = repo.run();
    expect(stdout).toContain("B7 impure-application  packages/app/src/billing/application/disk.ts");
    expect(stdout).toContain("B10 unknown-zone        packages/app/src/billing/rules -> rules\n");
  });

  it("counts B7 and B9 as door uses, and emits no key the rules/ kinds do not", () => {
    expect(isDoorUse({ kind: "impure-application" })).toBe(true);
    expect(isDoorUse({ kind: "door-outside-driven-adapter" })).toBe(true);
    expect(isDoorUse({ kind: "application-imports-adapter" })).toBe(false);
    expect(isDoorUse({ kind: "unknown-zone" })).toBe(false);
    const known = new Set([
      "kind",
      "from",
      "fromFeature",
      "feature",
      "to",
      "toFeature",
      "specifier",
      "typeOnly",
      "global",
    ]);
    const keys = violationsOf(repo.run({ json: true })).flatMap((v) => Object.keys(v));
    expect(keys.filter((key) => !known.has(key))).toEqual([]);
  });
});

describe("the layout key is parsed at the config boundary", () => {
  const SCOPE = "packages/app";
  const FILES: Record<string, string> = {
    "tsconfig.json": TSCONFIG,
    "src/env.ts": "export const ci = process.env.CI;\n",
    "src/billing/index.ts": "export const b = 1;\n",
    "src/billing/application/run.ts":
      "import { db } from '../adapters/driven/db.js';\nexport const run = db;\n",
    "src/billing/adapters/driven/db.ts": "export const db = process.env.DB;\n",
  };
  const features = { [SCOPE]: ["billing"] };
  let repo: BoundaryRepo;
  beforeEach(() => {
    repo = boundaryRepo(SCOPE, FILES, {});
  });
  afterEach(() => repo.dispose());

  const withRules = (rules: unknown): string => {
    const file = path.join(repo.root, "rules.json");
    fs.writeFileSync(file, JSON.stringify(rules));
    return file;
  };

  const refused = (rules: unknown): string => {
    const file = withRules(rules);
    const messages: string[] = [];
    for (const flags of [{}, { ci: true }, { acceptCrossings: true, reason: "x" }]) {
      const { code, errors, stdout } = repo.run({ ...flags, rules: file });
      expect(code).toBe(2);
      expect(stdout).toBe("");
      expect(errors).toHaveLength(1);
      messages.push(...errors);
    }
    expect(fs.existsSync(repo.ledgerFile)).toBe(false);
    return messages[0] ?? "";
  };

  it("refuses a layout for a scope that declares no features", () => {
    expect(refused({ features, layout: { "packages/other": "hexagonal" } })).toBe(
      '"layout" declares scope "packages/other", which declares no "features": a layout rides a ' +
        "scope that declares features.",
    );
  });

  it("refuses a layout other than rules or hexagonal", () => {
    expect(refused({ features, layout: { [SCOPE]: "onion" } })).toContain("layout.packages/app");
  });

  it("refuses a door owner in a hexagonal zone that judges doors itself", () => {
    const layout = { [SCOPE]: "hexagonal" };
    const owners = [
      ["src/billing/index.ts", "is src/billing/index.ts, where no door has an owner"],
      ["src/billing/ports.ts", "is src/billing/ports.ts, where no door has an owner"],
      ["src/billing/application/env.ts", "is under src/billing/application/, where no door"],
      ["src/billing/adapters/driving/env.ts", "is under src/billing/adapters/driving/, where no"],
    ];
    for (const [owner, where] of owners) {
      const message = refused({ features, layout, doors: { [SCOPE]: { "process.env": [owner] } } });
      expect(message).toContain(
        `owner "${owner}" of door "process.env" in "packages/app" ${where}`,
      );
      expect(message).toContain("adapters/driven/");
    }
  });

  it("accepts a door owner under adapters/driven/ or outside every feature", () => {
    const layout = { [SCOPE]: "hexagonal" };
    for (const owner of ["src/billing/adapters/driven/db.ts", "src/env.ts"]) {
      const file = withRules({ features, layout, doors: { [SCOPE]: { "process.env": [owner] } } });
      const run = repo.run({ rules: file, json: true });
      expect(run.errors).toEqual([]);
      expect(run.code).toBe(0);
    }
  });

  it("keeps an unlisted scope, and one listed as rules, on the rules/ layout", () => {
    for (const rules of [{ features }, { features, layout: { [SCOPE]: "rules" } }]) {
      const run = repo.run({ rules: withRules(rules), json: true });
      expect(run.code).toBe(0);
      expect(violationsOf(run)).toEqual([]);
    }
    const hexagonal = repo.run({
      rules: withRules({ features, layout: { [SCOPE]: "hexagonal" } }),
      json: true,
    });
    expect(crossingsOf(SCOPE, hexagonal)).toEqual([
      [
        "application-imports-adapter",
        "billing/application/run.ts",
        "billing/adapters/driven/db.ts",
      ],
    ]);
  });

  it("adds the hexagonal advice to a failing gate only when a hexagonal kind fails", () => {
    const doors = { [SCOPE]: { "process.env": ["src/env.ts"] } };
    const onRules = repo.run({ rules: withRules({ features, doors }), ci: true });
    expect(onRules.code).toBe(1);
    expect(onRules.stdout).toContain("B5 door-outside-owner");
    expect(onRules.stdout).not.toContain("hexagonal");
    const layout = { [SCOPE]: "hexagonal" };
    const onHexagonal = repo.run({ rules: withRules({ features, doors, layout }), ci: true });
    expect(onHexagonal.code).toBe(1);
    expect(onHexagonal.stdout).toContain("In a hexagonal feature");
  });
});
