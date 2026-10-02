import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BoundaryRepo, boundaryRepo, type GateRun } from "../test-helpers/boundary-repo.js";
import { type BoundaryLedger, readBoundaryLedger } from "./ledger.js";
import { MIGRATED_REASON } from "./migrate.js";
import type { ProcessMembers } from "./process-members.js";
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

// `[kind, file under <scope>/src, door or specifier]`: what a reader checks a report for.
function crossingsOf(scope: string, run: GateRun): string[][] {
  const root = `${scope}/src/`;
  return violationsOf(run).map((v) => [v.kind, v.from.replace(root, ""), v.specifier]);
}

const pruneLines = (stdout: string): string[] => {
  const lines = stdout.split("\n");
  const head = lines.findIndex((line) => line.startsWith("pruned "));
  return head === -1 ? [] : lines.slice(head + 1).filter((line) => line.startsWith("  "));
};

describe("a package owner adopts the doors and watches them close", () => {
  const SCOPE = "packages/app";
  const FILES: Record<string, string> = {
    "tsconfig.json": TSCONFIG,
    "src/env.ts": "export const ci = process.env.CI;\nexport const home = process.env.HOME;\n",
    "src/credentials.ts":
      'import { readFileSync } from "node:fs";\nexport const read = readFileSync;\n',
    "src/billing/flows/charge.ts": "export const charge = process.env.CI;\n",
    "src/billing/flows/refund.ts": 'export const refund = process.env["CI"];\n',
    "src/users/flows/login.ts": "const { CI } = process.env;\nexport const login = CI;\n",
    "src/users/store/session.ts": 'const key = "CI";\nexport const session = process.env[key];\n',
    "src/reports/flows/export.ts": "const { env } = process;\nexport const exported = env.CI;\n",
    "src/lib/ci.ts": "export const ci = Boolean(process.env.CI);\n",
    "src/billing/store/token.ts":
      'import { readFileSync } from "node:fs";\nexport const token = readFileSync;\n',
    "src/users/store/auth.ts":
      'import { readFile } from "node:fs/promises";\nexport const auth = readFile;\n',
    "src/reports/flows/upload.ts": 'export const load = () => import("node:fs");\n',
    "src/billing/rules/price.ts":
      "export const price = (n: number) => (process.env.DISCOUNT ? n * 0.9 : n) * Date.now();\n",
    "src/users/rules/rank.ts": "export const rank = () => [Math.random(), crypto.randomUUID()];\n",
    "src/reports/rules/format.ts": [
      "export const format = (line: string) => {",
      "  console.log(line);",
      "  setTimeout(() => {}, 1);",
      '  fetch("u");',
      "  return new Date();",
      "};",
    ].join("\n"),
    "src/reports/rules/pure.ts": [
      "type F = (u: string) => unknown;",
      "export type Env = typeof process.env;",
      "export const epoch = new Date(0);",
      'export const parsed = Date.parse("x");',
      'export const call = (fetch: F) => fetch("u");',
    ].join("\n"),
  };
  const RULES = {
    features: { [SCOPE]: ["billing", "users", "reports"] },
    lib: ["lib"],
    doors: { [SCOPE]: { "process.env": ["src/env.ts"], "node:fs": ["src/credentials.ts"] } },
  };
  const DOOR = "door-outside-owner";
  const IMPURE = "impure-rules";
  const NINE_DOORS_EIGHT_GLOBALS = [
    [DOOR, "billing/flows/charge.ts", "process.env"],
    [DOOR, "billing/flows/refund.ts", "process.env"],
    [DOOR, "billing/store/token.ts", "node:fs"],
    [DOOR, "lib/ci.ts", "process.env"],
    [DOOR, "reports/flows/export.ts", "process.env"],
    [DOOR, "reports/flows/upload.ts", "node:fs"],
    [DOOR, "users/flows/login.ts", "process.env"],
    [DOOR, "users/store/auth.ts", "node:fs"],
    [DOOR, "users/store/session.ts", "process.env"],
    [IMPURE, "billing/rules/price.ts", "Date.now"],
    [IMPURE, "billing/rules/price.ts", "process.env"],
    [IMPURE, "reports/rules/format.ts", "console"],
    [IMPURE, "reports/rules/format.ts", "fetch"],
    [IMPURE, "reports/rules/format.ts", "new Date()"],
    [IMPURE, "reports/rules/format.ts", "setTimeout"],
    [IMPURE, "users/rules/rank.ts", "crypto.randomUUID"],
    [IMPURE, "users/rules/rank.ts", "Math.random"],
  ];

  let repo: BoundaryRepo;
  beforeEach(() => {
    repo = boundaryRepo(SCOPE, FILES, RULES);
  });
  afterEach(() => repo.dispose());

  it("reports 9 door crossings and 8 globals in rules/, none from an owner or a pure file", () => {
    const run = repo.run({ json: true });
    expect(run.code).toBe(0);
    expect(crossingsOf(SCOPE, run)).toEqual(NINE_DOORS_EIGHT_GLOBALS);
  });

  it("seeds 17 entries once, fails a new use alone, and prunes the ones that close", () => {
    // (b) seed
    const reason = "adopting doors";
    expect(repo.run({ acceptCrossings: true, reason }).code).toBe(0);
    expect(ledgerOf(repo).entries).toHaveLength(17);
    expect(new Set(ledgerOf(repo).entries.map((e) => e.reason))).toEqual(new Set([reason]));
    const seeded = ledgerText(repo);
    const green = repo.run({ ci: true });
    expect(green.code).toBe(0);
    expect(green.stdout).toContain("17 recorded crossing(s), none new");
    expect(ledgerText(repo)).toBe(seeded);

    // (c) three new uses fail alone; a new read in an already-ledgered file is not a new crossing
    repo.put("src/users/flows/logout.ts", "export const out = process.env.CI;\n");
    repo.put("src/billing/rules/tax.ts", "export const tax = () => Date.now();\n");
    repo.put(
      "src/reports/store/dump.ts",
      'import { writeFileSync } from "node:fs";\nexport const dump = writeFileSync;\n',
    );
    repo.put(
      "src/billing/flows/charge.ts",
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
      [DOOR, "reports/store/dump.ts", "node:fs"],
      [DOOR, "users/flows/logout.ts", "process.env"],
      [IMPURE, "billing/rules/tax.ts", "Date.now"],
    ]);
    expect(ledgerText(repo)).toBe(seeded);

    // (d) accept them, then close two uses
    expect(repo.run({ acceptCrossings: true, reason: "three more" }).code).toBe(0);
    expect(ledgerOf(repo).entries).toHaveLength(20);
    repo.put(
      "src/billing/flows/refund.ts",
      'import { ci } from "../../env.js";\nexport const refund = ci;\n',
    );
    repo.put("src/billing/store/token.ts", "export const token = 1;\n");
    const pruned = repo.run({ ci: true });
    expect(pruned.code).toBe(0);
    expect(pruned.stdout).toContain(
      "pruned 2 boundary-ledger.json entries whose crossing is gone:",
    );
    expect(pruneLines(pruned.stdout)).toEqual([
      `  ${SCOPE}  B5 ${DOOR}  ${SCOPE}/src/billing/flows/refund.ts -> process.env  — ${reason}`,
      `  ${SCOPE}  B5 ${DOOR}  ${SCOPE}/src/billing/store/token.ts -> node:fs  — ${reason}`,
    ]);
    expect(ledgerOf(repo).entries).toHaveLength(18);

    // (e) a settled ledger is a fixed point
    const settled = ledgerText(repo);
    for (const _ of [1, 2]) {
      const again = repo.run({ ci: true });
      expect(again.code).toBe(0);
      expect(again.stdout).not.toContain("pruned");
      expect(ledgerText(repo)).toBe(settled);
    }
  });

  it("polices a test file and a script outside src like any other file: nothing is exempt", () => {
    repo.put("src/billing/flows/charge.test.ts", "export const t = process.env.CI;\n");
    repo.put(
      "scripts/seed.ts",
      'import { readFileSync } from "node:fs";\nexport const s = readFileSync;\n',
    );
    const found = violationsOf(repo.run({ json: true })).map((v) => [
      v.kind,
      v.from.replace(`${SCOPE}/`, ""),
      v.specifier,
    ]);
    expect(found).toContainEqual([DOOR, "src/billing/flows/charge.test.ts", "process.env"]);
    expect(found).toContainEqual([DOOR, "scripts/seed.ts", "node:fs"]);
  });

  it("renders a door as B5 and a global in rules/ as B2, with a fix that names `doors`", () => {
    const report = repo.run();
    expect(report.stdout).toContain(`B5 ${DOOR}  ${SCOPE}/src/lib/ci.ts -> process.env\n`);
    expect(report.stdout).toContain(
      `B2 ${IMPURE}        ${SCOPE}/src/billing/rules/price.ts -> Date.now\n`,
    );
    expect(report.stdout).not.toContain('("process.env")');

    const failed = repo.run({ ci: true });
    expect(failed.code).toBe(1);
    expect(failed.stdout).toContain("BOUNDARY LEDGER FAILED — 17 crossing(s)");
    expect(failed.stdout).toContain(
      `${SCOPE}  B5 ${DOOR}  ${SCOPE}/src/lib/ci.ts -> process.env\n`,
    );
    expect(failed.stdout).toContain(
      `${SCOPE}  B2 ${IMPURE}  ${SCOPE}/src/billing/rules/price.ts -> Date.now\n`,
    );
    expect(failed.stdout).toContain("`doors` declaration");
    expect(failed.stdout).toContain("--accept-crossings");
  });

  it("keeps `--json` to the shape every violation already has", () => {
    const found = violationsOf(repo.run({ json: true }));
    expect(found.find((v) => v.from.endsWith("src/lib/ci.ts"))).toEqual({
      kind: DOOR,
      from: `${SCOPE}/src/lib/ci.ts`,
      to: null,
      specifier: "process.env",
      typeOnly: false,
    });
    expect(
      found.find((v) => v.from.endsWith("rules/price.ts") && v.specifier === "Date.now"),
    ).toEqual({
      kind: IMPURE,
      from: `${SCOPE}/src/billing/rules/price.ts`,
      feature: "billing",
      to: null,
      specifier: "Date.now",
      typeOnly: false,
      global: true,
    });
  });
});

