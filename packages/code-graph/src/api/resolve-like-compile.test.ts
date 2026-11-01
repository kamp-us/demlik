import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { API_LEDGER_FILENAME } from "./ledger/ledger.js";

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(PACKAGE_DIR, "src", "index.ts");

// A workspace of the layout npm and yarn install: every dependency in the root `node_modules`, and
// no package with a `node_modules` of its own. Everything runs through the real CLI.
const TSCONFIG = {
  compilerOptions: {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "Bundler",
    strict: true,
    skipLibCheck: true,
    types: [],
  },
  include: ["src"],
};

const installed = (name: string, prefix: string, count: number) => ({
  [`node_modules/${name}/package.json`]: `${JSON.stringify({ name, types: "index.d.ts" })}\n`,
  [`node_modules/${name}/index.d.ts`]: [
    ...Array.from(
      { length: count },
      (_, i) => `export declare function ${prefix}${i}(n: number): number;\n`,
    ),
    `export type ${prefix.toUpperCase()}T = string;\n`,
  ].join(""),
});

const packageFiles = (dir: string, files: Readonly<Record<string, string>>) => ({
  [`${dir}/package.json`]: `${JSON.stringify({ name: path.basename(dir) })}\n`,
  [`${dir}/tsconfig.json`]: `${JSON.stringify(TSCONFIG)}\n`,
  ...Object.fromEntries(Object.entries(files).map(([file, text]) => [`${dir}/${file}`, text])),
});

const DEP_NAMES = [...Array.from({ length: 12 }, (_, i) => `dep${i}`), "DEPT"].sort();
const DEP2_NAMES = [...Array.from({ length: 8 }, (_, i) => `two${i}`), "TWOT"].sort();
const STAR_LINES = 'export * from "dep";\nexport * from "@scope/dep2";\n';

const WORKSPACE: Readonly<Record<string, string>> = {
  "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
  "package.json": '{ "name": "top", "private": true }\n',
  ...installed("dep", "dep", 12),
  ...installed("@scope/dep2", "two", 8),
  ...packageFiles("packages/a", { "src/index.ts": `export const own = 1;\n${STAR_LINES}` }),
  ...packageFiles("packages/b", {
    "src/index.ts": 'export const ownB = 1;\nexport * from "#int";\n',
    "src/int.ts": "export const inner = (n: number) => n + 1;\n",
  }),
  ...packageFiles("packages/c", { "src/index.ts": 'export { dep0 } from "dep";\n' }),
};

let top: string;
let scratch: string;
let tmp: string;
let mapFile: string;

const write = (files: Readonly<Record<string, string>>): void => {
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(top, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
};

const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: top, encoding: "utf8" }).trim();

function commitAll(message: string): string {
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", message);
  return git("rev-parse", "HEAD");
}

// The temp folder of the run lives under `tmp`, so a leftover one shows there. A warning prints on
// a run that exits 0, so stderr is read whatever the exit.
const cli = (dir: string, ...args: string[]) => {
  const run = spawnSync(
    process.execPath,
    ["--import", "tsx", CLI, path.join(top, dir), "--api", mapFile, ...args],
    { cwd: PACKAGE_DIR, encoding: "utf8", env: { ...process.env, TMPDIR: tmp } },
  );
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
};

type View = { subpaths: Record<string, { names: Record<string, { text: string }> }> };
const viewOf = (dir: string): Record<string, { text: string }> => {
  const run = cli(dir, "--json");
  expect(run.code, run.stderr).toBe(0);
  expect(run.stderr).toBe("");
  return (JSON.parse(run.stdout) as View).subpaths["."]?.names ?? {};
};

const ledgerFile = () => path.join(top, API_LEDGER_FILENAME);
const ledgerText = () => fs.readFileSync(ledgerFile(), "utf8");
type Entry = { scope: string; subpath: string; name: string; reason: string };
const ledgerNames = (scope: string): string[] =>
  (JSON.parse(ledgerText()) as { entries: Entry[] }).entries
    .filter((entry) => entry.scope === scope)
    .map((entry) => entry.name)
    .sort();

// Every path in the checkout, with what it is, but for git's own folder.
function listing(root: string, under = ""): string[] {
  return fs.readdirSync(path.join(root, under), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(under, entry.name);
    if (relative === ".git") return [];
    if (entry.isDirectory()) return [relative, ...listing(root, relative)];
    return [`${relative}${entry.isSymbolicLink() ? "@" : ""}`];
  });
}

