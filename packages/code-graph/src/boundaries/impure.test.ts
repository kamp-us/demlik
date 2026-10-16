import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BoundaryRepo, boundaryRepo, type GateRun } from "../test-helpers/boundary-repo.js";
import { type BoundaryLedger, readBoundaryLedger } from "./ledger.js";
import { MIGRATED_REASON } from "./migrate.js";
import type { BoundaryViolation } from "./violation.js";

const TSCONFIG = JSON.stringify({
  compilerOptions: { module: "esnext", moduleResolution: "bundler", strict: true },
  include: ["src"],
});

function ledgerOf(repo: BoundaryRepo): BoundaryLedger {
  const read = readBoundaryLedger(repo.ledgerFile);
  if (read.kind !== "read") throw new Error(`expected a readable ledger, got ${read.kind}`);
  return read.ledger;
}

const ledgerText = (repo: BoundaryRepo): string => fs.readFileSync(repo.ledgerFile, "utf8");

function violationsOf(run: GateRun): BoundaryViolation[] {
  const parsed: { scopes: { violations: BoundaryViolation[] }[] } = JSON.parse(run.stdout);
  return parsed.scopes.flatMap((s) => s.violations);
}

// `[kind, file under <scope>/src, row or specifier]`: what a reader checks a report for.
function crossingsOf(scope: string, run: GateRun): string[][] {
  const root = `${scope}/src/`;
  return violationsOf(run).map((v) => [v.kind, v.from.replace(root, ""), v.specifier]);
}

const pruneLines = (stdout: string): string[] => {
  const lines = stdout.split("\n");
  const head = lines.findIndex((line) => line.startsWith("pruned "));
  return head === -1 ? [] : lines.slice(head + 1).filter((line) => line.startsWith("  "));
};

const IMPURE = "impure";