describe("a rules/ file that reads the world still passes as pure at main (#510)", () => {
  const SCOPE = "services/shop";
  const FILES: Record<string, string> = {
    "tsconfig.json": TSCONFIG,
    "src/billing/rules/price.ts": [
      "export const price = (key: string) => [",
      "  process.env.DISCOUNT,",
      "  process.env.TAX,",
      "  process.env[key],",
      "  Date.now(),",
      "];",
    ].join("\n"),
    "src/billing/rules/tax.ts": 'export const tax = () => fetch("u");\n',
    "src/orders/rules/id.ts": "export const id = () => [crypto.randomUUID(), Math.random()];\n",
    "src/orders/rules/retry.ts":
      'export const retry = () => {\n  setTimeout(() => {}, 1);\n  console.log("x");\n};\n',
    "src/users/rules/session.ts":
      "export const session = () => [new Date(), globalThis, process.argv];\n",
    "src/shipping/rules/total.ts": [
      "type F = (u: string) => unknown;",
      'export const total = (ts: number, fetch: F) => [new Date(ts), fetch("u")];',
    ].join("\n"),
    "src/billing/flows/charge.ts": 'export const c = [process.env.CI, Date.now(), fetch("u")];\n',
    "src/orders/flows/place.ts":
      "export const p = [crypto.randomUUID(), Math.random(), console.log];\n",
    "src/users/flows/login.ts": "export const l = [new Date(), globalThis, process.argv];\n",
    "src/shipping/flows/ship.ts": "export const s = [setTimeout, setInterval, process.exit];\n",
  };
  const RULES = {
    features: { [SCOPE]: ["billing", "orders", "users", "shipping"] },
    contracts: ["@acme/contracts"],
  };
  let repo: BoundaryRepo;
  beforeEach(() => {
    repo = boundaryRepo(SCOPE, FILES, RULES);
  });
  afterEach(() => repo.dispose());

  const impureLines = (run: GateRun) =>
    run.stdout.split("\n").filter((line) => line.includes("B2 impure-rules"));

  it("lists exactly 10 uses, adopts them, and shrinks as each one is removed", () => {
    const failed = repo.run({ ci: true });
    expect(failed.code).toBe(1);
    expect(impureLines(failed)).toHaveLength(10);
    expect(failed.stdout).not.toContain("total.ts");
    expect(failed.stdout).not.toMatch(/flows\/\w+\.ts ->/);
    const report = repo.run();
    expect(report.code).toBe(0);
    expect(impureLines(report)).toHaveLength(10);
    expect(report.stdout).toContain("10 violation(s)");

    expect(repo.run({ acceptCrossings: true, reason: "rules reach the world today" }).code).toBe(0);
    const { entries } = ledgerOf(repo);
    expect(entries).toHaveLength(10);
    expect(entries.every((e) => e.reason === "rules reach the world today")).toBe(true);
    const seeded = ledgerText(repo);
    for (const _ of [1, 2]) {
      expect(repo.run({ ci: true }).code).toBe(0);
      expect(ledgerText(repo)).toBe(seeded);
    }

    repo.put(
      "src/billing/rules/price.ts",
      "export const price = (key: string) => [process.env.DISCOUNT, process.env.TAX, process.env[key]];\n",
    );
    const closed = repo.run({ ci: true });
    expect(closed.code).toBe(0);
    expect(closed.stdout).toContain("pruned 1 boundary-ledger.json entry whose crossing is gone:");
    expect(closed.stdout).toContain("services/shop/src/billing/rules/price.ts -> Date.now");
    expect(ledgerOf(repo).entries).toHaveLength(9);

    const settled = ledgerText(repo);
    repo.put(
      "src/orders/rules/retry.ts",
      'export const retry = () => {\n  setTimeout(() => {}, 1);\n  console.log("x");\n  process.exit(1);\n};\n',
    );
    const grown = repo.run({ ci: true });
    expect(grown.code).toBe(1);
    expect(impureLines(grown)).toHaveLength(1);
    expect(grown.stdout).toContain("services/shop/src/orders/rules/retry.ts -> process.exit");
    expect(ledgerText(repo)).toBe(settled);
  });
});

