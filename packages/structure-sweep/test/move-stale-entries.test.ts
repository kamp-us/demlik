import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyHandPlan, applyManifest } from "../src/move/apply.js";
import type { Manifest, MoveRow, PathMove } from "../src/move/manifest.js";
import { commit, gitIn, repo, write } from "./helpers.js";

const BIN = join(import.meta.dirname, "../node_modules/.bin");

const tsconfig = JSON.stringify({
  compilerOptions: {
    module: "ESNext",
    moduleResolution: "Bundler",
    strict: true,
    noEmit: true,
    types: [],
  },
  include: ["src"],
});

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const git = (root: string, ...args: string[]) => gitIn(root, ...args).trim();
const read = (root: string, path: string) =>
  readFileSync(join(root, path), "utf8");
const exportsOf = (root: string, pkg: string) =>
  JSON.parse(read(root, `${pkg}/package.json`)).exports;

/** HEAD, the index and the working tree, ignored files included. */
const snapshot = (root: string) => ({
  head: git(root, "rev-parse", "HEAD"),
  index: git(root, "ls-files", "--stage"),
  tree: git(root, "status", "--porcelain", "--ignored", "--untracked=all"),
});

const refusal = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
};

const plan = (moves: readonly PathMove[]) => ({
  scope: "packages/a",
  moves: moves.map(({ from, to }) => ({ from, to })),
});

const manifestOf = (moves: readonly PathMove[]): Manifest => ({
  scope: "packages/a",
  features: ["audit_runs"],
  floor: 0.8,
  moves: moves.map(
    (m): MoveRow => ({
      ...m,
      feature: "audit_runs",
      role: "api_surface",
      confidence: 0.95,
    }),
  ),
  review: [],
  pinned: [],
});

const into = (pkg: string, ...names: string[]): PathMove[] =>
  names.map((name) => ({
    from: `packages/a/src/${name}`,
    to: `packages/${pkg}/src/${name}`,
  }));

/** The tsup config `a` builds with, from `entry` written as its source text. */
const tsupConfig = (entry: string) =>
  `export default {\n  entry: ${entry},\n  format: ["esm"],\n};\n`;

const A_TSUP = tsupConfig(
  '{ index: "src/index.ts", one: "src/one.ts", two: "src/two.ts", keep: "src/keep.ts" }',
);

const A_EXPORTS = {
  ".": "./dist/index.js",
  "./one": { types: "./dist/one.d.ts", import: "./dist/one.js" },
  "./two": "./dist/two.js",
  "./keep": "./dist/keep.js",
};

/**
 * The realistic split: a pnpm workspace of three packages, committed with its lockfile. `a`'s
 * `exports` and tsup `entry` both name `one.ts` (through a condition map) and `two.ts` (through a
 * plain `dist` target); `helper.ts` and the two tests are named by neither. `b` exports every
 * source under `./*`. `c` imports `@fixture/a/one`.
 */
function splitWorkspace(): string {
  const root = repo({
    ".gitignore": "node_modules\ndist\n",
    "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
    "package.json": json({ name: "fixture-root", private: true }),
    "packages/a/package.json": json({
      name: "@fixture/a",
      private: true,
      type: "module",
      exports: A_EXPORTS,
    }),
    "packages/a/tsup.config.ts": A_TSUP,
    "packages/a/tsconfig.json": tsconfig,
    "packages/a/src/index.ts": [
      'import { keep } from "./keep";',
      'import { one } from "./one";',
      'import { two } from "./two";',
      "",
      "export const all = [one, two, keep];",
      "",
    ].join("\n"),
    "packages/a/src/keep.ts": "export const keep = 0;\n",
    "packages/a/src/helper.ts": "export const helper = 10;\n",
    "packages/a/src/one.ts":
      'import { helper } from "./helper";\n\nexport const one = helper + 1;\n',
    "packages/a/src/two.ts": "export const two = 2;\n",
    "packages/a/src/one.test.ts":
      'import { one } from "./one";\n\nexport const checked = one === 11;\n',
    "packages/a/src/two.test.ts":
      'import { two } from "./two";\n\nexport const checked = two === 2;\n',
    "packages/b/package.json": json({
      name: "@fixture/b",
      private: true,
      exports: { ".": "./src/index.ts", "./*": "./src/*.ts" },
    }),
    "packages/b/tsconfig.json": tsconfig,
    "packages/b/src/index.ts": "export const b = 1;\n",
    "packages/c/package.json": json({
      name: "@fixture/c",
      private: true,
      exports: { ".": "./src/index.ts" },
      dependencies: { "@fixture/a": "workspace:*" },
    }),
    "packages/c/tsconfig.json": tsconfig,
    "packages/c/src/index.ts":
      'import { one } from "@fixture/a/one";\n\nexport const c = one;\n',
  });
  execFileSync("pnpm", ["install", "--lockfile-only"], {
    cwd: root,
    stdio: "pipe",
  });
  commit(root, "lockfile");
  return root;
}