describe("a package owner adopts the impure rule and watches it close", () => {
  const SCOPE = "packages/app";
  const FILES: Record<string, string> = {
    "tsconfig.json": TSCONFIG,
    "src/env.ts": "export const ci = process.env.CI;\n",
    "src/lib/ci.ts": "export const ci = Boolean(process.env.CI);\n",
    "src/billing/index.ts": "export const startedAt = Date.now();\n",
    "src/billing/ports.ts": "export const port = process.env.PORT;\n",
    "src/billing/application/charge.ts": "export const charge = process.env.CI;\n",
    "src/billing/application/refund.ts": 'export const refund = process.env["CI"];\n',
    "src/billing/application/charge.test.ts": "export const t = process.env.CI;\n",
    "src/billing/adapters/driving/http.ts": 'export const get = () => fetch("u");\n',
    "src/billing/adapters/driven/db.ts": [
      'import { readFileSync } from "node:fs";',
      "export const db = [readFileSync, process.env.DB, Date.now(), console.log];",
    ].join("\n"),
    "src/users/application/login.ts": "const { CI } = process.env;\nexport const login = CI;\n",
    "src/users/application/session.ts":
      'const key = "CI";\nexport const session = process.env[key];\n',
    "src/users/application/export.ts":
      "const { env } = process;\nexport const exported = env.CI;\n",
    "src/users/application/upload.ts": 'export const load = () => import("node:fs");\n',
    "src/users/application/rank.ts":
      "export const rank = () => [Math.random(), crypto.randomUUID()];\n",
    "src/users/application/format.ts": [
      "export const format = (line: string) => {",
      "  console.log(line);",
      "  setTimeout(() => {}, 1);",
      '  fetch("u");',
      "  return new Date();",
      "};",
    ].join("\n"),
    "src/users/application/pure.ts": [
      "type F = (u: string) => unknown;",
      "export type Env = typeof process.env;",
      "export const epoch = new Date(0);",
      'export const parsed = Date.parse("x");',
      'export const call = (fetch: F) => fetch("u");',
    ].join("\n"),
  };
  const RULES = {
    features: { [SCOPE]: ["billing", "users"] },
    lib: ["lib"],
    testFiles: ["**/*.test.ts"],
  };
  const USES = [
    [IMPURE, "billing/adapters/driving/http.ts", "fetch"],
    [IMPURE, "billing/application/charge.ts", "process.env"],
    [IMPURE, "billing/application/refund.ts", "process.env"],
    [IMPURE, "billing/index.ts", "Date.now"],
    [IMPURE, "billing/ports.ts", "process.env"],
    [IMPURE, "users/application/export.ts", "process.env"],
    [IMPURE, "users/application/format.ts", "console"],
    [IMPURE, "users/application/format.ts", "fetch"],
    [IMPURE, "users/application/format.ts", "new Date()"],
    [IMPURE, "users/application/format.ts", "setTimeout"],
    [IMPURE, "users/application/login.ts", "process.env"],
    [IMPURE, "users/application/rank.ts", "crypto.randomUUID"],
    [IMPURE, "users/application/rank.ts", "Math.random"],
    [IMPURE, "users/application/session.ts", "process.env"],
    [IMPURE, "users/application/upload.ts", "node:fs"],
  ];

  let repo: BoundaryRepo;
  beforeEach(() => {
    repo = boundaryRepo(SCOPE, FILES, RULES);
  });
  afterEach(() => repo.dispose());

  it("fires in application/, index.ts, ports.ts and a driving adapter, never in a driven adapter, a test file or outside a feature", () => {
    const run = repo.run({ json: true });
    expect(run.code).toBe(0);
    expect(crossingsOf(SCOPE, run)).toEqual(USES);
  });

  it("seeds the entries once, fails a new use alone, and prunes the ones that close", () => {
    const reason = "adopting the impure rule";
    expect(repo.run({ acceptCrossings: true, reason }).code).toBe(0);
    expect(ledgerOf(repo).entries).toHaveLength(USES.length);
    expect(new Set(ledgerOf(repo).entries.map((e) => e.reason))).toEqual(new Set([reason]));
    const seeded = ledgerText(repo);
    const green = repo.run({ ci: true });
    expect(green.code).toBe(0);
    expect(green.stdout).toContain(`${USES.length} recorded crossing(s), none new`);
    expect(ledgerText(repo)).toBe(seeded);

    repo.put("src/users/application/logout.ts", "export const out = process.env.CI;\n");
    repo.put("src/billing/application/tax.ts", "export const tax = () => Date.now();\n");
    repo.put(
      "src/billing/application/charge.ts",
      "export const charge = [process.env.CI, process.env.NEW];\n",
    );
    const failed = repo.run({ ci: true, json: true });
    expect(failed.code).toBe(1);
    const verdict: { unrecorded: { kind: string; from: string; specifier: string }[] } = JSON.parse(
      failed.stdout,
    );
    expect(
      verdict.unrecorded.map((e) => [e.kind, e.from.replace(`${SCOPE}/src/`, ""), e.specifier]),
    ).toEqual([
      [IMPURE, "billing/application/tax.ts", "Date.now"],
      [IMPURE, "users/application/logout.ts", "process.env"],
    ]);
    expect(ledgerText(repo)).toBe(seeded);

    expect(repo.run({ acceptCrossings: true, reason: "two more" }).code).toBe(0);
    expect(ledgerOf(repo).entries).toHaveLength(USES.length + 2);
    repo.put("src/billing/application/refund.ts", "export const refund = 1;\n");
    repo.put("src/billing/ports.ts", "export const port = 1;\n");
    const pruned = repo.run({ ci: true });
    expect(pruned.code).toBe(0);
    expect(pruned.stdout).toContain(
      "pruned 2 boundary-ledger.json entries whose crossing is gone:",
    );
    expect(pruneLines(pruned.stdout)).toEqual([
      `  ${SCOPE}  B7 ${IMPURE}  ${SCOPE}/src/billing/application/refund.ts -> process.env  — ${reason}`,
      `  ${SCOPE}  B7 ${IMPURE}  ${SCOPE}/src/billing/ports.ts -> process.env  — ${reason}`,
    ]);
    expect(ledgerOf(repo).entries).toHaveLength(USES.length);

    const settled = ledgerText(repo);
    for (const _ of [1, 2]) {
      const again = repo.run({ ci: true });
      expect(again.code).toBe(0);
      expect(again.stdout).not.toContain("pruned");
      expect(ledgerText(repo)).toBe(settled);
    }
  });

  it("judges a test file like source when the rules file names no testFiles", () => {
    const rules = { features: RULES.features, lib: RULES.lib };
    const bare = boundaryRepo(SCOPE, FILES, rules);
    try {
      const found = crossingsOf(SCOPE, bare.run({ json: true }));
      expect(found).toContainEqual([IMPURE, "billing/application/charge.test.ts", "process.env"]);
    } finally {
      bare.dispose();
    }
  });

  it("renders an impure use as B7 and tells the owner where the outside world may be reached", () => {
    const report = repo.run();
    expect(report.stdout).toContain(
      `B7 ${IMPURE.padEnd(19)} ${SCOPE}/src/billing/index.ts -> Date.now\n`,
    );
    expect(report.stdout).not.toContain('("process.env")');

    const failed = repo.run({ ci: true });
    expect(failed.code).toBe(1);
    expect(failed.stdout).toContain(`BOUNDARY LEDGER FAILED — ${USES.length} crossing(s)`);
    expect(failed.stdout).toContain(
      `${SCOPE}  B7 ${IMPURE}  ${SCOPE}/src/billing/ports.ts -> process.env\n`,
    );
    expect(failed.stdout).toContain("only in\n  adapters/driven/");
    expect(failed.stdout).toContain("--accept-crossings");
  });

  it("keeps `--json` to the one shape every impure violation has", () => {
    const found = violationsOf(repo.run({ json: true }));
    expect(found.find((v) => v.from.endsWith("billing/ports.ts"))).toEqual({
      kind: IMPURE,
      from: `${SCOPE}/src/billing/ports.ts`,
      to: null,
      specifier: "process.env",
      typeOnly: false,
    });
  });

  it("leaves an entry no zone names to unknown-zone alone", () => {
    repo.put("src/billing/helpers/now.ts", "export const now = Date.now();\n");
    const found = crossingsOf(SCOPE, repo.run({ json: true }));
    expect(found).toContainEqual(["unknown-zone", "billing/helpers", "helpers"]);
    expect(found.filter(([, from]) => from === "billing/helpers/now.ts")).toEqual([]);
  });
});

