import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { type BoundaryRepo, boundaryRepo } from "../../test-helpers/boundary-repo.js";
import { SHOP_TSCONFIG } from "../../test-helpers/shop-workspace.js";

const API = "services/api";
const DRIVEN = "src/orders/adapters/driven";

const FILES: Record<string, string> = {
  "tsconfig.json": SHOP_TSCONFIG,
  [`${API}/package.json`]: JSON.stringify({ name: "@shop/api" }),
  [`${API}/wrangler.jsonc`]: JSON.stringify({
    name: "api",
    d1_databases: [{ binding: "DB" }],
    workflows: [{ binding: "FLOW", class_name: "Flow" }],
    vars: { MODE: "x" },
  }),
  [`${API}/${DRIVEN}/orders-db.ts`]: 'export const a = (env: Env) => env.DB.prepare("a");\n',
  [`${API}/src/orders/application/place.ts`]: "export const p = 1;\n",
  "tools/src/orders/adapters/driven/x.ts": "export const x = 1;\n",
};

const KINDS = [
  "binding-outside-driven-adapter",
  "worker-call-cycle",
  "relative-import-crosses-workspace",
];

const GOOD = {
  features: { [API]: ["orders"] },
  layout: { [API]: "hexagonal" },
  acrossDeployables: KINDS,
  bindingOwners: { [API]: { DB: [`${DRIVEN}/orders-db.ts`] } },
};

let repo: BoundaryRepo | null = null;
afterEach(() => repo?.dispose());

// A rules file the run refuses: exit 2, one line on stderr, nothing on stdout, and no ledger
// written even by `--accept-crossings`.
function refusal(rules: unknown): string {
  repo = boundaryRepo(".", FILES, rules);
  const run = repo.run({ acceptCrossings: true, reason: "r" });
  expect(run.code).toBe(2);
  expect(run.stdout).toBe("");
  expect(run.errors).toHaveLength(1);
  expect(fs.existsSync(repo.ledgerFile)).toBe(false);
  return run.errors[0] ?? "";
}

describe("a bad deployable declaration exits 2 with one line and writes nothing", () => {
  it("accepts the declaration these cases break", () => {
    repo = boundaryRepo(".", FILES, GOOD);
    expect(repo.run({ ci: true }).code).toBe(0);
  });

  it("refuses a kind outside the three", () => {
    const message = refusal({ ...GOOD, acrossDeployables: ["worker-call-cyle"] });
    expect(message).toContain("acrossDeployables");
    expect(message).toContain("worker-call-cycle");
  });

  it("refuses bindingOwners while binding-outside-driven-adapter is not listed", () => {
    const message = refusal({ ...GOOD, acrossDeployables: ["worker-call-cycle"] });
    expect(message).toContain('"bindingOwners"');
    expect(message).toContain('does not list "binding-outside-driven-adapter"');
    expect(refusal({ ...GOOD, acrossDeployables: [] })).toContain('"bindingOwners"');
  });

  it("refuses a bindingOwners scope that declares no features", () => {
    const message = refusal({ ...GOOD, bindingOwners: { tools: { DB: [`${DRIVEN}/x.ts`] } } });
    expect(message).toContain('scope "tools", which declares no "features"');
  });

  it("refuses an owner file the scope does not load", () => {
    const message = refusal({
      ...GOOD,
      bindingOwners: { [API]: { DB: [`${DRIVEN}/missing.ts`] } },
    });
    expect(message).toContain(`owner "${DRIVEN}/missing.ts" of binding "DB" in "${API}"`);
    expect(message).toContain("is no file the scope loads");
  });

  it("refuses an owner file that is not under a feature's adapters/driven/", () => {
    const inApplication = { [API]: { DB: ["src/orders/application/place.ts"] } };
    expect(refusal({ ...GOOD, bindingOwners: inApplication })).toContain("adapters/driven/");
    const notHexagonal = { ...GOOD, layout: { [API]: "rules" } };
    expect(refusal(notHexagonal)).toContain(`owner "${DRIVEN}/orders-db.ts"`);
    const outsideFeatures = { [API]: { DB: ["src/orders-db.ts"] } };
    expect(refusal({ ...GOOD, bindingOwners: outsideFeatures })).toContain("could never be clean");
  });

  it("refuses a binding the worker owning that file does not declare", () => {
    const named = (binding: string) => ({
      ...GOOD,
      bindingOwners: { [API]: { [binding]: [`${DRIVEN}/orders-db.ts`] } },
    });
    for (const binding of ["CACHE", "FLOW", "MODE"]) {
      const message = refusal(named(binding));
      expect(message).toContain(`binding "${binding}"`);
      expect(message).toContain('the worker "api" that owns it declares no service, D1');
    }
  });

  it("refuses an owner file that sits under no worker config", () => {
    const rules = {
      features: { tools: ["orders"] },
      layout: { tools: "hexagonal" },
      acrossDeployables: KINDS,
      bindingOwners: { tools: { DB: ["src/orders/adapters/driven/x.ts"] } },
    };
    expect(refusal(rules)).toContain("sits under no worker config");
  });
});
