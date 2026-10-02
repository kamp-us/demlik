import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openTypeProgram, openTypeSession } from "../../engine/tsgo.js";
import { loadBindingCatalog } from "../../extract/wrangler-config.js";
import { type BoundaryRepo, boundaryRepo } from "../../test-helpers/boundary-repo.js";
import { entryLines, ledgerOf, ledgerText, reportOf } from "../../test-helpers/library-report.js";
import {
  SHOP_WORKER_CROSSINGS,
  SHOP_WORKER_FILES,
  SHOP_WORKER_RULES,
} from "../../test-helpers/shop-workers.js";
import { MIGRATED_REASON } from "../migrate.js";

// Each of these is counted at the seam the gate calls through: the repo listing, the wrangler
// catalog and the type checker, all passed through to the real thing.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
vi.mock("../../extract/wrangler-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extract/wrangler-config.js")>();
  return { ...actual, loadBindingCatalog: vi.fn(actual.loadBindingCatalog) };
});
vi.mock("../../engine/tsgo.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../engine/tsgo.js")>();
  return {
    ...actual,
    openTypeSession: vi.fn(actual.openTypeSession),
    openTypeProgram: vi.fn(actual.openTypeProgram),
  };
});

const API = "services/api";
const { acrossDeployables: _listed, ...UNLISTED } = SHOP_WORKER_RULES;

let repo: BoundaryRepo | null = null;
const open = (rules: unknown = SHOP_WORKER_RULES, files = SHOP_WORKER_FILES): BoundaryRepo => {
  repo = boundaryRepo(".", files, rules);
  return repo;
};
afterEach(() => repo?.dispose());

function listings(): number {
  const calls = vi.mocked(execFileSync).mock.calls as unknown as [string, string[]][];
  return calls.filter(([cmd, args]) => cmd === "git" && args.includes("ls-files")).length;
}

function resetCounts(): void {
  vi.mocked(execFileSync).mockClear();
  vi.mocked(loadBindingCatalog).mockClear();
  vi.mocked(openTypeSession).mockClear();
  vi.mocked(openTypeProgram).mockClear();
}

