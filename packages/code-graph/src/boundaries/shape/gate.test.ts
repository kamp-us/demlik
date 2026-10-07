import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { API, apiRepo } from "../../test-helpers/api-repo.js";
import { type BoundaryRepo, boundaryRepo } from "../../test-helpers/boundary-repo.js";
import {
  entryLines,
  ledgerOf,
  ledgerText,
  reportOf,
  sorted,
} from "../../test-helpers/library-report.js";
import {
  SHAPE_CROSSINGS,
  SHAPE_FILES,
  SHAPE_RULES,
  SHAPE_RULES_WITHOUT_SHAPE,
} from "../../test-helpers/shop-shape.js";
import { ledgerTargetOf } from "../ledger.js";
import { MIGRATED_REASON } from "../migrate.js";

let repo: BoundaryRepo | null = null;
const open = (rules: unknown = SHAPE_RULES, files = SHAPE_FILES): BoundaryRepo => {
  repo = boundaryRepo(".", files, rules);
  return repo;
};
afterEach(() => repo?.dispose());

// `[scope, kind, from, to ?? specifier]` of every crossing a `--json` run lists.
const listed = (run: BoundaryRepo): string[][] =>
  sorted(
    reportOf(run.run({ json: true })).scopes.flatMap((s) =>
      s.violations.map((v) => [s.scope, v.kind, v.from, ledgerTargetOf(v)]),
    ),
  );

const ORDERS_INDEX = `${API}/src/orders/index.ts`;
const BILLING_INDEX = `${API}/src/billing/index.ts`;

describe("a team puts the shape of its features behind the merge gate", () => {
  it("lists exactly the fourteen crossings, in every view, and leaves the clean and test files alone", () => {
    const run = open();
    const failed = run.run({ ci: true });
    expect(failed.code).toBe(1);
    expect(entryLines(failed.stdout)).toHaveLength(14);
    expect(listed(run)).toEqual(sorted(SHAPE_CROSSINGS));
    const plain = run.run();
    expect(plain.code).toBe(0);
    expect(plain.stdout.match(/^ {2}B\d+ /gm)).toHaveLength(14);
    for (const clean of ["clock.test.ts", "orders.test.ts", "place.test.ts", "http.test.ts"]) {
      expect(plain.stdout).not.toContain(clean);
    }
    expect(plain.stdout).not.toContain("orders-http.ts");
  });

  it("records them, gates green byte for byte, and prunes each as it is fixed", () => {
    const run = open();
    expect(run.run({ ci: true }).code).toBe(1);

    const accepted = run.run({ acceptCrossings: true, reason: "legacy" });
    expect(accepted.code).toBe(0);
    const entries = ledgerOf(run).entries;
    expect(entries).toHaveLength(14);
    expect(entries.every((entry) => entry.reason === "legacy")).toBe(true);
    expect(entries.some((entry) => "write" in entry)).toBe(false);
    expect(sorted(entries.map((e) => [e.scope, e.kind, e.from, ledgerTargetOf(e)]))).toEqual(
      sorted(SHAPE_CROSSINGS),
    );
    const seeded = ledgerText(run);
    const first = run.run({ ci: true });
    const second = run.run({ ci: true });
    expect([first.code, second.code]).toEqual([0, 0]);
    expect(second.stdout).toBe(first.stdout);
    expect(first.stdout).toContain("14 recorded crossing(s), none new");
    expect(ledgerText(run)).toBe(seeded);

    // A new crossing fails the gate, and the failing run writes nothing.
    const index = fs.readFileSync(`${run.root}/${ORDERS_INDEX}`, "utf8");
    run.put(ORDERS_INDEX, `${index}export const version = 1;\n`);
    const grown = run.run({ ci: true });
    expect(grown.code).toBe(1);
    expect(entryLines(grown.stdout)).toEqual([
      expect.stringMatching(
        /B15 index-not-exports-only {2}services\/api\/src\/orders\/index\.ts -> declaration$/,
      ),
    ]);
    expect(ledgerText(run)).toBe(seeded);

    // Record it, then fix another: the next run prunes exactly that entry and prints it.
    expect(run.run({ acceptCrossings: true, reason: "new" }).code).toBe(0);
    expect(ledgerOf(run).entries).toHaveLength(15);
    run.put(BILLING_INDEX, 'export { invoice } from "./application/charge";\n');
    const fixed = run.run({ ci: true });
    expect(fixed.code).toBe(0);
    expect(fixed.stdout).toContain("pruned 1 boundary-ledger.json entry whose crossing is gone:");
    expect(fixed.stdout).toContain(`${BILLING_INDEX} -> export *`);
    expect(ledgerOf(run).entries).toHaveLength(14);
    const settled = ledgerText(run);
    expect(run.run({ ci: true }).code).toBe(0);
    expect(ledgerText(run)).toBe(settled);
  });

  it("gates a ledger written before the shape kinds as it was, and leaves its bytes alone", () => {
    const run = apiRepo({
      "src/orders/application/cross.ts":
        'import { charge } from "../../billing/adapters/driven/billing-client";\nexport const c = charge;\n',
      "src/billing/adapters/driven/billing-client.ts": "export const charge = 1;\n",
    });
    repo = run;
    const entry = {
      scope: API,
      kind: "cross-feature",
      from: `${API}/src/orders/application/cross.ts`,
      to: `${API}/src/billing/adapters/driven/billing-client.ts`,
      specifier: "../../billing/adapters/driven/billing-client",
      reason: "written by 0.3",
    };
    fs.writeFileSync(run.ledgerFile, `${JSON.stringify({ entries: [entry] }, null, 2)}\n`);
    const before = ledgerText(run);
    const gated = run.run({ ci: true });
    expect(gated.code).toBe(0);
    expect(gated.stdout).toContain("1 recorded crossing(s), none new");
    expect(ledgerText(run)).toBe(before);
  });
});

