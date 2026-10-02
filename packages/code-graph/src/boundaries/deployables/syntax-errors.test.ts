import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { boundaryRepo } from "../../test-helpers/boundary-repo.js";
import { entryLines, ledgerOf, ledgerText } from "../../test-helpers/library-report.js";
import { shopManifests } from "../../test-helpers/shop-workspace.js";
import {
  API_CONFIG,
  AUTH_CONFIG,
  AUTH_UNCLOSED,
  MAILER_CONFIG,
  MID_FILE_ERRORS,
  SEARCH_CONFIG,
} from "../../test-helpers/wrangler-configs.js";

// Four workers: `api` and `auth` bind each other, so do `mailer` and `search`. `search`'s config is
// written the way wrangler accepts it and `auth`'s is the one a test breaks.
const WORKERS = ["api", "auth", "mailer", "search"].map((name) => `services/${name}`);
const CONFIGS: Record<string, string> = {
  "services/api/wrangler.jsonc": API_CONFIG,
  "services/auth/wrangler.jsonc": AUTH_CONFIG,
  "services/mailer/wrangler.jsonc": MAILER_CONFIG,
  "services/search/wrangler.jsonc": SEARCH_CONFIG,
};
const AUTH = "services/auth/wrangler.jsonc";

function workersRepo(auth: string) {
  const sources = Object.fromEntries(WORKERS.map((dir) => [`${dir}/src/index.ts`, "export {};\n"]));
  return boundaryRepo(
    ".",
    {
      "pnpm-workspace.yaml": 'packages:\n  - "services/*"\n',
      ...shopManifests(WORKERS),
      ...sources,
      ...CONFIGS,
      [AUTH]: auth,
    },
    {
      features: { "services/api": ["orders"] },
      layout: { "services/api": "hexagonal" },
      acrossDeployables: ["binding-outside-driven-adapter", "worker-call-cycle"],
    },
  );
}

const OTHERS = ["api", "mailer", "search"].map((name) => `services/${name}/wrangler.jsonc`);

describe("a wrangler config with a syntax error stops the gate and one wrangler accepts never does", () => {
  // The run refuses before it measures anything, so every mode answers alike: exit 2, one line
  // naming the broken file alone, no stdout, and nothing written.
  function refusal(repo: ReturnType<typeof workersRepo>, options: Parameters<typeof repo.run>[0]) {
    const run = repo.run(options);
    expect(run.code).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.errors).toHaveLength(1);
    expect(fs.existsSync(repo.ledgerFile)).toBe(false);
    const message = run.errors[0] ?? "";
    expect(message).toContain(AUTH);
    for (const other of OTHERS) expect(message).not.toContain(other);
  }

  it("refuses every mode over the broken config, then lists both cycles once it is closed", () => {
    const repo = workersRepo(AUTH_UNCLOSED);
    try {
      fs.writeFileSync(repo.legacyFile, JSON.stringify({ default: 0, scopes: {} }));
      const modes = [
        {},
        { json: true },
        { ci: true },
        { acceptCrossings: true, reason: "legacy workers" },
        { migrateCeilings: true },
      ];
      for (const mode of modes) refusal(repo, mode);

      repo.put(AUTH, AUTH_CONFIG);
      fs.rmSync(repo.legacyFile);
      const failed = repo.run({ ci: true });
      expect(failed.code).toBe(1);
      expect(entryLines(failed.stdout)).toEqual([
        expect.stringContaining("worker-call-cycle  api, auth"),
        expect.stringContaining("worker-call-cycle  mailer, search"),
      ]);

      expect(repo.run({ acceptCrossings: true, reason: "legacy workers" }).code).toBe(0);
      expect(ledgerOf(repo).entries.map((entry) => [entry.kind, entry.from])).toEqual([
        ["worker-call-cycle", "api, auth"],
        ["worker-call-cycle", "mailer, search"],
      ]);

      const seeded = ledgerText(repo);
      const first = repo.run({ ci: true });
      const second = repo.run({ ci: true });
      expect([first.code, second.code]).toEqual([0, 0]);
      expect(second.stdout).toBe(first.stdout);
      expect(ledgerText(repo)).toBe(seeded);
    } finally {
      repo.dispose();
    }
  }, 60_000);

  it.each(
    MID_FILE_ERRORS.map(({ name, text }) => [name, text] as const),
  )("refuses --ci over %s", (_name, text) => {
    const repo = workersRepo(text);
    try {
      refusal(repo, { ci: true });
    } finally {
      repo.dispose();
    }
  });
});
