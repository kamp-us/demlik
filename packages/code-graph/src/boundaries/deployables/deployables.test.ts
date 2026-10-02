import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { boundaryRepo } from "../../test-helpers/boundary-repo.js";
import {
  entryLines,
  ledgerOf,
  ledgerText,
  reportOf,
  sorted,
} from "../../test-helpers/library-report.js";
import {
  SHOP_WORKER_CROSSINGS,
  SHOP_WORKER_FILES,
  SHOP_WORKER_RULES,
} from "../../test-helpers/shop-workers.js";
import { ledgerTargetOf } from "../ledger.js";
import type { DeployableCensus } from "./census.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(here, "..", "..", "..");
const CLI = path.join(PACKAGE_DIR, "src", "index.ts");

const API = "services/api/src";
const MAIN = `${API}/main.ts`;
const REFUND = `${API}/billing/application/refund.ts`;

function shopRepo() {
  return boundaryRepo(".", SHOP_WORKER_FILES, SHOP_WORKER_RULES);
}

// `[scope, kind, from, target]` of every crossing a `--json` run lists, sorted.
function crossingsOf(run: ReturnType<ReturnType<typeof shopRepo>["run"]>): string[][] {
  return sorted(
    reportOf(run).scopes.flatMap((s) =>
      s.violations.map((v) => [s.scope, v.kind, v.from, ledgerTargetOf(v)]),
    ),
  );
}