describe("a process member is one entry per file, and a bare process is none", () => {
  const SCOPE = "packages/app";
  const FILES: Record<string, string> = {
    "tsconfig.json": TSCONFIG,
    "src/billing/application/clock.ts":
      "export const t = () => [process.hrtime(), process.hrtime.bigint()];\n",
    "src/billing/application/two.ts":
      "export const t = () => [process.hrtime(), process.platform];\n",
    "src/billing/application/pure.ts": [
      "export type P = typeof process.platform;",
      "const p = process;",
      "export const a = (k: string) => [p, process[k]];",
    ].join("\n"),
    "src/billing/adapters/driven/run.ts":
      "export const r = [process.hrtime(), process.platform];\n",
    "src/lib/util.ts": "export const u = [process.hrtime(), process.platform];\n",
    "src/other.ts": "export const o = [process.hrtime(), process.platform];\n",
  };
  let repo: BoundaryRepo;
  beforeEach(() => {
    repo = boundaryRepo(SCOPE, FILES, { features: { [SCOPE]: ["billing"] } });
  });
  afterEach(() => repo.dispose());

  it("records two members of one file as two entries and one member read twice as one", () => {
    expect(crossingsOf(SCOPE, repo.run({ json: true }))).toEqual([
      [IMPURE, "billing/application/clock.ts", "process.hrtime"],
      [IMPURE, "billing/application/two.ts", "process.hrtime"],
      [IMPURE, "billing/application/two.ts", "process.platform"],
    ]);
  });

  it("passes a second read of a member in a file that is already ledgered for it", () => {
    expect(repo.run({ acceptCrossings: true, reason: "today" }).code).toBe(0);
    const seeded = ledgerText(repo);
    repo.put(
      "src/billing/application/two.ts",
      "export const t = () => [process.hrtime(), process.hrtime.bigint(), process.platform];\n",
    );
    const run = repo.run({ ci: true });
    expect(run.code).toBe(0);
    expect(ledgerText(repo)).toBe(seeded);
  });
});