beforeEach(() => {
  top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-api-hoisted-")));
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-graph-api-hoisted-map-")));
  tmp = path.join(scratch, "tmp");
  fs.mkdirSync(tmp);
  mapFile = path.join(scratch, "map.json");
  fs.writeFileSync(mapFile, JSON.stringify({ ".": { entry: "src/index.ts" } }));
  write(WORKSPACE);
  const imports = { "#int": "./src/int.ts" };
  write({ "packages/b/package.json": `${JSON.stringify({ name: "b", imports })}\n` });
  git("init", "-q", "-b", "main");
});

afterEach(() => {
  expect(fs.readdirSync(tmp).filter((name) => name.startsWith("code-graph-"))).toEqual([]);
  fs.rmSync(top, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("--api in a hoisted workspace", () => {
  it("lists every name, records it, keeps it on repeat runs and prunes exactly what is removed", () => {
    const names = viewOf("packages/a");
    expect(Object.keys(names).sort()).toEqual(["own", ...DEP_NAMES, ...DEP2_NAMES].sort());
    expect(Object.keys(names).length).toBeGreaterThanOrEqual(20);
    for (const name of [...DEP_NAMES, ...DEP2_NAMES]) expect(names[name]?.text).toContain(name);
    expect(names.dep3?.text).toBe("export declare function dep3(n: number): number;");

    expect(viewOf("packages/b")).toEqual({
      inner: { text: "export declare const inner: (n: number) => number;", references: {} },
      ownB: { text: "export declare const ownB = 1;", references: {} },
    });

    const before = listing(top);
    for (const dir of ["packages/a", "packages/b", "packages/c"]) {
      expect(cli(dir, "--accept-api", "--reason", "keep").code).toBe(0);
    }
    expect(listing(top).sort()).toEqual([...before, API_LEDGER_FILENAME].sort());
    expect(ledgerNames("packages/a")).toEqual(["own", ...DEP_NAMES, ...DEP2_NAMES].sort());
    expect(ledgerNames("packages/b")).toEqual(["inner", "ownB"]);

    const recorded = ledgerText();
    for (let run = 0; run < 3; run++) {
      const checked = cli("packages/a", "--ci");
      expect(checked.code, checked.stderr).toBe(0);
      expect(checked.stdout).toContain("PASS");
      expect(ledgerText()).toBe(recorded);
    }

    write({ "packages/a/src/index.ts": "export const own = 1;\n" });
    const pruned = cli("packages/a", "--ci", "--json");
    expect(pruned.code, pruned.stderr).toBe(0);
    const prunedNames = (JSON.parse(pruned.stdout) as { pruned: Entry[] }).pruned.map(
      (entry) => entry.name,
    );
    expect(prunedNames.sort()).toEqual([...DEP_NAMES, ...DEP2_NAMES].sort());
    expect(ledgerNames("packages/a")).toEqual(["own"]);
    expect(ledgerNames("packages/b")).toEqual(["inner", "ownB"]);
  });

  it("--api-base reports each name behind the added export * as added", () => {
    write({ "packages/a/src/index.ts": "export const own = 1;\n" });
    const base = commitAll("base");
    const before = listing(top);
    write({ "packages/a/src/index.ts": `export const own = 1;\n${STAR_LINES}` });
    commitAll("head");

    const run = cli("packages/a", "--api-base", base, "--json");
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr).toBe("");
    const diff = JSON.parse(run.stdout) as {
      subpaths: Record<string, { added: Record<string, unknown>; removed: unknown }>;
    };
    const subpath = diff.subpaths["."];
    expect(Object.keys(subpath?.added ?? {}).sort()).toEqual([...DEP_NAMES, ...DEP2_NAMES].sort());
    expect(listing(top)).toEqual(before);
  });

  it("--api-base compares a hoisted name with itself and finds no change", () => {
    const base = commitAll("base");
    const run = cli("packages/a", "--api-base", base, "--json");
    expect(run.code, run.stderr).toBe(0);
    const diff = JSON.parse(run.stdout) as {
      subpaths: Record<string, { added: object; removed: object; changed: object }>;
    };
    expect(diff.subpaths["."]).toMatchObject({ added: {}, removed: {}, changed: {} });
  });

  it("gives a named re-export its real declaration text", () => {
    expect(viewOf("packages/c")).toEqual({
      dep0: { text: "export declare function dep0(n: number): number;", references: {} },
    });
  });

  it("takes the nearest install, as the compile does", () => {
    write({
      "packages/a/node_modules/dep/package.json": '{ "name": "dep", "types": "index.d.ts" }\n',
      "packages/a/node_modules/dep/index.d.ts": "export declare const nearest: number;\n",
    });
    const names = viewOf("packages/a");
    expect(names.nearest?.text).toBe("export declare const nearest: number;");
    expect(names.dep0).toBeUndefined();
    expect(names.two0).toBeDefined();
  });
});

describe("--api reads a specifier the way the compile did", () => {
  const readsInner = (imports: unknown, extra: Readonly<Record<string, string>> = {}) => {
    write({ "packages/b/package.json": `${JSON.stringify({ name: "b", imports })}\n`, ...extra });
    expect(viewOf("packages/b").inner?.text).toBe(
      "export declare const inner: (n: number) => number;",
    );
  };

  it.each([
    ["a .js target", { "#int": "./src/int.js" }],
    ["a condition map", { "#int": { types: "./src/int.ts", default: "./src/int.js" } }],
    ["a pattern", { "#*": "./src/*.ts" }],
  ])("package.json imports with %s", (_, imports) => {
    readsInner(imports);
  });

  // The emit moves `outDir` to its temp folder, so the compile itself no longer maps this target
  // back to the source. That is a diagnostic, which already holds back pruning.
  it("package.json imports pointing at build output warn", () => {
    const tsconfig = {
      ...TSCONFIG,
      compilerOptions: { ...TSCONFIG.compilerOptions, rootDir: ".", outDir: "dist" },
    };
    write({
      "packages/b/package.json": `${JSON.stringify({ name: "b", imports: { "#int": "./dist/src/int.js" } })}\n`,
      "packages/b/tsconfig.json": `${JSON.stringify(tsconfig)}\n`,
    });
    const run = cli("packages/b", "--json");
    expect(run.code).toBe(0);
    expect(run.stderr).toContain("code-graph: warning:");
  });

  it("lists a name from a .js file under allowJs with its source text", () => {
    write({
      "packages/b/tsconfig.json": `${JSON.stringify({
        ...TSCONFIG,
        compilerOptions: { ...TSCONFIG.compilerOptions, allowJs: true },
      })}\n`,
      "packages/b/src/index.ts": 'export * from "./legacy.js";\n',
      "packages/b/src/legacy.js": "export const old = 1;\n",
    });
    expect(viewOf("packages/b").old?.text).toBe("export const old = 1;");
  });

  // An emitted file reads under its source's name, so each shape has to parse there the same.
  it("keeps the emitted text of every declaration shape, in .tsx, .mts and .cts too", () => {
    write({
      "packages/b/tsconfig.json": `${JSON.stringify({
        ...TSCONFIG,
        compilerOptions: { ...TSCONFIG.compilerOptions, jsx: "preserve" },
      })}\n`,
      "packages/b/src/index.ts": [
        "export default function main(a: number): number { return a; }",
        "export abstract class Base { abstract run(): void; get size(): number { return 1; } }",
        "export namespace Ns { export const inNs = 1; }",
        "export class Merged {}",
        "export namespace Merged { export const extra = 1; }",
        "export enum Color { Red }",
        "export const enum Flag { On = 1 }",
        "export const tuple = [1, 2] as const;",
        'export * from "./view.js";',
        'export * from "./esm.mjs";',
        'export * from "./cjs.cjs";',
      ].join("\n"),
      "packages/b/src/view.tsx": "export const pick = <T,>(value: T): T => value;\n",
      "packages/b/src/esm.mts": "export const fromMts = 1;\n",
      "packages/b/src/cjs.cts": "export const fromCts = 1;\n",
    });
    const names = viewOf("packages/b");
    expect(names.default?.text).toBe("export default function main(a: number): number;");
    expect(names.Base?.text).toContain("abstract run(): void;");
    expect(names.Base?.text).toContain("get size(): number;");
    expect(names.Ns?.text).toBe("export declare namespace Ns {\n    const inNs = 1;\n}");
    expect(names.Merged?.text).toContain("export declare class Merged {");
    expect(names.Merged?.text).toContain("export declare namespace Merged {");
    expect(names.Color?.text).toContain("export declare enum Color {");
    expect(names.Flag?.text).toContain("export declare const enum Flag {");
    expect(names.tuple?.text).toBe("export declare const tuple: readonly [1, 2];");
    expect(names.pick?.text).toBe("export declare const pick: <T>(value: T) => T;");
    expect(names.fromMts?.text).toBe("export declare const fromMts = 1;");
    expect(names.fromCts?.text).toBe("export declare const fromCts = 1;");
  });

  it("tsconfig paths lands on the emitted text, not the source", () => {
    const tsconfig = {
      ...TSCONFIG,
      compilerOptions: { ...TSCONFIG.compilerOptions, paths: { "~/*": ["./src/*"] } },
    };
    write({
      "packages/b/tsconfig.json": `${JSON.stringify(tsconfig)}\n`,
      "packages/b/src/index.ts": 'export * from "~/int";\n',
    });
    expect(viewOf("packages/b").inner?.text).toBe(
      "export declare const inner: (n: number) => number;",
    );
  });

  it("follows a private type behind #int into the references, with its emitted key", () => {
    write({
      "packages/b/src/int.ts":
        'import type { Hidden } from "./hidden";\nexport const inner = (n: Hidden) => n;\n',
      "packages/b/src/hidden.ts": "export type Hidden = { readonly id: string };\n",
    });
    expect(viewOf("packages/b").inner).toEqual({
      text: expect.stringContaining("inner"),
      references: { "src/hidden.d.ts#Hidden": expect.stringContaining("readonly id: string") },
    });
  });
});

describe("--api on a read it cannot resolve", () => {
  const recordedRow = (name: string): Entry => ({
    scope: "packages/d",
    subpath: ".",
    name,
    reason: `why ${name}`,
  });
  const writeLedger = (names: readonly string[]) =>
    fs.writeFileSync(
      ledgerFile(),
      `${JSON.stringify({ entries: names.map(recordedRow) }, null, 2)}\n`,
    );

  it("lists a name from a declare module in a source .d.ts, and keeps its row", () => {
    write(
      packageFiles("packages/d", {
        "src/index.ts": 'export const own = 1;\nexport * from "virtual";\n',
        "src/ambient.d.ts": 'declare module "virtual" { export const fromAmbient: number; }\n',
      }),
    );
    expect(viewOf("packages/d").fromAmbient?.text).toBe("export const fromAmbient: number;");
    writeLedger(["fromAmbient", "own"]);
    const before = ledgerText();
    const checked = cli("packages/d", "--ci");
    expect(checked.code, checked.stderr).toBe(0);
    expect(ledgerText()).toBe(before);
  });

  it.each([
    ["export *", 'export const own = 1;\n// @ts-ignore\nexport * from "nowhere";\n'],
    ["a named re-export", 'export const own = 1;\n// @ts-ignore\nexport { x } from "nowhere";\n'],
    [
      "an internal file",
      'export const own = 1;\nexport * from "./inner";\n',
      '// @ts-ignore\nexport * from "nowhere";\n',
    ],
  ])("warns naming the specifier and prunes nothing, over %s", (_, index, inner = "") => {
    write(packageFiles("packages/d", { "src/index.ts": index, "src/inner.ts": inner }));
    writeLedger(["behindIt", "own", "x"]);
    const before = ledgerText();
    for (let run = 0; run < 2; run++) {
      const checked = cli("packages/d", "--ci");
      expect(checked.code, checked.stderr).toBe(0);
      expect(checked.stderr).toContain('names "nowhere", which the read could not resolve');
      expect(checked.stdout).toContain("the read could not resolve a module");
      expect(checked.stdout).toContain("behindIt");
      expect(ledgerText()).toBe(before);
    }
  });

  it("warns on the tree that resolves nothing, with no diagnostic from the emit", () => {
    write(
      packageFiles("packages/d", {
        "src/index.ts": 'export const own = 1;\n// @ts-ignore\nexport * from "nowhere";\n',
      }),
    );
    const run = cli("packages/d", "--json");
    expect(run.stderr).toMatch(/^code-graph: warning: src\/index\.d\.ts names "nowhere"/);
    expect(run.stderr).not.toContain("tsgo reported");
  });
});