describe("a repo of workers and shared packages puts the deployable rules behind the merge gate", () => {
  it("lists exactly the planted crossings, records them, and shrinks as they are fixed", () => {
    const repo = shopRepo();
    try {
      const failed = repo.run({ ci: true });
      expect(failed.code).toBe(1);
      const lines = entryLines(failed.stdout);
      expect(lines).toHaveLength(14);
      const labels = (rule: string) => lines.filter((line) => line.includes(` ${rule} `)).length;
      expect([labels("B17"), labels("B18"), labels("B19")]).toEqual([7, 2, 5]);

      const listed = repo.run({ json: true });
      expect(listed.code).toBe(0);
      expect(crossingsOf(listed)).toEqual(sorted(SHOP_WORKER_CROSSINGS));

      const accepted = repo.run({ acceptCrossings: true, reason: "legacy workers" });
      expect(accepted.code).toBe(0);
      const entries = ledgerOf(repo).entries;
      expect(sorted(entries.map((e) => [e.scope, e.kind, e.from, ledgerTargetOf(e)]))).toEqual(
        sorted(SHOP_WORKER_CROSSINGS),
      );
      expect(entries.every((entry) => entry.reason === "legacy workers")).toBe(true);

      const seeded = ledgerText(repo);
      const first = repo.run({ ci: true });
      const second = repo.run({ ci: true });
      expect([first.code, second.code]).toEqual([0, 0]);
      expect(second.stdout).toBe(first.stdout);
      expect(ledgerText(repo)).toBe(seeded);

      repo.put(REFUND, 'export const refund = (env: Env) => env.DB.prepare("delete");\n');
      const grown = repo.run({ ci: true });
      expect(grown.code).toBe(1);
      expect(entryLines(grown.stdout)).toEqual([
        expect.stringContaining(
          `services/api  B17 binding-outside-driven-adapter  ${REFUND} -> DB`,
        ),
      ]);
      expect(ledgerText(repo)).toBe(seeded);

      expect(repo.run({ acceptCrossings: true, reason: "refund" }).code).toBe(0);
      expect(ledgerOf(repo).entries).toHaveLength(15);
      repo.put(
        MAIN,
        [
          'import { format } from "../../../packages/string-util/src/format";',
          "export async function main(env: Env) {",
          "  format(1);",
          '  return import("../../../packages/string-util/src/format");',
          "}",
          "",
        ].join("\n"),
      );
      const pruned = repo.run({ ci: true });
      expect(pruned.code).toBe(0);
      expect(pruned.stdout).toContain("pruned 1 boundary-ledger.json entry");
      expect(entryLines(pruned.stdout)).toEqual([
        expect.stringContaining(
          `services/api  B17 binding-outside-driven-adapter  ${MAIN} -> EVENTS`,
        ),
      ]);
      const shrunk = ledgerText(repo);
      expect(ledgerOf(repo).entries).toHaveLength(14);
      expect(repo.run({ ci: true }).code).toBe(0);
      expect(ledgerText(repo)).toBe(shrunk);
    } finally {
      repo.dispose();
    }
  }, 60_000);

  it("holds a census site for every service-binding call --cross-runtime reports, and may hold more", () => {
    const repo = shopRepo();
    try {
      const stdout = execFileSync(
        process.execPath,
        ["--import", "tsx", CLI, fs.realpathSync(repo.root), "--cross-runtime", "--json"],
        {
          cwd: PACKAGE_DIR,
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      const calls: { binding: string; callerId: string; line: number }[] = JSON.parse(stdout).edges;
      expect(calls).toHaveLength(6);
      const report = reportOf(repo.run({ json: true })) as unknown as {
        deployables: DeployableCensus;
      };
      const sites = report.deployables.workers.flatMap((worker) => worker.sites);
      for (const { binding, callerId, line } of calls) {
        expect(sites).toContainEqual({ file: callerId.split(":")[0], line, binding });
      }
      expect(sites.length).toBeGreaterThan(calls.length);
    } finally {
      repo.dispose();
    }
  }, 60_000);

  it("prints the census, and the crossings with their type-only mark", () => {
    const repo = shopRepo();
    try {
      const report = reportOf(repo.run({ json: true })) as unknown as {
        deployables: DeployableCensus;
      };
      const [api, auth] = report.deployables.workers;
      expect([api?.worker, api?.sites.length, api?.files.length]).toEqual(["api", 9, 8]);
      expect(Object.keys(api?.bindings ?? {})).toHaveLength(6);
      expect([auth?.worker, auth?.sites.length, auth?.files.length]).toEqual(["auth", 2, 2]);
      expect(Object.keys(auth?.bindings ?? {})).toEqual(["LEDGER"]);
      expect(report.deployables.workers).toHaveLength(2);
      expect(report.deployables.unresolvedServiceBindings).toBe(1);

      const human = repo.run().stdout;
      expect(human).toContain("deployables: 2 workers using bindings, 11 sites, 1 service binding");
      expect(human).toContain("api: 9 sites in 8 files over 6 bindings");
      expect(human).toContain("auth: 2 sites in 2 files over 1 binding (LEDGER 2)");
      expect(human).toContain(". — worker call graph");
      const typeOnly = human.split("\n").filter((line) => line.includes("[type-only]"));
      expect(typeOnly).toHaveLength(1);
      expect(typeOnly[0]).toContain("billing/application/charge.ts");
    } finally {
      repo.dispose();
    }
  });
});

// A config the run cannot parse: not an object, so no worker is read from it.
const UNREADABLE = "not a wrangler config\n";
const BILLING = "services/billing-worker/wrangler.jsonc";
const MAILER = "services/mailer/wrangler.jsonc";

describe("a wrangler config the run cannot parse is never skipped silently", () => {
  // The run refuses before it measures anything, so every mode answers alike: exit 2, one line, no
  // stdout, and nothing written.
  function refusal(repo: ReturnType<typeof shopRepo>, options: Parameters<typeof repo.run>[0]) {
    const run = repo.run(options);
    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.errors).toHaveLength(1);
    expect(fs.existsSync(repo.ledgerFile)).toBe(false);
    return run.errors[0] ?? "";
  }

  it("refuses the report, --ci, --accept-crossings and --migrate-ceilings, naming the file", () => {
    const repo = shopRepo();
    try {
      repo.put(BILLING, UNREADABLE);
      fs.writeFileSync(repo.legacyFile, JSON.stringify({ default: 0, scopes: {} }));
      const modes = [
        {},
        { json: true },
        { ci: true },
        { acceptCrossings: true, reason: "legacy" },
        { migrateCeilings: true },
      ];
      for (const mode of modes) {
        const message = refusal(repo, mode);
        expect(message).toContain(BILLING);
        expect(message).toContain("binding-outside-driven-adapter");
        expect(message).toContain("worker-call-cycle");
      }
      expect(fs.existsSync(repo.legacyFile)).toBe(true);
    } finally {
      repo.dispose();
    }
  });

  it("names every such file in the one line, and runs once they parse", () => {
    const repo = shopRepo();
    try {
      repo.put(BILLING, UNREADABLE);
      repo.put(MAILER, UNREADABLE);
      const message = refusal(repo, { ci: true });
      expect(message).toContain(BILLING);
      expect(message).toContain(MAILER);

      repo.put(BILLING, JSON.stringify({ name: "billing-worker" }));
      repo.put(MAILER, JSON.stringify({ name: "mailer" }));
      expect(repo.run({ ci: true }).code).toBe(1);
    } finally {
      repo.dispose();
    }
  });

  it.each([
    ["binding-outside-driven-adapter", true],
    ["worker-call-cycle", true],
    ["relative-import-crosses-workspace", false],
  ])("with %s listed alone, refuses: %s", (kind, refused) => {
    const repo = boundaryRepo(".", SHOP_WORKER_FILES, {
      ...SHOP_WORKER_RULES,
      acrossDeployables: [kind],
    });
    try {
      repo.put(BILLING, UNREADABLE);
      const run = repo.run({ ci: true });
      expect(run.code).toBe(refused ? 2 : 1);
      expect(run.errors).toHaveLength(refused ? 1 : 0);
    } finally {
      repo.dispose();
    }
  });

  it("leaves a rules file that lists none of the kinds as it was", () => {
    const { acrossDeployables: _listed, ...unlisted } = SHOP_WORKER_RULES;
    const repo = boundaryRepo(".", SHOP_WORKER_FILES, unlisted);
    try {
      repo.put(BILLING, UNREADABLE);
      const run = repo.run({ ci: true });
      expect([run.code, run.errors]).toEqual([0, []]);
    } finally {
      repo.dispose();
    }
  });
});
