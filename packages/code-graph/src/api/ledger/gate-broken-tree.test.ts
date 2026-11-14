import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkoutBranch,
  MAP_FILE,
  ratchetRepository,
  runCli,
  runGate,
} from "../../test-helpers/ratchet-repo.js";
import { API_LEDGER_FILENAME } from "./names.js";

const TSCONFIG = `${JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "Bundler",
    strict: true,
    skipLibCheck: true,
    types: [],
  },
  include: ["src"],
})}\n`;

const MAP = {
  ".": { entry: "src/index.ts", tier: "stable" },
  "./battery": { entry: "src/battery/index.ts", tier: "battery" },
  "./labs": { entry: "src/labs/index.ts" },
};

const namesIn = (prefix: string, count = 8): string =>
  Array.from(
    { length: count },
    (_, i) => `export function ${prefix}${i}(value: number): number {\n  return value + ${i};\n}\n`,
  ).join("");

// Three subpaths and 32 names: 8 of each entry's own, 4 behind `export *` from a sibling file and
// 4 behind `export *` from an installed package.
const SOURCES: Readonly<Record<string, string>> = {
  "src/index.ts": `${namesIn("core")}export * from "./fns";\n`,
  "src/fns.ts": namesIn("fn", 4),
  "src/battery/index.ts": `${namesIn("battery")}export * from "dep";\n`,
  "src/labs/index.ts": namesIn("labs"),
};
const INSTALLED: Readonly<Record<string, string>> = {
  "node_modules/dep/package.json": '{ "name": "dep", "types": "index.d.ts" }\n',
  "node_modules/dep/index.d.ts": Array.from(
    { length: 4 },
    (_, i) => `export declare function dep${i}(): number;\n`,
  ).join(""),
};
const NAME_COUNT = 32;

let top: string;
let scratch: string;
let mapFile: string;

const write = (root: string, files: Readonly<Record<string, string>>): void => {
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
};

const check = (...extra: string[]) => runCli([top, "--api", mapFile, "--ci", ...extra]);
const accept = (reason: string, ...extra: string[]) =>
  runCli([top, "--api", mapFile, "--accept-api", "--reason", reason, ...extra]);

type Entry = { scope: string; subpath: string; name: string; reason: string };
const ledgerFile = (): string => path.join(top, API_LEDGER_FILENAME);
const ledgerText = (): string => fs.readFileSync(ledgerFile(), "utf8");
const entries = (): Entry[] => JSON.parse(ledgerText()).entries;

// Records every name of the fixture, each with a reason of its own.
function recordWithOwnReasons(): void {
  expect(accept("baseline").code).toBe(0);
  const own = entries().map((entry) => ({ ...entry, reason: `why ${entry.name}` }));
  fs.writeFileSync(ledgerFile(), `${JSON.stringify({ entries: own }, null, 2)}\n`);
  expect(own).toHaveLength(NAME_COUNT);
  expect(check().code).toBe(0);
}

const deleteSibling = () => fs.rmSync(path.join(top, "src/fns.ts"));
const removeInstalled = () => fs.rmSync(path.join(top, "node_modules/dep"), { recursive: true });
const restoreTree = () => write(top, { ...SOURCES, ...INSTALLED });
const FN_NAMES = ["fn0", "fn1", "fn2", "fn3"];
const DEP_NAMES = ["dep0", "dep1", "dep2", "dep3"];

beforeEach(() => {
  top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-api-ledger-broken-")));
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-api-ledger-map-")));
  mapFile = path.join(scratch, "map.json");
  fs.writeFileSync(mapFile, JSON.stringify(MAP));
  write(top, {
    "package.json": '{ "name": "@demo/ledger" }\n',
    "tsconfig.json": TSCONFIG,
    ...SOURCES,
    ...INSTALLED,
  });
});