describe("a global never collides with an import of the package named like it", () => {
  const SCOPE = "packages/app";
  const FILES: Record<string, string> = {
    "tsconfig.json": TSCONFIG,
    "src/billing/rules/net.ts": [
      'import "fetch";',
      'import "console";',
      'import "process";',
      'export const go = () => { fetch("u"); console.log("x"); process.exit(1); };',
    ].join("\n"),
  };
  let repo: BoundaryRepo;
  beforeEach(() => {
    repo = boundaryRepo(SCOPE, FILES, { features: { [SCOPE]: ["billing"] } });
  });
  afterEach(() => repo.dispose());

  it("records the import and the global as two entries each", () => {
    expect(repo.run({ acceptCrossings: true, reason: "legacy" }).code).toBe(0);
    const pairs = ledgerOf(repo).entries.map((e) => [e.specifier, e.global === true]);
    expect(pairs).toEqual([
      ["console", false],
      ["console", true],
      ["fetch", false],
      ["fetch", true],
      ["process", false],
      ["process.exit", true],
    ]);
    const settled = ledgerText(repo);
    expect(repo.run({ ci: true }).code).toBe(0);
    expect(ledgerText(repo)).toBe(settled);
  });

  it("fails on the global alone when only the import was ever recorded", () => {
    const imports = ["console", "fetch", "process"].map((specifier) => ({
      scope: SCOPE,
      kind: "impure-rules",
      from: `${SCOPE}/src/billing/rules/net.ts`,
      to: null,
      specifier,
    }));
    fs.writeFileSync(repo.ledgerFile, JSON.stringify({ entries: imports }));
    const failed = repo.run({ ci: true, json: true });
    expect(failed.code).toBe(1);
    const verdict: { unrecorded: { specifier: string; global?: true }[] } = JSON.parse(
      failed.stdout,
    );
    expect(verdict.unrecorded.map((e) => [e.specifier, e.global])).toEqual([
      ["console", true],
      ["fetch", true],
      ["process.exit", true],
    ]);
  });

  it("passes a ledger written before this change on a repo with no door use", () => {
    repo.put("src/billing/rules/net.ts", 'import "zod";\nexport const z = 1;\n');
    const legacy = {
      entries: [
        {
          scope: SCOPE,
          kind: "impure-rules",
          from: `${SCOPE}/src/billing/rules/net.ts`,
          to: null,
          specifier: "zod",
          reason: "recorded debt",
        },
      ],
    };
    fs.writeFileSync(repo.ledgerFile, JSON.stringify(legacy));
    const run = repo.run({ ci: true });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("1 recorded crossing(s), none new");
  });
});

describe("a rules/ file is the zone where no door has an owner", () => {
  const SCOPE = "packages/app";
  const FILES: Record<string, string> = {
    "tsconfig.json": TSCONFIG,
    "src/env.ts": "export const ci = process.env.CI;\n",
    "src/credentials.ts":
      'import { readFileSync } from "node:fs";\nexport const r = readFileSync;\n',
    "src/billing/rules/io.ts":
      'import { readFileSync } from "node:fs";\nexport const x = [process.env.A, readFileSync];\n',
    "src/billing/rules/types.ts": 'import type { Stats } from "node:fs";\nexport type S = Stats;\n',
    "src/billing/store/stat.ts": 'import type { Stats } from "node:fs";\nexport type T = Stats;\n',
  };
  const RULES = {
    features: { [SCOPE]: ["billing"] },
    doors: { [SCOPE]: { "process.env": ["src/env.ts"], "node:fs": ["src/credentials.ts"] } },
  };
  let repo: BoundaryRepo;
  beforeEach(() => {
    repo = boundaryRepo(SCOPE, FILES, RULES);
  });
  afterEach(() => repo.dispose());

  it("reports a declared door used in rules/ once, as impure-rules, never as door-outside-owner", () => {
    const found = violationsOf(repo.run({ json: true }));
    expect(found.some((v) => v.kind === "door-outside-owner")).toBe(false);
    expect(
      found.map((v) => [v.kind, v.from.replace(`${SCOPE}/src/`, ""), v.specifier, "global" in v]),
    ).toEqual([
      ["impure-rules", "billing/rules/io.ts", "node:fs", false],
      ["impure-rules", "billing/rules/io.ts", "process.env", true],
      ["impure-rules", "billing/rules/types.ts", "node:fs", false],
    ]);
  });

  it("keeps a type-only import of a door module from opening it outside rules/", () => {
    const found = violationsOf(repo.run({ json: true }));
    expect(found.filter((v) => v.from.endsWith("store/stat.ts"))).toEqual([]);
    expect(found.find((v) => v.from.endsWith("rules/types.ts"))).toMatchObject({ typeOnly: true });
  });
});

