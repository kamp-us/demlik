import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../test-helpers/ratchet-repo.js";
import { UNREACHABLE_LEDGER_FILENAME } from "./ledger.js";

// A workspace with one package, `packages/app`, holding zero smells, one `dead` export and one
// export only its test calls. Nothing is an entry, so both are findings.
const FILES: Readonly<Record<string, string>> = {
  "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
  "packages/app/package.json": '{ "name": "app", "private": true }\n',
  "packages/app/tsconfig.json":
    '{ "compilerOptions": { "strict": true, "module": "ESNext", "moduleResolution": "Bundler", "target": "ES2022" }, "include": ["src"] }\n',
  "packages/app/src/dead.ts": "export function unused(n: number): number {\n  return n + 1;\n}\n",
  "packages/app/src/tested.ts": "export function tested(n: number): number {\n  return n * 2;\n}\n",
  "packages/app/src/tested.test.ts":
    'import { tested } from "./tested.js";\n\nexport function check(): boolean {\n  return tested(1) === 2;\n}\n',
};

const DEAD = "src/dead.ts:unused";
const TEST_ONLY = "src/tested.ts:tested";

let top: string;
let app: string;
let ledgerFile: string;

beforeEach(() => {
  top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-unreachable-")));
  for (const [relative, text] of Object.entries(FILES)) {
    const file = path.join(top, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  app = path.join(top, "packages", "app");
  ledgerFile = path.join(top, UNREACHABLE_LEDGER_FILENAME);
});

afterEach(() => {
  fs.rmSync(top, { recursive: true, force: true });
});

type Entry = { scope: string; kind: string; id: string; reason: string };
const entry = (kind: string, id: string, scope = "packages/app"): Entry => ({
  scope,
  kind,
  id,
  reason: "kept",
});
const writeLedger = (...entries: Entry[]): void => {
  fs.writeFileSync(ledgerFile, `${JSON.stringify({ entries }, null, 2)}\n`);
};
const readLedger = (): Entry[] => JSON.parse(fs.readFileSync(ledgerFile, "utf8")).entries;

describe("--unreachable --ci gates unreachable exports, not smells", () => {
  it("fails on an unledgered dead export where the smell gate passes the same tree", () => {
    const smells = runCli([app, "--ci"]);
    expect(smells.code).toBe(0);
    expect(smells.stdout).toContain("code-graph CI: PASS — 0 smells");

    const gate = runCli([app, "--unreachable", "--ci"]);
    expect(gate.code).toBe(1);
    expect(gate.stdout).toContain("UNREACHABLE LEDGER FAILED");
    expect(gate.stdout).toContain(`dead  ${DEAD}`);
    expect(gate.stdout).toContain(`only-called-from-tests  ${TEST_ONLY}`);
    expect(gate.stdout).not.toContain("smells");
    expect(fs.existsSync(ledgerFile)).toBe(false);
  });

  it("leaves the smell gate's --fail-on and --max as they were", () => {
    const warn = runCli([app, "--ci", "--fail-on", "warn", "--max", "0"]);
    expect(warn.code).toBe(0);
    expect(warn.stdout).toContain("code-graph CI: PASS — 0 smells");
    expect(runCli([app, "--ci", "--max", "x"]).code).toBe(2);
  });
});

describe("--unreachable --accept-dead then --ci", () => {
  it("records today's findings, passes, and keeps other scopes' entries untouched", () => {
    const other = entry("dead", "src/elsewhere.ts:gone", "packages/other");
    writeLedger(other);

    const accept = runCli([app, "--unreachable", "--accept-dead", "--reason", "baseline"]);
    expect(accept.code).toBe(0);
    expect(readLedger()).toEqual([
      { scope: "packages/app", kind: "dead", id: DEAD, reason: "baseline" },
      { scope: "packages/app", kind: "only-called-from-tests", id: TEST_ONLY, reason: "baseline" },
      other,
    ]);

    const before = fs.readFileSync(ledgerFile, "utf8");
    expect(runCli([app, "--unreachable", "--ci"]).code).toBe(0);
    expect(fs.readFileSync(ledgerFile, "utf8")).toBe(before);
  });

  it("prunes this scope's entry once its finding is gone, and reports it in the JSON verdict", () => {
    const other = entry("dead", "src/elsewhere.ts:gone", "packages/other");
    writeLedger(entry("dead", DEAD), entry("only-called-from-tests", TEST_ONLY), other);
    fs.rmSync(path.join(app, "src", "dead.ts"));
    fs.writeFileSync(
      path.join(app, "src", "fresh.ts"),
      "export function fresh(): number {\n  return 3;\n}\n",
    );

    const run = runCli([app, "--unreachable", "--ci", "--json"]);
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout)).toEqual({
      passed: false,
      scope: "packages/app",
      gated: ["dead", "only-called-from-tests"],
      unrecorded: [{ scope: "packages/app", kind: "dead", id: "src/fresh.ts:fresh" }],
      pruned: [entry("dead", DEAD)],
    });
    expect(readLedger()).toEqual([entry("only-called-from-tests", TEST_ONLY), other]);
  });
});

describe("--dead-only", () => {
  it("lets an unledgered only-called-from-tests finding pass, never a dead one", () => {
    writeLedger(entry("dead", DEAD));
    expect(runCli([app, "--unreachable", "--ci"]).code).toBe(1);
    expect(runCli([app, "--unreachable", "--ci", "--dead-only"]).code).toBe(0);

    writeLedger(entry("only-called-from-tests", TEST_ONLY));
    const dead = runCli([app, "--unreachable", "--ci", "--dead-only"]);
    expect(dead.code).toBe(1);
    expect(dead.stdout).toContain(DEAD);
    expect(readLedger()).toEqual([entry("only-called-from-tests", TEST_ONLY)]);
  });
});

describe("refusals exit 2, print one line and write nothing", () => {
  it.each([
    ["--accept-dead without --reason", ["--unreachable", "--accept-dead"]],
    ["--accept-dead with a blank --reason", ["--unreachable", "--accept-dead", "--reason", "  "]],
    ["--accept-dead with --ci", ["--unreachable", "--accept-dead", "--ci", "--reason", "baseline"]],
    ["--accept-dead without --unreachable", ["--accept-dead", "--reason", "baseline"]],
    ["--dead-only without --ci", ["--unreachable", "--dead-only"]],
    ["--reason without --accept-dead", ["--unreachable", "--ci", "--reason", "baseline"]],
  ])("%s", (_, flags) => {
    const run = runCli([app, ...flags]);
    expect(run.code).toBe(2);
    expect(run.stderr.trim().split("\n")).toHaveLength(1);
    expect(run.stdout).toBe("");
    expect(fs.existsSync(ledgerFile)).toBe(false);
  });

  it.each([
    ["unreadable JSON", "{ not json"],
    ["a schema-invalid ledger", '{ "entries": [{ "scope": "packages/app", "kind": "dead" }] }\n'],
  ])("an %s", (_, text) => {
    fs.writeFileSync(ledgerFile, text);
    for (const flags of [
      ["--unreachable", "--ci"],
      ["--unreachable", "--accept-dead", "--reason", "baseline"],
    ]) {
      const run = runCli([app, ...flags]);
      expect(run.code).toBe(2);
      expect(run.stderr.trim().split("\n")).toHaveLength(1);
      expect(run.stderr).toContain(UNREACHABLE_LEDGER_FILENAME);
      expect(fs.readFileSync(ledgerFile, "utf8")).toBe(text);
    }
  });
});