const SPLIT = into(
  "b",
  "one.ts",
  "two.ts",
  "helper.ts",
  "one.test.ts",
  "two.test.ts",
);

const SPLIT_REMOVED = [
  "packages/a/package.json exports ./one",
  "packages/a/package.json exports ./two",
  "packages/a/tsup.config.ts entry src/one.ts",
  "packages/a/tsup.config.ts entry src/two.ts",
];

/** Everything the split leaves in `a`'s build: its kept entries, and nothing naming a file that left. */
function expectSplitEntries(root: string): void {
  expect(exportsOf(root, "packages/a")).toEqual({
    ".": "./dist/index.js",
    "./keep": "./dist/keep.js",
  });
  expect(read(root, "packages/a/tsup.config.ts")).toBe(
    tsupConfig('{ index: "src/index.ts", keep: "src/keep.ts" }'),
  );
  expect(read(root, "packages/c/src/index.ts")).toContain(
    'from "@fixture/b/one"',
  );
}

/**
 * Two packages and no importer of anything that moves: `a` holds `index.ts` and `one.ts`, `b`
 * exports every source under `./*`. `a` gets `files`, its package.json and build config above all.
 */
function twoPackages(files: Readonly<Record<string, string>>): string {
  return repo({
    "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
    "package.json": json({ name: "fixture-root", private: true }),
    "packages/a/package.json": json({ name: "@fixture/a" }),
    "packages/a/tsconfig.json": tsconfig,
    "packages/a/src/index.ts": "export const a = 1;\n",
    "packages/a/src/one.ts": "export const one = 1;\n",
    "packages/b/package.json": json({
      name: "@fixture/b",
      exports: { ".": "./src/index.ts", "./*": "./src/*.ts" },
    }),
    "packages/b/tsconfig.json": tsconfig,
    "packages/b/src/index.ts": "export const b = 1;\n",
    ...files,
  });
}

const ONE_INTO_B = into("b", "one.ts");
const ONE_INSIDE_A: PathMove[] = [
  { from: "packages/a/src/one.ts", to: "packages/a/src/lib/one.ts" },
];

