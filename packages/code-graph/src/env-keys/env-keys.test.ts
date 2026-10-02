import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = path.resolve(here, "..", "..");
const CLI = path.join(PACKAGE_DIR, "src", "index.ts");

type Worker = { configFile: string; config: string; reads: string[] };

const lines = (...source: string[]): string => `${source.join("\n")}\n`;

const API: Worker = {
  configFile: "workers/api/wrangler.jsonc",
  config: lines("{", '  "name": "api",', '  "vars": { "API_KEY": "x" }', "}"),
  reads: ["API_KEY"],
};

const BILLING: Worker = {
  configFile: "workers/billing/wrangler.toml",
  config: lines('name = "billing"', "", "[vars]", 'STRIPE_KEY = "x"', 'LEGACY_FLAG = "x"'),
  reads: ["STRIPE_KEY"],
};

// A `d1_databases` entry left unclosed in the middle of the file, as AUTH_UNCLOSED leaves one.
const AUTH: Worker = {
  configFile: "workers/auth/wrangler.jsonc",
  config: lines(
    "{",
    '  "name": "auth",',
    '  "vars": { "SESSION_SECRET": "x", "JWT_ISSUER": "y" },',
    '  "d1_databases": [ { "binding": "DB" ],',
    '  "services": [{ "binding": "API", "service": "api" }]',
    "}",
  ),
  reads: ["SESSION_SECRET", "JWT_ISSUER"],
};

// Nested under `api`'s directory, with a comma missing between two properties.
const EDGE: Worker = {
  configFile: "workers/api/edge/wrangler.jsonc",
  config: lines("{", '  "name": "edge"', '  "vars": { "EDGE_TOKEN": "x" }', "}"),
  reads: ["EDGE_TOKEN"],
};

const roots: string[] = [];

// Written in the order given, so creation order is not sorted order.
function workspace(...workers: Worker[]): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-env-keys-")));
  roots.push(root);
  fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
  for (const worker of workers) {
    const dir = path.join(root, path.dirname(worker.configFile));
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, worker.configFile), worker.config);
    const keys = worker.reads.map((key) => `env.${key}`).join(", ");
    fs.writeFileSync(
      path.join(dir, "src", "index.ts"),
      `export const read = (env: Env) => [${keys}];\n`,
    );
  }
  return root;
}

function filesUnder(root: string): string[] {
  return fs.readdirSync(root, { recursive: true, encoding: "utf8" }).sort();
}

function run(root: string, ...args: string[]) {
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    ["--import", "tsx", CLI, root, "--env-keys", ...args],
    { cwd: PACKAGE_DIR, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  return { status, stdout, stderr };
}

function threeRuns(root: string, ...args: string[]): string {
  const before = filesUnder(root);
  const runs = [run(root, ...args), run(root, ...args), run(root, ...args)];
  for (const r of runs) {
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toBe(runs[0].stdout);
  }
  expect(filesUnder(root)).toEqual(before);
  return runs[0].stdout;
}

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

describe("--env-keys over workers whose wrangler config has a syntax error", () => {
  const broken = workspace(AUTH, EDGE, BILLING, API);

  it("names each config it could not read and withholds the reads under it", () => {
    expect(threeRuns(broken)).toBe(
      lines(
        "env-keys: 3 declared, 5 recognized reads",
        "  UNPARSED CONFIG  workers/api/edge/wrangler.jsonc",
        "  UNPARSED CONFIG  workers/auth/wrangler.jsonc",
        "declared, never read (1):",
        "  LEGACY_FLAG  billing  workers/billing/wrangler.toml",
        "read, never declared (0):",
        "withheld (3) — an unmodelled construct may settle these:",
        "  read-site-owner-unparsed  3",
      ),
    );
  });

  it("carries the same in --json, with no mismatch against the worker above a broken config", () => {
    const report = JSON.parse(threeRuns(broken, "--json"));
    expect(report).toEqual({
      unparsedConfigs: ["workers/api/edge/wrangler.jsonc", "workers/auth/wrangler.jsonc"],
      readNotDeclared: [],
      declaredUnreferenced: [
        { key: "LEGACY_FLAG", service: "billing", configFile: "workers/billing/wrangler.toml" },
      ],
      declaredCount: 3,
      readCount: 5,
      withheld: ["EDGE_TOKEN", "JWT_ISSUER", "SESSION_SECRET"].map((key) => ({
        key,
        reason: "read-site-owner-unparsed",
      })),
    });
  });
});

describe("--env-keys over workers whose wrangler configs all parse", () => {
  const clean = workspace(BILLING, API);

  it("prints no UNPARSED CONFIG line and the same lines as before", () => {
    expect(threeRuns(clean)).toBe(
      lines(
        "env-keys: 3 declared, 2 recognized reads",
        "declared, never read (1):",
        "  LEGACY_FLAG  billing  workers/billing/wrangler.toml",
        "read, never declared (0):",
        "withheld (0) — an unmodelled construct may settle these:",
      ),
    );
  });

  it("adds one key to --json, an empty unparsedConfigs", () => {
    expect(JSON.parse(threeRuns(clean, "--json"))).toEqual({
      unparsedConfigs: [],
      readNotDeclared: [],
      declaredUnreferenced: [
        { key: "LEGACY_FLAG", service: "billing", configFile: "workers/billing/wrangler.toml" },
      ],
      declaredCount: 3,
      readCount: 2,
      withheld: [],
    });
  });
});