describe("the shape kinds are off until listed", () => {
  const shapeless = (extra: Record<string, unknown>) => ({
    ...SHAPE_RULES_WITHOUT_SHAPE,
    ...extra,
  });

  it("reports B8, B9 and B1 as before and nothing for B15 and B16 when applicationShape lists none", () => {
    const rules = shapeless({
      testFiles: SHAPE_RULES.testFiles,
      readAllowance: SHAPE_RULES.readAllowance,
    });
    const kinds = new Set(listed(open(rules)).map(([, kind]) => kind));
    expect(kinds).toEqual(
      new Set(["driving-reaches-driven", "door-outside-driven-adapter", "cross-feature"]),
    );
  });

  it("lists one kind without the other", () => {
    const shapeKinds = ["index-not-exports-only", "application-import-outside-allowlist"];
    for (const kind of shapeKinds) {
      repo?.dispose();
      const found = listed(open(shapeless({ applicationShape: [kind] }))).map(([, k]) => k ?? "");
      expect(new Set(found.filter((k) => shapeKinds.includes(k)))).toEqual(new Set([kind]));
    }
  });
});

describe("--migrate-ceilings seeds B15 and B16 without counting them", () => {
  const ceilings = (run: BoundaryRepo, scopes: Record<string, number> = {}) =>
    fs.writeFileSync(run.legacyFile, JSON.stringify({ default: 0, scopes }));
  const shape = {
    applicationShape: ["index-not-exports-only", "application-import-outside-allowlist"],
  };

  it("migrates a scope holding a B15 and a B16 under a ceiling of 0, where a counted kind would refuse", () => {
    repo = apiRepo(
      {
        "src/orders/index.ts": "export const x = 1;\n",
        "src/orders/application/use.ts": 'import "hono";\nexport const use = 1;\n',
      },
      shape,
    );
    ceilings(repo);
    const migrated = repo.run({ migrateCeilings: true });
    expect(migrated.code).toBe(0);
    const entries = ledgerOf(repo).entries;
    expect(entries.map((entry) => entry.kind).sort()).toEqual([
      "application-import-outside-allowlist",
      "index-not-exports-only",
    ]);
    expect(entries.every((entry) => entry.reason === MIGRATED_REASON)).toBe(true);
    expect(fs.existsSync(repo.legacyFile)).toBe(false);
    expect(repo.run({ ci: true }).code).toBe(0);
  });

  it("still holds a scope's B1 and B8 import crossings, a B8 reported for a write included", () => {
    const write = 'export const read = (env: Env) => env.DB.prepare("DELETE FROM t");\n';
    const files = {
      "src/orders/adapters/driven/reads.ts": write,
      "src/orders/adapters/driving/http.ts":
        'import { read } from "../driven/reads";\nimport { total } from "@shop/domain-kernel";\nexport const h = [read, total];\n',
    };
    const rules = {
      libraryTypes: { kernel: { imports: ["kernel"], pure: true } },
      libraries: { "packages/domain-kernel": "kernel" },
      readAllowance: {
        [API]: { driven: ["src/orders/adapters/driven/reads.ts"], decidedBy: ["kernel"] },
      },
    };
    repo = apiRepo(files, rules, {
      "packages/domain-kernel/package.json": JSON.stringify({ name: "@shop/domain-kernel" }),
      "packages/domain-kernel/src/index.ts": "export const total = 1;\n",
      [`${API}/wrangler.jsonc`]: JSON.stringify({ name: "api", d1_databases: [{ binding: "DB" }] }),
    });
    ceilings(repo);
    const refused = repo.run({ migrateCeilings: true });
    expect(refused.code).toBe(2);
    expect(refused.errors.join("\n")).toContain(
      `${API}: 1 crossing(s) against a recorded ceiling of 0`,
    );
    expect(fs.existsSync(repo.ledgerFile)).toBe(false);
    ceilings(repo, { [API]: 1 });
    expect(repo.run({ migrateCeilings: true }).code).toBe(0);
    expect(ledgerOf(repo).entries.map((entry) => entry.kind)).toEqual(["driving-reaches-driven"]);
  });
});

describe("the fix advice names the shape rules only when one of them fails", () => {
  const ADVICE = "Keep an entry file (a library's src/index.ts, a feature's index.ts)";
  const shape = {
    applicationShape: ["index-not-exports-only", "application-import-outside-allowlist"],
  };

  it("prints it for a B15 or B16 failure, and not for a B1", () => {
    repo = apiRepo({ "src/orders/index.ts": "export const x = 1;\n" }, shape);
    expect(repo.run({ ci: true }).stdout).toContain(ADVICE);
    repo.dispose();
    repo = apiRepo(
      { "src/orders/application/use.ts": 'import "hono";\nexport const use = 1;\n' },
      shape,
    );
    expect(repo.run({ ci: true }).stdout).toContain(ADVICE);
    repo.dispose();
    repo = apiRepo(
      {
        "src/billing/application/charge.ts": "export const charge = 1;\n",
        "src/orders/application/use.ts":
          'import { charge } from "../../billing/application/charge";\nexport const u = charge;\n',
      },
      shape,
    );
    const failed = repo.run({ ci: true });
    expect(failed.code).toBe(1);
    expect(failed.stdout).not.toContain(ADVICE);
  });
});