describe("move apply removes the entries a split leaves naming a file that left", () => {
  it("splits five files from a into b: both entries' exports keys and tsup rows go, c reads @fixture/b/one, tsup builds a, tsc passes everywhere, a second apply commits nothing", () => {
    const root = splitWorkspace();
    const before = git(root, "rev-parse", "HEAD");

    const report = applyHandPlan(root, plan(SPLIT));

    expect(report.commits).toEqual({
      rename: git(root, "rev-parse", "HEAD~1"),
      rewrite: git(root, "rev-parse", "HEAD"),
    });
    expect(git(root, "rev-parse", "HEAD~2")).toBe(before);
    expect(
      git(root, "diff", "--name-status", "-M100%", "HEAD~2", "HEAD~1")
        .split("\n")
        .sort(),
    ).toEqual(SPLIT.map(({ from, to }) => `R100\t${from}\t${to}`).sort());
    expect(
      git(root, "diff", "--name-only", "HEAD~1", "HEAD").split("\n").sort(),
    ).toEqual([
      "packages/a/package.json",
      "packages/a/src/index.ts",
      "packages/a/tsup.config.ts",
      "packages/c/package.json",
      "packages/c/src/index.ts",
      "pnpm-lock.yaml",
    ]);
    expect(report.entriesRemoved).toEqual(SPLIT_REMOVED);
    expectSplitEntries(root);
    expect(git(root, "status", "--porcelain")).toBe("");

    const head = git(root, "rev-parse", "HEAD");
    const again = applyHandPlan(root, plan(SPLIT));
    expect(again.commits).toEqual({ rename: null, rewrite: null });
    expect(again.entriesRemoved).toEqual([]);
    expect(git(root, "rev-parse", "HEAD")).toBe(head);

    execFileSync("pnpm", ["install", "--frozen-lockfile", "--offline"], {
      cwd: root,
      stdio: "pipe",
    });
    execFileSync(join(BIN, "tsup"), [], {
      cwd: join(root, "packages/a"),
      stdio: "pipe",
    });
    expect(existsSync(join(root, "packages/a/dist/index.js"))).toBe(true);
    expect(existsSync(join(root, "packages/a/dist/one.js"))).toBe(false);
    for (const pkg of ["packages/a", "packages/b", "packages/c"])
      execFileSync(join(BIN, "tsc"), ["-p", join(root, pkg)], {
        stdio: "pipe",
      });
  }, 60_000);

  it("gives a manifest the same outcome as the hand plan", () => {
    const byPlan = splitWorkspace();
    const byManifest = splitWorkspace();

    applyHandPlan(byPlan, plan(SPLIT));
    const report = applyManifest(byManifest, manifestOf(SPLIT));

    expect(report.entriesRemoved).toEqual(SPLIT_REMOVED);
    expectSplitEntries(byManifest);
    expect(git(byManifest, "rev-parse", "HEAD^{tree}")).toBe(
      git(byPlan, "rev-parse", "HEAD^{tree}"),
    );
  }, 60_000);

  it("removes an exports entry targeting the source itself and a tsup row of an entry array", () => {
    const root = twoPackages({
      "packages/a/package.json": json({
        name: "@fixture/a",
        exports: { ".": "./src/index.ts", "./one": "./src/one.ts" },
      }),
      "packages/a/tsup.config.ts": tsupConfig('["src/index.ts", "src/one.ts"]'),
    });

    const report = applyHandPlan(root, plan(ONE_INTO_B));

    expect(report.entriesRemoved).toEqual([
      "packages/a/package.json exports ./one",
      "packages/a/tsup.config.ts entry src/one.ts",
    ]);
    expect(exportsOf(root, "packages/a")).toEqual({ ".": "./src/index.ts" });
    expect(read(root, "packages/a/tsup.config.ts")).toBe(
      tsupConfig('["src/index.ts"]'),
    );
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  it("removes a tsup row no package.json field points at", () => {
    const root = twoPackages({
      "packages/a/package.json": json({
        name: "@fixture/a",
        exports: { ".": "./dist/index.js" },
      }),
      "packages/a/tsup.config.ts": tsupConfig(
        '{ index: "src/index.ts", cli: "src/one.ts" }',
      ),
    });

    const report = applyHandPlan(root, plan(ONE_INTO_B));

    expect(report.entriesRemoved).toEqual([
      "packages/a/tsup.config.ts entry src/one.ts",
    ]);
    expect(read(root, "packages/a/tsup.config.ts")).toBe(
      tsupConfig('{ index: "src/index.ts" }'),
    );
    expect(exportsOf(root, "packages/a")).toEqual({ ".": "./dist/index.js" });
  });

  it("refuses a tsup entry apply cannot read off its syntax, naming the row and the config, before any commit", () => {
    const root = twoPackages({
      "packages/a/tsup.config.ts": [
        'const entries = { index: "src/index.ts", one: "src/one.ts" };',
        "",
        "export default {",
        "  entry: entries,",
        "};",
        "",
      ].join("\n"),
    });
    const before = snapshot(root);

    const message = refusal(() => applyHandPlan(root, plan(ONE_INTO_B)));

    expect(message).toContain("refusing before any commit");
    expect(message.split("\n").filter((l) => l.includes(" -> "))).toEqual([
      "  packages/a/src/one.ts -> packages/b/src/one.ts  (@fixture/a: tsup.config.ts entry cannot be read from its syntax (line 4: entry: entries), so apply cannot tell whether it names the file)",
    ]);
    expect(snapshot(root)).toEqual(before);
  });

  it("moves a file only a wildcard entry reaches with no entry removed and nothing refused", () => {
    const root = twoPackages({
      "packages/a/package.json": json({
        name: "@fixture/a",
        exports: { ".": "./src/index.ts", "./*": "./src/*.ts" },
      }),
    });
    const pkgBefore = read(root, "packages/a/package.json");

    const report = applyManifest(root, manifestOf(ONE_INTO_B));

    expect(report.commits.rename).not.toBeNull();
    expect(report.entriesRemoved).toEqual([]);
    expect(read(root, "packages/a/package.json")).toBe(pkgBefore);
  });

  it("refuses a row moving a file an old entry names to a destination no entry reaches, with no entry removed", () => {
    const root = twoPackages({
      "packages/a/package.json": json({
        name: "@fixture/a",
        exports: { ".": "./src/index.ts", "./one": "./src/one.ts" },
      }),
      "packages/b/package.json": json({
        name: "@fixture/b",
        exports: { ".": "./src/index.ts" },
      }),
    });
    const before = snapshot(root);

    const message = refusal(() => applyHandPlan(root, plan(ONE_INTO_B)));

    expect(message.split("\n").filter((l) => l.includes(" -> "))).toEqual([
      "  packages/a/src/one.ts -> packages/b/src/one.ts  (no exports entry of @fixture/b reaches it)",
    ]);
    expect(snapshot(root)).toEqual(before);
  });

  it("removes the same entries on a run resumed over an earlier run's rename commit, and the next apply commits nothing", () => {
    const files = {
      "packages/a/package.json": json({
        name: "@fixture/a",
        exports: { ".": "./dist/index.js", "./one": "./dist/one.js" },
      }),
      "packages/a/tsup.config.ts": tsupConfig(
        '{ index: "src/index.ts", one: "src/one.ts" }',
      ),
    };
    const fresh = twoPackages(files);
    const freshReport = applyHandPlan(fresh, plan(ONE_INTO_B));
    const root = twoPackages(files);
    applyHandPlan(root, plan(ONE_INTO_B));
    gitIn(root, "reset", "-q", "--hard", "HEAD~1");

    const report = applyHandPlan(root, plan(ONE_INTO_B));

    expect(report.commits.rename).toBeNull();
    expect(report.commits.rewrite).not.toBeNull();
    expect(report.entriesRemoved).toEqual(freshReport.entriesRemoved);
    expect(report.entriesRemoved).toEqual([
      "packages/a/package.json exports ./one",
      "packages/a/tsup.config.ts entry src/one.ts",
    ]);
    expect(git(root, "rev-parse", "HEAD^{tree}")).toBe(
      git(fresh, "rev-parse", "HEAD^{tree}"),
    );

    const head = git(root, "rev-parse", "HEAD");
    expect(applyHandPlan(root, plan(ONE_INTO_B)).commits).toEqual({
      rename: null,
      rewrite: null,
    });
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
  });
});

/** A field of `a` naming `one.ts`, the same field repointed at `index.ts`, and the refusal's reason. */
const FIELDS: readonly {
  readonly field: string;
  readonly names: Readonly<Record<string, string>>;
  readonly repointed: Readonly<Record<string, string>>;
  readonly why: string;
}[] = [
  ...(["main", "module", "types"] as const).map((field) => ({
    field,
    names: {
      "packages/a/package.json": json({
        name: "@fixture/a",
        [field]: "./dist/one.js",
      }),
    },
    repointed: {
      "packages/a/package.json": json({
        name: "@fixture/a",
        [field]: "./dist/index.js",
      }),
    },
    why: `package.json ${field} names it`,
  })),
  {
    field: "bin",
    names: {
      "packages/a/package.json": json({
        name: "@fixture/a",
        bin: { one: "./dist/one.js" },
      }),
    },
    repointed: {
      "packages/a/package.json": json({
        name: "@fixture/a",
        bin: { one: "./dist/index.js" },
      }),
    },
    why: "package.json bin names it",
  },
  {
    field: "wrangler main",
    names: { "packages/a/wrangler.toml": 'main = "src/one.ts"\n' },
    repointed: { "packages/a/wrangler.toml": 'main = "src/index.ts"\n' },
    why: "wrangler.toml main names it",
  },
  {
    field: "the . entry",
    names: {
      "packages/a/package.json": json({
        name: "@fixture/a",
        exports: { ".": "./src/one.ts" },
      }),
    },
    repointed: {
      "packages/a/package.json": json({
        name: "@fixture/a",
        exports: { ".": "./src/index.ts" },
      }),
    },
    why: "package.json exports . names it",
  },
];

describe("move apply refuses a row whose old package names the file in an entry it does not remove", () => {
  it.each(
    FIELDS,
  )("refuses a row moving the file $field names, before any commit, and applies once the field is repointed", ({
    names,
    repointed,
    why,
  }) => {
    const root = twoPackages(names);
    const before = snapshot(root);

    const message = refusal(() => applyHandPlan(root, plan(ONE_INTO_B)));

    expect(message).toContain("refusing before any commit");
    expect(message.split("\n").filter((l) => l.includes(" -> "))).toEqual([
      `  packages/a/src/one.ts -> packages/b/src/one.ts  (@fixture/a: ${why})`,
    ]);
    expect(snapshot(root)).toEqual(before);

    write(root, repointed);
    commit(root, "repoint the entry");
    const report = applyHandPlan(root, plan(ONE_INTO_B));
    expect(report.commits.rename).not.toBeNull();
    expect(report.entriesRemoved).toEqual([]);
  });

  it.each<{
    readonly entry: string;
    readonly names: Readonly<Record<string, string>>;
    readonly edited: Readonly<Record<string, string>>;
    readonly why: string;
  }>([
    {
      entry: "an exports entry",
      names: {
        "packages/a/package.json": json({
          name: "@fixture/a",
          exports: { ".": "./src/index.ts", "./one": "./src/one.ts" },
        }),
      },
      edited: {
        "packages/a/package.json": json({
          name: "@fixture/a",
          exports: { ".": "./src/index.ts", "./one": "./src/lib/one.ts" },
        }),
      },
      why: "package.json exports ./one names it",
    },
    {
      entry: "a tsup entry",
      names: {
        "packages/a/tsup.config.ts": tsupConfig(
          '{ index: "src/index.ts", one: "src/one.ts" }',
        ),
      },
      edited: {
        "packages/a/tsup.config.ts": tsupConfig(
          '{ index: "src/index.ts", one: "src/lib/one.ts" }',
        ),
      },
      why: "tsup.config.ts entry src/one.ts names it",
    },
  ])("refuses a row inside one package moving the file $entry names, and applies once the entry names the new path", ({
    names,
    edited,
    why,
  }) => {
    const root = twoPackages(names);
    const before = snapshot(root);

    const message = refusal(() => applyHandPlan(root, plan(ONE_INSIDE_A)));

    expect(message.split("\n").filter((l) => l.includes(" -> "))).toEqual([
      `  packages/a/src/one.ts -> packages/a/src/lib/one.ts  (@fixture/a: ${why})`,
    ]);
    expect(snapshot(root)).toEqual(before);

    write(root, edited);
    commit(root, "point the entry at the new path");
    const report = applyHandPlan(root, plan(ONE_INSIDE_A));
    expect(report.commits.rename).not.toBeNull();
    expect(report.entriesRemoved).toEqual([]);
    expect(git(root, "status", "--porcelain")).toBe("");
  });
});