describe("process.stdin.isTTY is a door narrower than process.stdin", () => {
  const SCOPE = "packages/app";
  const FILES: Record<string, string> = {
    "tsconfig.json": TSCONFIG,
    "src/terminal.ts": "export const tty = process.stdin.isTTY;\n",
    "src/other.ts": "export const tty = process.stdin.isTTY;\n",
    "src/listen.ts": 'export const listen = () => process.stdin.on("data", () => {});\n',
    "src/billing/rules/input.ts":
      'export const input = () => process.stdin.on("data", () => {});\n',
  };
  let repo: BoundaryRepo;
  beforeEach(() => {
    repo = boundaryRepo(SCOPE, FILES, {
      features: { [SCOPE]: ["billing"] },
      doors: { [SCOPE]: { "process.stdin.isTTY": ["src/terminal.ts"] } },
    });
  });
  afterEach(() => repo.dispose());

  it("passes the owner, fails another reader, and polices an undeclared use only inside rules/", () => {
    expect(crossingsOf(SCOPE, repo.run({ json: true }))).toEqual([
      ["door-outside-owner", "other.ts", "process.stdin.isTTY"],
      ["impure-rules", "billing/rules/input.ts", "process.stdin"],
    ]);
  });

  it("lets a broader declaration claim what the narrower one does not", () => {
    fs.writeFileSync(
      repo.rulesFile,
      JSON.stringify({
        features: { [SCOPE]: ["billing"] },
        doors: {
          [SCOPE]: {
            "process.stdin": ["src/listen.ts"],
            "process.stdin.isTTY": ["src/terminal.ts"],
          },
        },
      }),
    );
    expect(crossingsOf(SCOPE, repo.run({ json: true }))).toEqual([
      ["door-outside-owner", "other.ts", "process.stdin.isTTY"],
      ["impure-rules", "billing/rules/input.ts", "process.stdin"],
    ]);
  });
});

describe("a bad `doors` declaration exits 2, names the problem and writes nothing", () => {
  const SCOPE = "packages/app";
  const FILES: Record<string, string> = {
    "tsconfig.json": TSCONFIG,
    "src/env.ts": "export const ci = process.env.CI;\n",
    "src/billing/index.ts": "export const b = 1;\n",
  };
  let repo: BoundaryRepo;
  beforeEach(() => {
    repo = boundaryRepo(SCOPE, FILES, {});
  });
  afterEach(() => repo.dispose());

  const refused = (doors: unknown, features: unknown = { [SCOPE]: ["billing"] }): string => {
    const file = path.join(repo.root, "bad.json");
    fs.writeFileSync(file, JSON.stringify({ features, doors }));
    let all = "";
    for (const flags of [{}, { ci: true }, { acceptCrossings: true, reason: "x" }]) {
      const { code, errors, stdout } = repo.run({ ...flags, rules: file });
      expect(code).toBe(2);
      expect(stdout).toBe("");
      all += errors.join("\n");
    }
    expect(fs.existsSync(repo.ledgerFile)).toBe(false);
    return all;
  };

  it("refuses a door outside the catalog, so a typo cannot silently enforce nothing", () => {
    expect(refused({ [SCOPE]: { "Math.randm": ["src/env.ts"] } })).toContain(
      'door "Math.randm" in "packages/app" is not in the door catalog',
    );
    expect(refused({ [SCOPE]: { "node:fs.readFileSync": ["src/env.ts"] } })).toContain(
      "not in the door catalog",
    );
    expect(refused({ [SCOPE]: { "process.": ["src/env.ts"] } })).toContain(
      "not in the door catalog",
    );
  });

  it("refuses the bare `process`, naming the family instead of listing its members", () => {
    const message = refused({ [SCOPE]: { process: ["src/env.ts"] } });
    expect(message).toContain(
      'door "process" in "packages/app" is the whole family process.<member>',
    );
    expect(message).not.toContain("process.env");
    expect(message).not.toContain("not in the door catalog");
  });

  it("refuses a scope that does not declare features", () => {
    expect(refused({ "packages/other": { "process.env": ["src/env.ts"] } })).toContain(
      '"doors" declares scope "packages/other", which declares no "features"',
    );
  });

  it("refuses an owner that names no file in the scope", () => {
    const message = refused({ [SCOPE]: { "process.env": ["src/nope.ts"] } });
    expect(message).toContain("name no file the scope loads");
    expect(message).toContain("process.env: src/nope.ts");
    expect(refused({ [SCOPE]: { "process.env": ["src"] } })).toContain("process.env: src");
  });

  it("refuses an owner under src/<feature>/rules/", () => {
    expect(refused({ [SCOPE]: { "process.env": ["src/billing/rules/env.ts"] } })).toContain(
      'owner "src/billing/rules/env.ts" of door "process.env" in "packages/app" is under src/billing/rules/',
    );
  });

  it("refuses a member the running process lacks and names no far-fetched one", () => {
    const message = refused({ [SCOPE]: { "process.zzzzzzzz": ["src/env.ts"] } });
    expect(message).toContain(
      `door "process.zzzzzzzz" in "packages/app" is not a member of process on Node ${process.version} (${process.platform}).`,
    );
    expect(message).not.toContain("Did you mean");
  });

  it("accepts a deeper static path under a door, and a member Node's process has", () => {
    const file = path.join(repo.root, "ok.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        features: { [SCOPE]: ["billing"] },
        doors: {
          [SCOPE]: {
            "process.env.CI": ["src/env.ts"],
            "process.stdin.isTTY": ["src/env.ts"],
            "process.platform": ["src/env.ts"],
            "process.hrtime": ["src/env.ts"],
            "process.hrtime.bigint": ["src/env.ts"],
          },
        },
      }),
    );
    expect(repo.run({ rules: file }).code).toBe(0);
  });
});

