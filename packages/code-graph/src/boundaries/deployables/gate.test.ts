import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openTypeProgram, openTypeSession } from "../../engine/tsgo.js";
import { loadBindingCatalog } from "../../extract/wrangler-config.js";
import { workspacePackages } from "../../layers/resolve-target.js";
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
vi.mock("../../layers/resolve-target.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../layers/resolve-target.js")>();
  return { ...actual, workspacePackages: vi.fn(actual.workspacePackages) };
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
  vi.mocked(workspacePackages).mockClear();
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
    ["package-import-crosses-deployable", ["package-import-crosses-deployable"]],
    ["all three kinds", ALL],
  ])("with %s listed lists the repo once, reads the catalog once and starts no type checker", (_, kinds) => {
    const run = open({ ...UNLISTED, acrossDeployables: kinds });
    execFileSync("git", ["init", "-q"], { cwd: run.root });
    resetCounts();
    run.run({ ci: true });
    expect(listings()).toBe(1);
    expect(vi.mocked(loadBindingCatalog)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(workspacePackages)).toHaveBeenCalledTimes(
      kinds.includes("package-import-crosses-deployable") ? 1 : 0,
    );
    expect(vi.mocked(openTypeSession)).not.toHaveBeenCalled();
    expect(vi.mocked(openTypeProgram)).not.toHaveBeenCalled();
  });

  it("lists the repo and reads each manifest once per run with libraries and B21", () => {
    const run = open({
      ...SHOP_WORKER_RULES,
      acrossDeployables: [...ALL, "package-import-crosses-deployable"],
      libraryTypes: { util: { imports: ["util"], pure: false } },
      libraries: { "packages/string-util": "util" },
    });
    execFileSync("git", ["init", "-q"], { cwd: run.root });
    run.put("package.json", JSON.stringify({ name: "@shop/root" }));
    const manifests = [
      "package.json",
      ...Object.keys(SHOP_WORKER_FILES).filter((file) => file.endsWith("/package.json")),
    ];
    const reads = vi.spyOn(fs, "readFileSync");
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        resetCounts();
        reads.mockClear();
        expect(run.run({ json: true }).errors).toEqual([]);
        expect(listings()).toBe(1);
        expect(vi.mocked(workspacePackages)).toHaveBeenCalledTimes(1);
        for (const file of manifests) {
          expect(
            reads.mock.calls.filter(([read]) => read === path.join(run.root, file)),
            file,
          ).toHaveLength(1);
        }
      }
    } finally {
      reads.mockRestore();
    }
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

describe("B21 through the --boundaries CLI", () => {
  it("gates three workers, accepts today's crossings and prunes a repaired import", () => {
    const kind = "package-import-crosses-deployable";
    const files: Record<string, string> = {
      "tsconfig.json": '{ "compilerOptions": { "target": "ES2022", "module": "ESNext" } }',
      "pnpm-workspace.yaml": 'packages: ["services/*", "packages/*"]',
      "packages/contract/package.json": '{ "name": "@shop/contract" }',
      "packages/contract/src/index.ts": "export type Port = unknown;\n",
    };
    for (const worker of ["api", "billing", "mailer"]) {
      files[`services/${worker}/package.json`] = JSON.stringify({ name: `@shop/${worker}` });
      files[`services/${worker}/wrangler.jsonc`] = JSON.stringify({ name: worker });
    }
    files["services/api/src/orders/adapters/driven/use.ts"] = [
      'import type { Port } from "@shop/contract";',
      'export { x } from "@shop/billing";',
      'export { y } from "@shop/billing/testing";',
    ].join("\n");
    files["services/api/src/orders/adapters/driven/use.test.ts"] =
      'export type { X } from "@shop/mailer/testing";\n';
    files["services/billing/src/orders/adapters/driven/use.ts"] =
      'export { x } from "@shop/mailer";\n';
    files["services/mailer/src/orders/adapters/driven/use.ts"] =
      'export type { Port } from "@shop/contract";\nexport { x } from "@shop/mailer/internal";\n';
    const run = open(
      {
        features: Object.fromEntries(
          ["api", "billing", "mailer"].map((w) => [`services/${w}`, ["orders"]]),
        ),
        acrossDeployables: [kind],
        testFiles: ["**/*.test.ts"],
      },
      files,
    );
    execFileSync("git", ["init", "-q"], { cwd: run.root });
    const cli = (...flags: string[]) =>
      spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          fileURLToPath(new URL("../../index.ts", import.meta.url)),
          fs.realpathSync(run.root),
          "--boundaries",
          "--boundary-rules",
          run.rulesFile,
          ...flags,
        ],
        { encoding: "utf8" },
      );
    const report = cli("--json");
    expect(report.stderr).toBe("");
    expect(report.status).toBe(0);
    expect(
      reportOf({ code: 0, stdout: report.stdout, errors: [] }).scopes.flatMap((s) => s.violations),
    ).toEqual([
      {
        kind,
        from: "services/api/src/orders/adapters/driven/use.test.ts",
        to: "services/mailer",
        specifier: "@shop/mailer/testing",
        typeOnly: true,
      },
      {
        kind,
        from: "services/api/src/orders/adapters/driven/use.ts",
        to: "services/billing",
        specifier: "@shop/billing",
        typeOnly: false,
      },
      {
        kind,
        from: "services/billing/src/orders/adapters/driven/use.ts",
        to: "services/mailer",
        specifier: "@shop/mailer",
        typeOnly: false,
      },
    ]);
    expect(cli("--json").stdout).toBe(report.stdout);
    const failed = cli("--ci");
    expect(failed.status).toBe(1);
    expect(failed.stdout).toContain(`B21 ${kind}`);
    expect(cli("--accept-crossings", "--reason", "adopt B21").status).toBe(0);
    expect(ledgerOf(run).entries).toHaveLength(3);
    expect(cli("--ci").status).toBe(0);
    run.put(
      "services/api/src/orders/adapters/driven/use.ts",
      'export type { Port } from "@shop/contract";\n',
    );
    expect(cli("--ci").status).toBe(0);
    expect(ledgerOf(run).entries).toHaveLength(2);
  });
});