describe("--migrate-ceilings counts import edges only and seeds the impure uses the count never saw", () => {
  const SCOPE = "packages/app";
  const FILES: Record<string, string> = {
    "tsconfig.json": TSCONFIG,
    "src/env.ts": "export const ci = process.env.CI;\n",
    "src/billing/index.ts": "export const b = 1;\n",
    "src/billing/adapters/driven/db.ts": "export const db = 1;\n",
    "src/lib/util.ts":
      'import { db } from "../billing/adapters/driven/db.js";\nexport const u = db;\n',
    "src/billing/application/price.ts": "export const price = () => Date.now();\n",
  };
  const RULES = { features: { [SCOPE]: ["billing"] }, lib: ["lib"] };
  let repo: BoundaryRepo;
  beforeEach(() => {
    repo = boundaryRepo(SCOPE, FILES, RULES);
  });
  afterEach(() => repo.dispose());

  const recordCount = (count: number) =>
    fs.writeFileSync(repo.legacyFile, JSON.stringify({ default: 0, scopes: { [SCOPE]: count } }));

  it("migrates a scope held exactly at its ceiling that also holds an impure use, then gates green", () => {
    recordCount(1);
    const { code, stdout } = repo.run({ migrateCeilings: true });
    expect(code).toBe(0);
    expect(stdout).toContain("seeded boundary-ledger.json with 2 crossing(s)");
    const { entries } = ledgerOf(repo);
    expect(entries.map((e) => [e.kind, e.specifier])).toEqual([
      [IMPURE, "Date.now"],
      ["lib-imports-feature", "../billing/adapters/driven/db.js"],
    ]);
    expect(new Set(entries.map((e) => e.reason))).toEqual(new Set([MIGRATED_REASON]));
    expect(fs.existsSync(repo.legacyFile)).toBe(false);
    const green = repo.run({ ci: true });
    expect(green.code).toBe(0);
    expect(green.stdout).toContain("2 recorded crossing(s), none new");
  });

  it("still refuses a scope whose import crossings exceed the count", () => {
    recordCount(0);
    const { code, errors } = repo.run({ migrateCeilings: true });
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain(
      "packages/app: 1 crossing(s) against a recorded ceiling of 0",
    );
    expect(fs.existsSync(repo.ledgerFile)).toBe(false);
  });
});

describe("a type-only import opens nothing, in any spelling", () => {
  const SCOPE = "packages/app";
  const OPENS_NOTHING = [
    'import type { Stats } from "node:fs";',
    'import { type Stats } from "node:fs";',
    'import { type Stats, type Dirent } from "node:fs";',
    'export type { Stats } from "node:fs";',
    'export { type Stats } from "node:fs";',
    'import type fs = require("node:fs");',
    'type S = import("node:fs").Stats;',
    'type T = typeof import("node:fs");',
    'type R = Awaited<ReturnType<typeof import("node:fs/promises").readFile>>;',
    'import type { ChildProcess } from "node:child_process";',
    'import { type ChildProcess } from "node:child_process";',
    'declare module "x" { import fs from "node:fs"; }',
  ];
  const OPENS_ONE = [
    ['import fs from "node:fs";', "node:fs"],
    ['import * as fs from "node:fs";', "node:fs"],
    ['import "node:fs";', "node:fs"],
    ['import { type Stats, readFileSync } from "node:fs";', "node:fs"],
    ['export { readFileSync } from "node:fs";', "node:fs"],
    ['import fs = require("node:fs");', "node:fs"],
    ['export const load = async () => await import("node:fs");', "node:fs"],
    ['import { type Stats } from "node:fs";\nimport fs from "node:fs";', "node:fs"],
    ['import { spawn } from "node:child_process";', "node:child_process"],
    ['import { type ChildProcess, spawn } from "node:child_process";', "node:child_process"],
  ] as const;

  const FILES: Record<string, string> = {
    "tsconfig.json": TSCONFIG,
    "src/billing/index.ts": "export const i = 1;\n",
    ...Object.fromEntries(
      OPENS_NOTHING.map((body, i) => [`src/billing/application/none${i}.ts`, `${body}\n`]),
    ),
    ...Object.fromEntries(
      OPENS_ONE.map(([body], i) => [`src/billing/application/one${i}.ts`, `${body}\n`]),
    ),
  };
  let repo: BoundaryRepo;
  beforeEach(() => {
    repo = boundaryRepo(SCOPE, FILES, { features: { [SCOPE]: ["billing"] } });
  });
  afterEach(() => repo.dispose());

  it("reports one entry for each spelling that opens a module and none for the rest", () => {
    const found = crossingsOf(SCOPE, repo.run({ json: true }));
    const expected = OPENS_ONE.map(([, row], i) => [IMPURE, `billing/application/one${i}.ts`, row]);
    expect(found.slice().sort()).toEqual(expected.slice().sort());
  });

  it("counts a file that names a module's types and also imports it as one use", () => {
    const both = violationsOf(repo.run({ json: true })).filter((v) => v.from.endsWith("/one7.ts"));
    expect(both.map((v) => v.specifier)).toEqual(["node:fs"]);
  });
});