describe("a package owner who mistypes one door among several is told which, and the real ones keep working (#516)", () => {
  const SCOPE = "packages/app";
  const DOOR = "door-outside-owner";
  const FILES: Record<string, string> = {
    "tsconfig.json": TSCONFIG,
    "src/env.ts": "export const ci = process.env.CI;\n",
    "src/terminal.ts": "export const tty = process.stdin.isTTY;\n",
    "src/signals.ts": 'export const watch = () => process.on("exit", () => {});\n',
    "src/clock.ts": "export const tick = () => process.hrtime.bigint();\n",
    "src/billing/flows/charge.ts": "export const charge = process.env.CI;\n",
    "src/users/flows/login.ts": "export const login = process.stdin.isTTY;\n",
    "src/users/store/session.ts": "export const session = process.env.HOME;\n",
    "src/reports/flows/export.ts": 'export const out = () => process.on("exit", () => {});\n',
    "src/lib/timer.ts": "export const timer = () => process.hrtime.bigint();\n",
  };
  const REAL_DOORS = {
    "process.env": ["src/env.ts"],
    "process.stdin.isTTY": ["src/terminal.ts"],
    "process.on": ["src/signals.ts"],
    "process.hrtime.bigint": ["src/clock.ts"],
  };
  const rulesWith = (doors: Record<string, string[]>) => ({
    features: { [SCOPE]: ["billing", "users", "reports"] },
    lib: ["lib"],
    doors: { [SCOPE]: doors },
  });
  const MISTYPED: [door: string, nearest: string][] = [
    ["process.envv", "process.env"],
    ["process.ENV", "process.env"],
    ["process.stdinn.isTTY", "process.stdin"],
  ];

  let repo: BoundaryRepo;
  beforeEach(() => {
    repo = boundaryRepo(SCOPE, FILES, rulesWith(REAL_DOORS));
  });
  afterEach(() => repo.dispose());

  it("refuses each mistyped door in every mode, names it and the nearest member, and writes nothing", () => {
    for (const [door, nearest] of MISTYPED) {
      const file = path.join(repo.root, "mistyped.json");
      fs.writeFileSync(file, JSON.stringify(rulesWith({ ...REAL_DOORS, [door]: ["src/env.ts"] })));
      for (const seeded of [false, true]) {
        if (seeded) expect(repo.run({ acceptCrossings: true, reason: "adopting" }).code).toBe(0);
        const before = seeded ? ledgerText(repo) : null;
        for (const flags of [{}, { ci: true }, { acceptCrossings: true, reason: "x" }]) {
          const { code, stdout, errors } = repo.run({ ...flags, rules: file });
          expect(code).toBe(2);
          expect(stdout).toBe("");
          expect(errors).toEqual([
            `door "${door}" in "${SCOPE}" is not a member of process on Node ${process.version} (${process.platform}). ` +
              `Did you mean ${nearest}?`,
          ]);
        }
        expect(fs.existsSync(repo.ledgerFile)).toBe(seeded);
        if (before !== null) expect(ledgerText(repo)).toBe(before);
      }
      fs.rmSync(repo.ledgerFile, { force: true });
    }
  });

  it("runs the whole adopt, fail, prune sequence over the all-real declaration", () => {
    const entry = (file: string, specifier: string) => [DOOR, file, specifier];
    const reads = [
      entry("billing/flows/charge.ts", "process.env"),
      entry("lib/timer.ts", "process.hrtime.bigint"),
      entry("reports/flows/export.ts", "process.on"),
      entry("users/flows/login.ts", "process.stdin.isTTY"),
      entry("users/store/session.ts", "process.env"),
    ];
    const report = repo.run({ json: true });
    expect(report.code).toBe(0);
    expect(crossingsOf(SCOPE, report)).toEqual(reads);

    const reason = "adopting doors";
    expect(repo.run({ acceptCrossings: true, reason }).code).toBe(0);
    expect(ledgerOf(repo).entries).toHaveLength(5);
    expect(new Set(ledgerOf(repo).entries.map((e) => e.reason))).toEqual(new Set([reason]));
    const seeded = ledgerText(repo);
    const green = repo.run({ ci: true });
    expect(green.code).toBe(0);
    expect(green.stdout).toContain("5 recorded crossing(s), none new");
    expect(ledgerText(repo)).toBe(seeded);

    repo.put("src/billing/store/audit.ts", "export const audit = () => process.hrtime.bigint();\n");
    const failed = repo.run({ ci: true, json: true });
    expect(failed.code).toBe(1);
    const verdict: { unrecorded: { kind: string; from: string; specifier: string }[] } = JSON.parse(
      failed.stdout,
    );
    expect(
      verdict.unrecorded.map((e) => [e.kind, e.from.replace(`${SCOPE}/src/`, ""), e.specifier]),
    ).toEqual([entry("billing/store/audit.ts", "process.hrtime.bigint")]);
    expect(ledgerText(repo)).toBe(seeded);

    expect(repo.run({ acceptCrossings: true, reason: "the audit trail" }).code).toBe(0);
    expect(ledgerOf(repo).entries).toHaveLength(6);
    repo.put("src/billing/flows/charge.ts", "export const charge = 1;\n");
    repo.put("src/lib/timer.ts", "export const timer = 1;\n");
    const pruned = repo.run({ ci: true });
    expect(pruned.code).toBe(0);
    expect(pruned.stdout).toContain(
      "pruned 2 boundary-ledger.json entries whose crossing is gone:",
    );
    expect(pruneLines(pruned.stdout)).toEqual([
      `  ${SCOPE}  B5 ${DOOR}  ${SCOPE}/src/billing/flows/charge.ts -> process.env  — ${reason}`,
      `  ${SCOPE}  B5 ${DOOR}  ${SCOPE}/src/lib/timer.ts -> process.hrtime.bigint  — ${reason}`,
    ]);
    expect(ledgerOf(repo).entries).toHaveLength(4);

    const settled = ledgerText(repo);
    for (const _ of [1, 2]) {
      const again = repo.run({ ci: true });
      expect(again.code).toBe(0);
      expect(again.stdout).not.toContain("pruned");
      expect(ledgerText(repo)).toBe(settled);
    }
  });
});

