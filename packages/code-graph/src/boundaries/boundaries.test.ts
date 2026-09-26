import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveBoundaryRules } from "../config.js";
import { type BoundaryRepo, boundaryRepo } from "../test-helpers/boundary-repo.js";
import type { BoundaryViolation } from "./analyze.js";
import { type BoundaryLedger, readBoundaryLedger } from "./ledger.js";
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
