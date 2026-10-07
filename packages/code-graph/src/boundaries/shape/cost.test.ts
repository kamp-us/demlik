import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openTypeProgram, openTypeSession } from "../../engine/tsgo.js";
import { loadBindingCatalog } from "../../extract/wrangler-config.js";
import { apiRepo } from "../../test-helpers/api-repo.js";
import { type BoundaryRepo, boundaryRepo } from "../../test-helpers/boundary-repo.js";
import { ledgerText, reportOf } from "../../test-helpers/library-report.js";
import {
  SHAPE_FILES,
  SHAPE_RULES,
  SHAPE_RULES_WITHOUT_SHAPE,
} from "../../test-helpers/shop-shape.js";

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

let repo: BoundaryRepo | null = null;
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

// The same repo as a git checkout, so the repo's files are listed the way a real one's are.
function checkedOut(rules: unknown): BoundaryRepo {
  repo = boundaryRepo(".", SHAPE_FILES, rules);
  execFileSync("git", ["init", "-q"], { cwd: repo.root });
  return repo;
}

const EMPTY_KEYS = {
  applicationShape: [],
  applicationMayImport: [],
  pureDependencies: [],
  testFiles: [],
  readAllowance: {},
};

describe("a rules file with none of the five keys behaves as it did", () => {
  it("reports, gates and writes the same bytes with the keys absent, or present and empty", () => {
    const outputs = [
      SHAPE_RULES_WITHOUT_SHAPE,
      { ...SHAPE_RULES_WITHOUT_SHAPE, ...EMPTY_KEYS },
    ].map((rules) => {
      const run = boundaryRepo(".", SHAPE_FILES, rules);
      const plain = run.run().stdout;
      const json = run.run({ json: true }).stdout;
      expect(run.run({ acceptCrossings: true, reason: "r" }).code).toBe(0);
      const gated = run.run({ ci: true });
      const written = fs.existsSync(run.ledgerFile) ? ledgerText(run) : null;
      run.dispose();
      return [plain, json, gated.code, gated.stdout, written];
    });
    expect(outputs[1]).toEqual(outputs[0]);
    const [plain, , code] = outputs[0] ?? [];
    expect(code).toBe(0);
    expect(plain).not.toMatch(/B1[56] |\[write:/);
  });

  it("adds no key to --json: the scopes and nothing else, each with its four keys", () => {
    repo = apiRepo({ "src/orders/application/use.ts": 'import "hono";\n' });
    const report = reportOf(repo.run({ json: true }));
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

  it("reads no wrangler config for the allowance, and lists the repo no more than before", () => {
    const run = checkedOut(SHAPE_RULES_WITHOUT_SHAPE);
    resetCounts();
    expect(run.run({ ci: true }).code).toBe(1);
    expect(vi.mocked(loadBindingCatalog)).not.toHaveBeenCalled();
    expect(vi.mocked(openTypeSession)).not.toHaveBeenCalled();
    expect(vi.mocked(openTypeProgram)).not.toHaveBeenCalled();
    // The libraries are declared, so the repo is listed once for all of its scopes.
    expect(listings()).toBe(1);
  });

  it("lists nothing for a repo that declares no library key either, as before", () => {
    repo = apiRepo({ "src/orders/application/use.ts": "export const use = 1;\n" });
    execFileSync("git", ["init", "-q"], { cwd: repo.root });
    resetCounts();
    expect(repo.run({ ci: true }).code).toBe(0);
    // Each scope lists its own files, as on main.
    expect(listings()).toBe(1);
    expect(vi.mocked(loadBindingCatalog)).not.toHaveBeenCalled();
  });
});

describe("a rules file that declares every key reads the repo once, on the cheap pass", () => {
  it("lists the repo once, reads the catalog once and starts no type checker", () => {
    const run = checkedOut(SHAPE_RULES);
    resetCounts();
    expect(run.run({ ci: true }).code).toBe(1);
    expect(listings()).toBe(1);
    expect(vi.mocked(loadBindingCatalog)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(openTypeSession)).not.toHaveBeenCalled();
    expect(vi.mocked(openTypeProgram)).not.toHaveBeenCalled();
  });

  it("reads the catalog once when the deployable kinds are listed beside the allowance", () => {
    const run = checkedOut({
      ...SHAPE_RULES,
      acrossDeployables: ["binding-outside-driven-adapter", "worker-call-cycle"],
    });
    resetCounts();
    run.run({ ci: true });
    expect(listings()).toBe(1);
    expect(vi.mocked(loadBindingCatalog)).toHaveBeenCalledTimes(1);
  });

  it("reads no catalog for the keys that do not read the repo", () => {
    const { readAllowance: _allowance, ...withoutAllowance } = SHAPE_RULES;
    const run = checkedOut(withoutAllowance);
    resetCounts();
    run.run({ ci: true });
    expect(vi.mocked(loadBindingCatalog)).not.toHaveBeenCalled();
    expect(vi.mocked(openTypeSession)).not.toHaveBeenCalled();
  });
});