describe("a team whose CI runs on more than one host learns from the refusal which host refused a process door (#518)", () => {
  const SCOPE = "packages/app";
  const DOOR = "door-outside-owner";
  const FILES: Record<string, string> = {
    "tsconfig.json": TSCONFIG,
    "src/env.ts": "export const ci = process.env.CI;\n",
    "src/billing/flows/charge.ts": "export const charge = process.env.CI;\n",
    "src/users/flows/login.ts": "export const login = process.env.HOME;\n",
    "src/users/store/session.ts": "export const session = process.env.USER;\n",
    "src/reports/flows/export.ts": "export const out = process.env.PATH;\n",
    "src/lib/timer.ts": "export const timer = process.env.TZ;\n",
  };
  const FIVE_READS = [
    [DOOR, "billing/flows/charge.ts", "process.env"],
    [DOOR, "lib/timer.ts", "process.env"],
    [DOOR, "reports/flows/export.ts", "process.env"],
    [DOOR, "users/flows/login.ts", "process.env"],
    [DOOR, "users/store/session.ts", "process.env"],
  ];

  // A stand-in for the `process` a host has: which Node, which platform, which members.
  type HostName = "POSIX with IPC" | "POSIX without IPC" | "Windows";
  const HOSTS: Record<HostName, ProcessMembers> = {
    "POSIX with IPC": {
      node: "v22.1.0",
      platform: "linux",
      names: new Set(["env", "getuid", "send"]),
    },
    "POSIX without IPC": {
      node: "v20.18.0",
      platform: "linux",
      names: new Set(["env", "getuid"]),
    },
    Windows: { node: "v24.2.0", platform: "win32", names: new Set(["env"]) },
  };
  const hostNames = Object.keys(HOSTS) as HostName[];

  // One declared door per config that some host lacks, because the first problem found is the only
  // one named. `refused` says, per host, which door that host lacks.
  const CONFIGS: {
    name: string;
    doors: string[];
    refused: Partial<Record<HostName, string>>;
  }[] = [
    { name: "A", doors: ["process.env"], refused: {} },
    {
      name: "B",
      doors: ["process.env", "process.getuid"],
      refused: { Windows: "process.getuid" },
    },
    {
      name: "C",
      doors: ["process.env", "process.send"],
      refused: { "POSIX without IPC": "process.send", Windows: "process.send" },
    },
  ];

  let repo: BoundaryRepo;
  beforeEach(() => {
    repo = boundaryRepo(SCOPE, FILES, {});
  });
  afterEach(() => repo.dispose());

  // Adopt the doors under one host: the report, the ledger writer, then the gate.
  const adopt = (rules: string, members: ProcessMembers) => {
    fs.rmSync(repo.ledgerFile, { force: true });
    const report = repo.run({ json: true, rules, members });
    const accepted = repo.run({ acceptCrossings: true, reason: "x", rules, members });
    const ledger = ledgerText(repo);
    const gated = repo.run({ ci: true, rules, members });
    expect([report.code, accepted.code, gated.code]).toEqual([0, 0, 0]);
    expect(crossingsOf(SCOPE, report)).toEqual(FIVE_READS);
    expect(ledgerOf(repo).entries).toHaveLength(5);
    fs.rmSync(repo.ledgerFile);
    return { report: report.stdout, accepted: accepted.stdout, ledger, gated: gated.stdout };
  };

  it("names the door, Node version and platform of the host that refuses, and every host that accepts writes the same bytes", () => {
    for (const { name, doors, refused } of CONFIGS) {
      const rules = path.join(repo.root, `${name}.json`);
      fs.writeFileSync(
        rules,
        JSON.stringify({
          features: { [SCOPE]: ["billing", "users", "reports"] },
          lib: ["lib"],
          doors: { [SCOPE]: Object.fromEntries(doors.map((door) => [door, ["src/env.ts"]])) },
        }),
      );
      const written = [];
      for (const host of hostNames) {
        const members = HOSTS[host];
        const lacking = refused[host];
        if (lacking === undefined) {
          const first = adopt(rules, members);
          expect(adopt(rules, members), `config ${name} on ${host}, second run`).toEqual(first);
          written.push(first);
          continue;
        }
        for (const flags of [{ json: true }, { acceptCrossings: true, reason: "x" }]) {
          const { code, stdout, errors } = repo.run({ ...flags, rules, members });
          expect(code, `config ${name} on ${host}`).toBe(2);
          expect(stdout).toBe("");
          expect(errors).toHaveLength(1);
          expect(errors[0]).toContain(
            `door "${lacking}" in "${SCOPE}" is not a member of process on ` +
              `Node ${members.node} (${members.platform}).`,
          );
        }
        expect(fs.existsSync(repo.ledgerFile)).toBe(false);
      }
      expect(written.length, `config ${name} is accepted somewhere`).toBeGreaterThan(0);
      for (const bytes of written) expect(bytes).toEqual(written[0]);
    }
  });
});