afterEach(() => {
  fs.rmSync(top, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("the API ledger on a tree that does not compile", () => {
  it.each([
    ["a deleted sibling file behind export *", deleteSibling, FN_NAMES],
    ["a removed installed package behind export *", removeInstalled, DEP_NAMES],
  ])("never costs a recorded reason: %s", (_, breakTree, unseen) => {
    recordWithOwnReasons();
    const before = ledgerText();
    breakTree();

    for (let run = 0; run < 3; run++) {
      const checked = check();
      expect(checked.code).toBe(0);
      expect(ledgerText()).toBe(before);
    }
    const accepted = accept("x");
    expect(accepted.code).toBe(0);
    expect(accepted.stdout).toContain("nothing to add");
    expect(ledgerText()).toBe(before);

    restoreTree();
    expect(check().code).toBe(0);
    expect(ledgerText()).toBe(before);
    for (const name of unseen) {
      expect(entries().find((entry) => entry.name === name)?.reason).toBe(`why ${name}`);
    }
    expect(entries()).toHaveLength(NAME_COUNT);
  });

  it("still gates a new name, and accepts it while keeping what it could not see", () => {
    recordWithOwnReasons();
    deleteSibling();
    fs.appendFileSync(path.join(top, "src/index.ts"), "export const fresh = 1;\n");
    const before = ledgerText();

    const failed = check();
    expect(failed.code).toBe(1);
    expect(failed.stdout).toContain(".  fresh\n");
    expect(ledgerText()).toBe(before);

    const accepted = accept("a new one");
    expect(accepted.code).toBe(0);
    expect(accepted.stdout).toContain(".  fresh\n");
    expect(entries()).toHaveLength(NAME_COUNT + 1);
    expect(entries().find(({ name }) => name === "fresh")?.reason).toBe("a new one");
    expect(entries().find(({ name }) => name === "fn2")?.reason).toBe("why fn2");
  });

  it("names each entry it kept and blames the compiler, in text and in --json", () => {
    recordWithOwnReasons();
    deleteSibling();
    const unmeasured = FN_NAMES.map((name) => ({
      scope: ".",
      subpath: ".",
      name,
      reason: `why ${name}`,
    }));

    for (const run of [check(), accept("x")]) {
      expect(run.code).toBe(0);
      expect(run.stdout).toContain("the compiler reported errors");
      for (const name of FN_NAMES) expect(run.stdout).toContain(`.  ${name}\n`);
      expect(run.stdout).not.toContain("the name is gone");
    }

    expect(JSON.parse(check("--json").stdout)).toEqual({
      passed: true,
      scope: ".",
      unrecorded: [],
      pruned: [],
      unmeasured,
    });
    expect(JSON.parse(accept("x", "--json").stdout)).toEqual({
      scope: ".",
      accepted: [],
      pruned: [],
      unmeasured,
      reason: "x",
    });
  });

  // The tradeoff SPEC §13.9 states: a type error nowhere near an export still holds the prune back,
  // because the emit's count cannot say which diagnostics touch an export. A stale entry beats a
  // lost reason, and the first clean run settles it.
  it("keeps a real removal under a standing type error, then prunes it on the first clean run", () => {
    recordWithOwnReasons();
    write(top, {
      "src/labs/index.ts": namesIn("labs").replace(/export function labs7[^}]*}\n/, ""),
      "src/unrelated.ts": 'export const wrong: number = "not a number";\n',
    });
    const before = ledgerText();

    const held = check();
    expect(held.code).toBe(0);
    expect(held.stdout).toContain("the compiler reported errors");
    expect(held.stdout).toContain("./labs  labs7\n");
    expect(ledgerText()).toBe(before);

    fs.rmSync(path.join(top, "src/unrelated.ts"));
    const clean = check();
    expect(clean.code).toBe(0);
    expect(clean.stdout).toContain("the name is gone:\n  ./labs  labs7\n");
    expect(entries().map(({ name }) => name)).not.toContain("labs7");
    expect(entries()).toHaveLength(NAME_COUNT - 1);
  });

  it("neither lists nor records a blank name from a syntax error", () => {
    recordWithOwnReasons();
    const before = ledgerText();
    const source = path.join(top, "src/labs/index.ts");
    fs.appendFileSync(source, "export function (value: number): number {\n  return value;\n}\n");

    const checked = check("--json");
    expect(checked.code).toBe(0);
    expect(JSON.parse(checked.stdout).unrecorded).toEqual([]);
    expect(ledgerText()).toBe(before);

    expect(accept("x").code).toBe(0);
    expect(ledgerText()).toBe(before);

    restoreTree();
    expect(check().code).toBe(0);
    expect(ledgerText()).toBe(before);
  });

  it("records no blank name on a first accept of a tree with a syntax error", () => {
    fs.appendFileSync(path.join(top, "src/labs/index.ts"), "export function (): number {\n}\n");
    expect(accept("baseline").code).toBe(0);
    expect(entries().map(({ name }) => name)).not.toContain("");

    restoreTree();
    expect(check().code).toBe(0);
  });
});

describe("the other --api runs on a tree that does not compile", () => {
  it("prints the view with no word of the diagnostics", () => {
    deleteSibling();
    const view = JSON.parse(runCli([top, "--api", mapFile]).stdout);
    expect(Object.keys(view).sort()).toEqual(["compiler", "root", "subpaths"]);
    expect(Object.keys(view.subpaths["."].names)).not.toContain("fn0");
  });

  it("leaves --api-base and --api-policy's output alone and never reads the ledger", () => {
    const repo = ratchetRepository();
    try {
      checkoutBranch(repo, "labs-added");
      const broken = path.join(repo.root, "src", "unrelated.ts");
      fs.writeFileSync(broken, 'export const wrong: number = "not a number";\n');
      const diff = () => runCli([repo.root, "--api", MAP_FILE, "--api-base", "main"]);
      const diffBefore = diff();
      const gateBefore = runGate(repo);

      const ledger = path.join(repo.top, API_LEDGER_FILENAME);
      fs.writeFileSync(ledger, "{ not json");
      expect(diff()).toEqual(diffBefore);
      expect(Object.keys(JSON.parse(diffBefore.stdout)).sort()).toEqual([
        "base",
        "compiler",
        "root",
        "subpaths",
      ]);
      expect(runGate(repo)).toEqual(gateBefore);
      expect(gateBefore.code).not.toBe(2);
      expect(fs.readFileSync(ledger, "utf8")).toBe("{ not json");
    } finally {
      fs.rmSync(repo.top, { recursive: true, force: true });
    }
  });
});