describe("a rules file that lists none of the three kinds behaves as it did", () => {
  it("reports, gates and writes the same bytes with the key absent, empty, or listing nothing", () => {
    const outputs = [UNLISTED, { ...UNLISTED, acrossDeployables: [] }].map((rules) => {
      const run = open(rules);
      const plain = run.run().stdout;
      const json = run.run({ json: true }).stdout;
      expect(run.run({ acceptCrossings: true, reason: "r" }).code).toBe(0);
      const gated = run.run({ ci: true });
      const written = fs.existsSync(run.ledgerFile) ? ledgerText(run) : null;
      run.dispose();
      return [plain, json, gated.code, gated.stdout, written];
    });
    expect(outputs[1]).toEqual(outputs[0]);
    const [plain, json, code] = outputs[0] ?? [];
    expect(code).toBe(0);
    expect(plain).not.toMatch(/B1[789]|deployables|worker call graph/);
    expect(json).not.toMatch(/deployables|workers|binding-outside|worker-call|relative-import/);
  });

  it("adds no key to --json: the scopes and nothing else, each with its four keys", () => {
    const report = reportOf(open(UNLISTED).run({ json: true }));
    expect(Object.keys(report)).toEqual(["scopes"]);
    for (const scope of report.scopes) {
      expect(Object.keys(scope).sort()).toEqual([
        "features",
        "filesScanned",
        "scope",
        "violations",
      ]);
    }
  });

  it("gates a ledger written by the current release as it did, and leaves its bytes alone", () => {
    const run = open(
      {
        features: { [API]: ["orders", "billing"] },
        layout: { [API]: "hexagonal" },
      },
      {
        ...SHOP_WORKER_FILES,
        [`${API}/src/orders/application/cross.ts`]:
          'import { charge } from "../../billing/adapters/driven/billing-client";\nexport const c = charge;\n',
      },
    );
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

  it("reads no wrangler config, starts no type checker, and lists the repo no more than before", () => {
    const run = open(UNLISTED);
    execFileSync("git", ["init", "-q"], { cwd: run.root });
    resetCounts();
    expect(run.run({ ci: true }).code).toBe(0);
    expect(vi.mocked(loadBindingCatalog)).not.toHaveBeenCalled();
    expect(vi.mocked(openTypeSession)).not.toHaveBeenCalled();
    expect(vi.mocked(openTypeProgram)).not.toHaveBeenCalled();
    // As on `main`: each of the two scopes lists its own files.
    expect(listings()).toBe(2);
  });
});

describe("a rules file that lists the kinds reads the repo once, on the cheap pass", () => {
  const ALL = SHOP_WORKER_RULES.acrossDeployables;
  it.each([
    ["binding-outside-driven-adapter", ["binding-outside-driven-adapter"]],
    ["worker-call-cycle", ["worker-call-cycle"]],
    ["relative-import-crosses-workspace", ["relative-import-crosses-workspace"]],
    ["all three kinds", ALL],
  ])("with %s listed lists the repo once, reads the catalog once and starts no type checker", (_, kinds) => {
    const run = open({ ...UNLISTED, acrossDeployables: kinds });
    execFileSync("git", ["init", "-q"], { cwd: run.root });
    resetCounts();
    run.run({ ci: true });
    expect(listings()).toBe(1);
    expect(vi.mocked(loadBindingCatalog)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(openTypeSession)).not.toHaveBeenCalled();
    expect(vi.mocked(openTypeProgram)).not.toHaveBeenCalled();
  });

  it("lists the repo once when libraries are declared beside the deployables", () => {
    const run = open({
      ...SHOP_WORKER_RULES,
      libraryTypes: { util: { imports: ["util"], pure: false } },
      libraries: { "packages/string-util": "util" },
    });
    execFileSync("git", ["init", "-q"], { cwd: run.root });
    resetCounts();
    run.run({ ci: true });
    expect(listings()).toBe(1);
  });
});

describe("the analyzed path decides which deployable entries a run measures", () => {
  it("measures B17 and B19 of the scope it is pointed at, and leaves B18 and every other scope alone", () => {
    const run = open();
    expect(run.run({ acceptCrossings: true, reason: "legacy" }).code).toBe(0);
    expect(ledgerOf(run).entries).toHaveLength(SHOP_WORKER_CROSSINGS.length);

    // Three fixes: one in `api` (the CACHE use), one in `auth` (its LEDGER use), one that breaks
    // the `mailer, search` pair.
    run.put(
      `${API}/src/orders/application/place.test.ts`,
      'import { format } from "../../../../../packages/string-util/src/format";\nexport const cached = format;\n',
    );
    run.put("services/auth/src/sessions/application/issue.ts", "export const issue = 1;\n");
    run.put("services/mailer/wrangler.jsonc", JSON.stringify({ name: "mailer" }));

    const atApi = run.run({ ci: true, at: API });
    expect(atApi.code).toBe(0);
    expect(entryLines(atApi.stdout)).toEqual([expect.stringContaining("B17")]);
    expect(entryLines(atApi.stdout)[0]).toContain("place.test.ts -> CACHE");
    expect(ledgerOf(run).entries).toHaveLength(SHOP_WORKER_CROSSINGS.length - 1);

    const atRoot = run.run({ ci: true });
    expect(atRoot.code).toBe(0);
    expect(entryLines(atRoot.stdout)).toHaveLength(2);
    expect(ledgerOf(run).entries).toHaveLength(SHOP_WORKER_CROSSINGS.length - 3);
  });

  it("fails on a new B18 only at the repo root", () => {
    const run = open();
    expect(run.run({ acceptCrossings: true, reason: "legacy" }).code).toBe(0);
    run.put(
      "services/reports/wrangler.jsonc",
      JSON.stringify({
        name: "reports",
        services: [{ binding: "API", service: "api" }],
      }),
    );
    run.put(
      "services/api/wrangler.jsonc",
      JSON.stringify({
        name: "api",
        services: [{ binding: "REPORTS", service: "reports" }],
      }),
    );
    expect(run.run({ ci: true, at: API }).stdout).not.toContain("worker-call-cycle");
    const atRoot = run.run({ ci: true });
    expect(atRoot.stdout).toContain("B18 worker-call-cycle");
  });
});

describe("--migrate-ceilings seeds the deployable kinds without counting them", () => {
  const ceilings = (run: BoundaryRepo, scopes: Record<string, number> = {}) =>
    fs.writeFileSync(run.legacyFile, JSON.stringify({ default: 0, scopes }));

  it("seeds B17, B18 and B19 with the grandfathered reason where a counted kind would refuse", () => {
    const run = open();
    ceilings(run);
    const migrated = run.run({ migrateCeilings: true });
    expect(migrated.code).toBe(0);
    const entries = ledgerOf(run).entries;
    expect(entries).toHaveLength(SHOP_WORKER_CROSSINGS.length);
    expect(entries.every((entry) => entry.reason === MIGRATED_REASON)).toBe(true);
    expect(entries.filter((entry) => entry.scope === ".")).toHaveLength(2);
    expect(fs.existsSync(run.legacyFile)).toBe(false);
    expect(run.run({ ci: true }).code).toBe(0);
  });

  it("still holds a scope's import crossings (B1) against its ceiling", () => {
    const run = open();
    run.put(
      `${API}/src/orders/application/cross.ts`,
      'import { charge } from "../../billing/adapters/driven/billing-client";\nexport const c = charge;\n',
    );
    ceilings(run);
    const refused = run.run({ migrateCeilings: true });
    expect(refused.code).toBe(2);
    expect(refused.errors.join("\n")).toContain(
      `${API}: 1 crossing(s) against a recorded ceiling of 0`,
    );
    expect(fs.existsSync(run.ledgerFile)).toBe(false);
    ceilings(run, { [API]: 1 });
    expect(run.run({ migrateCeilings: true }).code).toBe(0);
  });
});

describe("the fix advice names the deployable rules only when one of them fails", () => {
  const ADVICE = "Use a worker binding only in a feature's adapters/driven/";

  it("prints it for a B17, B18 or B19 failure, and not for a B1", () => {
    const run = open();
    expect(run.run({ ci: true }).stdout).toContain(ADVICE);
    const other = open(
      { features: { [API]: ["orders", "billing"] } },
      {
        ...SHOP_WORKER_FILES,
        [`${API}/src/orders/application/cross.ts`]:
          'import { charge } from "../../billing/adapters/driven/billing-client";\nexport const c = charge;\n',
      },
    );
    const failed = other.run({ ci: true });
    expect(failed.code).toBe(1);
    expect(failed.stdout).not.toContain(ADVICE);
  });
});