describe("--migrate-ceilings counts import edges only and seeds the doors the count never saw", () => {
  const SCOPE = "packages/app";
  const FILES: Record<string, string> = {
    "tsconfig.json": TSCONFIG,
    "src/env.ts": "export const ci = process.env.CI;\n",
    "src/billing/index.ts": "export const b = 1;\n",
    "src/billing/store/db.ts": "export const db = 1;\n",
    "src/lib/util.ts": 'import { db } from "../billing/store/db.js";\nexport const u = db;\n',
    "src/billing/rules/price.ts": "export const price = () => Date.now();\n",
    "src/other.ts": "export const ci = process.env.CI;\n",
  };
  const RULES = {
    features: { [SCOPE]: ["billing"] },
    lib: ["lib"],
    doors: { [SCOPE]: { "process.env": ["src/env.ts"] } },
  };
  let repo: BoundaryRepo;
  beforeEach(() => {
    repo = boundaryRepo(SCOPE, FILES, RULES);
  });
  afterEach(() => repo.dispose());

  const recordCount = (count: number) =>
    fs.writeFileSync(repo.legacyFile, JSON.stringify({ default: 0, scopes: { [SCOPE]: count } }));

  it("migrates a scope held exactly at its ceiling that also holds a global and a door, then gates green", () => {
    recordCount(1);
    const { code, stdout } = repo.run({ migrateCeilings: true });
    expect(code).toBe(0);
    expect(stdout).toContain("seeded boundary-ledger.json with 3 crossing(s)");
    const { entries } = ledgerOf(repo);
    expect(entries.map((e) => [e.kind, e.specifier, e.global === true])).toEqual([
      ["door-outside-owner", "process.env", false],
      ["impure-rules", "Date.now", true],
      ["lib-imports-feature", "../billing/store/db.js", false],
    ]);
    expect(new Set(entries.map((e) => e.reason))).toEqual(new Set([MIGRATED_REASON]));
    expect(fs.existsSync(repo.legacyFile)).toBe(false);
    const green = repo.run({ ci: true });
    expect(green.code).toBe(0);
    expect(green.stdout).toContain("3 recorded crossing(s), none new");
  });

  it("seeds a process member beyond the old seven the same way, and the first --ci is green", () => {
    recordCount(1);
    repo.put("src/billing/rules/clock.ts", "export const t = () => process.hrtime.bigint();\n");
    const { code, stdout } = repo.run({ migrateCeilings: true });
    expect(code).toBe(0);
    expect(stdout).toContain("seeded boundary-ledger.json with 4 crossing(s)");
    const seeded = ledgerOf(repo).entries.filter((e) => e.specifier === "process.hrtime");
    expect(seeded.map((e) => [e.kind, e.global === true, e.reason])).toEqual([
      ["impure-rules", true, MIGRATED_REASON],
    ]);
    const green = repo.run({ ci: true });
    expect(green.code).toBe(0);
    expect(green.stdout).toContain("4 recorded crossing(s), none new");
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

describe("a team adopts the gate where rules/ reads any process member and files import node:fs for its types (#510)", () => {
  const SCOPE = "packages/app";
  const DOOR = "door-outside-owner";
  const IMPURE = "impure-rules";
  const FILES: Record<string, string> = {
    "tsconfig.json": TSCONFIG,
    "src/billing/rules/price.ts": [
      "export const price = () => [",
      "  process.env.DISCOUNT,",
      "  process.env.TAX,",
      "  process.hrtime(),",
      "  process.hrtime.bigint(),",
      "];",
    ].join("\n"),
    "src/billing/rules/tax.ts": "export const tax = () => process.platform;\n",
    "src/orders/rules/id.ts": [
      "const f = () => {};",
      'export const id = () => { process.on("exit", f); return process.versions.node; };',
    ].join("\n"),
    "src/orders/rules/retry.ts": [
      "export const retry = (key: string) => {",
      "  const { arch } = process;",
      "  return [process.env[key], arch];",
      "};",
    ].join("\n"),
    "src/users/rules/session.ts": "export const session = () => globalThis.process.hrtime();\n",
    "src/shipping/rules/total.ts": [
      "type Env = typeof process.env;",
      "export const total = (ts: number, process: { hrtime(): number }, env?: Env) =>",
      "  [new Date(ts), process.hrtime(), env];",
    ].join("\n"),
    "src/credentials.ts":
      'import { readFileSync } from "node:fs";\nexport const read = readFileSync;\n',
    "src/users/store/mixed.ts":
      'import { type Stats, readFileSync } from "node:fs";\nexport const m = (s: Stats) => readFileSync(s.toString());\n',
    "src/users/flows/read.ts":
      'import { readFile } from "node:fs/promises";\nexport const r = readFile;\n',
    "src/lib/io.ts": 'export const load = () => import("node:fs");\n',
    "src/billing/store/paths.ts": 'import { type Stats } from "node:fs";\nexport type P = Stats;\n',
    "src/billing/store/mode.ts":
      'import { type Stats, type Dirent } from "node:fs";\nexport type M = [Stats, Dirent];\n',
    "src/orders/store/stat.ts": 'export type S = import("node:fs").Stats;\n',
    "src/orders/flows/probe.ts": 'export type T = typeof import("node:fs");\n',
    "src/shipping/store/reexport.ts": 'export { type Stats } from "node:fs";\n',
    "src/shipping/store/eq.ts":
      'import type fs = require("node:fs");\nexport type E = typeof fs;\n',
    "src/shipping/flows/ship.ts": 'import type { Stats } from "node:fs";\nexport type X = Stats;\n',
  };
  const RULES = {
    features: { [SCOPE]: ["billing", "orders", "users", "shipping"] },
    lib: ["lib"],
    doors: { [SCOPE]: { "node:fs": ["src/credentials.ts"] } },
  };
  const TWELVE = [
    [DOOR, "lib/io.ts", "node:fs"],
    [DOOR, "users/flows/read.ts", "node:fs"],
    [DOOR, "users/store/mixed.ts", "node:fs"],
    [IMPURE, "billing/rules/price.ts", "process.env"],
    [IMPURE, "billing/rules/price.ts", "process.hrtime"],
    [IMPURE, "billing/rules/tax.ts", "process.platform"],
    [IMPURE, "orders/rules/id.ts", "process.on"],
    [IMPURE, "orders/rules/id.ts", "process.versions"],
    [IMPURE, "orders/rules/retry.ts", "process.arch"],
    [IMPURE, "orders/rules/retry.ts", "process.env"],
    [IMPURE, "users/rules/session.ts", "globalThis"],
    [IMPURE, "users/rules/session.ts", "process.hrtime"],
  ];
  const TYPES_ONLY = /paths\.ts|mode\.ts|stat\.ts|probe\.ts|reexport\.ts|eq\.ts|ship\.ts/;

  let repo: BoundaryRepo;
  beforeEach(() => {
    repo = boundaryRepo(SCOPE, FILES, RULES);
  });
  afterEach(() => repo.dispose());

  const entryLines = (run: GateRun) =>
    run.stdout.split("\n").filter((line) => line.startsWith(`  ${SCOPE}  B`));

  it("lists exactly the 12 real uses, none for a pure rules file, the owner or a file naming only types", () => {
    const report = repo.run();
    expect(report.code).toBe(0);
    expect(report.stdout).toContain("12 violation(s)");
    expect(report.stdout).not.toMatch(TYPES_ONLY);
    expect(crossingsOf(SCOPE, repo.run({ json: true }))).toEqual(TWELVE);

    const failed = repo.run({ ci: true });
    expect(failed.code).toBe(1);
    expect(failed.stdout).toContain("BOUNDARY LEDGER FAILED — 12 crossing(s)");
    expect(entryLines(failed)).toHaveLength(12);
    expect(failed.stdout).not.toMatch(TYPES_ONLY);
    expect(failed.stdout).not.toMatch(/total\.ts|credentials\.ts/);
    expect(fs.existsSync(repo.ledgerFile)).toBe(false);
  });

  it("adopts them, fails only a new member, and prunes only the one that closes", () => {
    const reason = "rules reach the world today";
    expect(repo.run({ acceptCrossings: true, reason }).code).toBe(0);
    const { entries } = ledgerOf(repo);
    expect(entries).toHaveLength(12);
    expect(entries.every((e) => e.reason === reason)).toBe(true);
    const seeded = ledgerText(repo);
    const first = repo.run({ ci: true });
    const second = repo.run({ ci: true });
    expect([first.code, second.code]).toEqual([0, 0]);
    expect(second.stdout).toBe(first.stdout);
    expect(ledgerText(repo)).toBe(seeded);

    repo.put(
      "src/billing/rules/tax.ts",
      "export const tax = () => [process.platform, process.uptime()];\n",
    );
    const grown = repo.run({ ci: true, json: true });
    expect(grown.code).toBe(1);
    const verdict: { unrecorded: { kind: string; from: string; specifier: string }[] } = JSON.parse(
      grown.stdout,
    );
    expect(verdict.unrecorded.map((e) => [e.kind, e.from, e.specifier])).toEqual([
      [IMPURE, `${SCOPE}/src/billing/rules/tax.ts`, "process.uptime"],
    ]);
    expect(ledgerText(repo)).toBe(seeded);

    expect(repo.run({ acceptCrossings: true, reason: "uptime" }).code).toBe(0);
    expect(ledgerOf(repo).entries).toHaveLength(13);
    repo.put("src/billing/rules/tax.ts", "export const tax = () => process.uptime();\n");
    const closed = repo.run({ ci: true });
    expect(closed.code).toBe(0);
    expect(closed.stdout).toContain("pruned 1 boundary-ledger.json entry whose crossing is gone:");
    expect(pruneLines(closed.stdout)).toEqual([
      `  ${SCOPE}  B2 ${IMPURE}  ${SCOPE}/src/billing/rules/tax.ts -> process.platform  — ${reason}`,
    ]);
    expect(ledgerOf(repo).entries).toHaveLength(12);

    const settled = ledgerText(repo);
    for (const _ of [1, 2]) {
      const again = repo.run({ ci: true });
      expect(again.code).toBe(0);
      expect(again.stdout).not.toContain("pruned");
      expect(ledgerText(repo)).toBe(settled);
    }
  });

  it("keeps a type-only node:fs import in rules/ as the B2 import entry it always was", () => {
    repo.put(
      "src/shipping/rules/types.ts",
      'import { type Stats } from "node:fs";\nimport type { Dirent } from "node:fs";\nexport type T = [Stats, Dirent];\n',
    );
    const found = violationsOf(repo.run({ json: true })).filter((v) =>
      v.from.endsWith("shipping/rules/types.ts"),
    );
    expect(found.map((v) => [v.kind, v.specifier, v.typeOnly, "global" in v])).toEqual([
      [IMPURE, "node:fs", false, false],
      [IMPURE, "node:fs", true, false],
    ]);
  });
});

describe("a process member is one entry per file, and only rules/ polices one nobody declared", () => {
  const SCOPE = "packages/app";
  const IMPURE = "impure-rules";
  const FILES: Record<string, string> = {
    "tsconfig.json": TSCONFIG,
    "src/billing/rules/clock.ts":
      "export const t = () => [process.hrtime(), process.hrtime.bigint()];\n",
    "src/billing/rules/two.ts": "export const t = () => [process.hrtime(), process.platform];\n",
    "src/billing/rules/pure.ts": [
      "export type P = typeof process.platform;",
      "const p = process;",
      "export const a = (k: string) => [p, process[k]];",
    ].join("\n"),
    "src/billing/index.ts": "export const i = [process.hrtime(), process.platform];\n",
    "src/billing/flows/run.ts": "export const r = [process.hrtime(), process.platform];\n",
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
      [IMPURE, "billing/rules/clock.ts", "process.hrtime"],
      [IMPURE, "billing/rules/two.ts", "process.hrtime"],
      [IMPURE, "billing/rules/two.ts", "process.platform"],
    ]);
  });

  it("passes a second read of a member in a file that is already ledgered for it", () => {
    expect(repo.run({ acceptCrossings: true, reason: "today" }).code).toBe(0);
    const seeded = ledgerText(repo);
    repo.put(
      "src/billing/rules/two.ts",
      "export const t = () => [process.hrtime(), process.hrtime.bigint(), process.platform];\n",
    );
    const run = repo.run({ ci: true });
    expect(run.code).toBe(0);
    expect(ledgerText(repo)).toBe(seeded);
  });
});

describe("a ledger the previous release wrote still gates the seven names it listed", () => {
  const SCOPE = "packages/app";
  let repo: BoundaryRepo;
  beforeEach(() => {
    repo = boundaryRepo(
      SCOPE,
      {
        "tsconfig.json": TSCONFIG,
        "src/billing/rules/cfg.ts": "export const c = [process.env.X, process.cwd()];\n",
      },
      { features: { [SCOPE]: ["billing"] } },
    );
  });
  afterEach(() => repo.dispose());

  it("passes with entries for process.env and process.cwd on a repo whose uses are unchanged", () => {
    const entries = ["process.env", "process.cwd"].map((specifier) => ({
      scope: SCOPE,
      kind: "impure-rules",
      from: `${SCOPE}/src/billing/rules/cfg.ts`,
      to: null,
      specifier,
      global: true,
      reason: "recorded by the previous release",
    }));
    fs.writeFileSync(repo.ledgerFile, JSON.stringify({ entries }));
    const run = repo.run({ ci: true });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("2 recorded crossing(s), none new");
  });
});

describe("a declared process member is a door with an owner, and the narrowest declaration wins", () => {
  const SCOPE = "packages/app";
  const DOOR = "door-outside-owner";
  const FILES: Record<string, string> = {
    "tsconfig.json": TSCONFIG,
    "src/platform.ts": "export const os = process.platform;\n",
    "src/clock.ts": "export const t = [process.hrtime(), process.hrtime.bigint()];\n",
    "src/big.ts": "export const b = process.hrtime.bigint();\n",
    "src/other.ts": "export const x = [process.platform, process.hrtime(), process.uptime()];\n",
    "src/billing/index.ts": "export const i = 1;\n",
  };
  let repo: BoundaryRepo;
  beforeEach(() => {
    repo = boundaryRepo(SCOPE, FILES, {
      features: { [SCOPE]: ["billing"] },
      doors: {
        [SCOPE]: {
          "process.platform": ["src/platform.ts"],
          "process.hrtime": ["src/clock.ts"],
          "process.hrtime.bigint": ["src/big.ts"],
        },
      },
    });
  });
  afterEach(() => repo.dispose());

  it("fails a non-owner for each declared member, and not for an undeclared one", () => {
    expect(crossingsOf(SCOPE, repo.run({ json: true }))).toEqual([
      [DOOR, "clock.ts", "process.hrtime.bigint"],
      [DOOR, "other.ts", "process.hrtime"],
      [DOOR, "other.ts", "process.platform"],
    ]);
  });
});

describe("a type-only import opens no door, in any spelling", () => {
  const SCOPE = "packages/app";
  const DOOR = "door-outside-owner";
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
    "src/credentials.ts":
      'import { readFileSync } from "node:fs";\nexport const read = readFileSync;\n',
    "src/spawner.ts": 'import { spawn } from "node:child_process";\nexport const run = spawn;\n',
    "src/billing/index.ts": "export const i = 1;\n",
    ...Object.fromEntries(
      OPENS_NOTHING.map((body, i) => [`src/billing/store/none${i}.ts`, `${body}\n`]),
    ),
    ...Object.fromEntries(
      OPENS_ONE.map(([body], i) => [`src/billing/store/one${i}.ts`, `${body}\n`]),
    ),
  };
  let repo: BoundaryRepo;
  beforeEach(() => {
    repo = boundaryRepo(SCOPE, FILES, {
      features: { [SCOPE]: ["billing"] },
      doors: {
        [SCOPE]: { "node:fs": ["src/credentials.ts"], "node:child_process": ["src/spawner.ts"] },
      },
    });
  });
  afterEach(() => repo.dispose());

  it("reports one entry for each spelling that opens a module and none for the rest", () => {
    expect(crossingsOf(SCOPE, repo.run({ json: true }))).toEqual(
      OPENS_ONE.map(([, door], i) => [DOOR, `billing/store/one${i}.ts`, door]),
    );
  });

  it("counts a file that names a module's types and also imports it as one use", () => {
    const both = violationsOf(repo.run({ json: true })).filter((v) => v.from.endsWith("/one7.ts"));
    expect(both.map((v) => v.specifier)).toEqual(["node:fs"]);
  });
});
