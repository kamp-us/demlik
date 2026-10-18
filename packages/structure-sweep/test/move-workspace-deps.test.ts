import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";
import { applyManifest } from "../src/move/apply.js";
import { onPath } from "../src/move/dependencies.js";
import type { Manifest, MoveRow } from "../src/move/manifest.js";
import { commit, gitIn, repo, write } from "./helpers.js";

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

const pkg = (
  name: string,
  exports: Record<string, string>,
  dependencies?: Record<string, string>,
) =>
  `${JSON.stringify({ name, private: true, exports, ...(dependencies === undefined ? {} : { dependencies }) }, null, 2)}\n`;

const pnpm = (root: string, ...args: string[]) =>
  execFileSync("pnpm", args, { cwd: root, encoding: "utf8", stdio: "pipe" });

/**
 * A pnpm workspace of three packages, committed with its lockfile. `a` holds `one`, `two` and
 * `three`; two files of `a` import them, and two files of `c` do — one through `@fixture/a`'s
 * exports, one through a relative path into `a/src`. `c` declares `@fixture/a`; nothing declares
 * `@fixture/b`. Every `exports` target is a source file, so the workspace typechecks unbuilt.
 */
function workspace(extra: Readonly<Record<string, string>> = {}): string {
  const root = repo({
    ".gitignore": "node_modules\n",
    "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
    "tsconfig.json": JSON.stringify({
      compilerOptions: JSON.parse(tsconfig).compilerOptions,
      include: ["packages/*/src"],
    }),
    "package.json": `${JSON.stringify({ name: "fixture-root", private: true }, null, 2)}\n`,
    "packages/a/package.json": pkg("@fixture/a", {
      ".": "./src/index.ts",
      "./one": "./src/one.ts",
      "./helper": "./src/helper.ts",
    }),
    "packages/b/package.json": pkg("@fixture/b", {
      ".": "./src/index.ts",
      "./first": "./src/one.ts",
      "./second": "./src/two.ts",
      "./third": "./src/three.ts",
    }),
    "packages/c/package.json": pkg(
      "@fixture/c",
      { ".": "./src/index.ts" },
      { "@fixture/a": "workspace:*" },
    ),
    "packages/a/tsconfig.json": tsconfig,
    "packages/b/tsconfig.json": tsconfig,
    "packages/c/tsconfig.json": tsconfig,
    "packages/a/src/index.ts": [
      'import { one } from "./one";',
      'import { two } from "./two";',
      'import { three } from "./three";',
      "",
      "export const all = [one, two, three];",
      "",
    ].join("\n"),
    "packages/a/src/uses-three.ts":
      'import { three } from "./three";\n\nexport const twice = three * 2;\n',
    "packages/a/src/helper.ts": "export const helper = 10;\n",
    "packages/a/src/one.ts":
      'import { two } from "./two";\n\nexport const one = two + 1;\n',
    "packages/a/src/two.ts": "export const two = 2;\n",
    "packages/a/src/three.ts": "export const three = 3;\n",
    "packages/b/src/index.ts": "export const b = 1;\n",
    "packages/c/src/index.ts":
      'import { one } from "@fixture/a/one";\n\nexport const c = one;\n',
    "packages/c/src/rel.ts": [
      'import { two } from "../../a/src/two";',
      'import { three } from "../../a/src/three";',
      "",
      "export const sum = two + three;",
      "",
    ].join("\n"),
    ...extra,
  });
  pnpm(root, "install", "--lockfile-only");
  commit(root, "lockfile");
  return root;
}

const row = (from: string, to: string): MoveRow => ({
  from,
  to,
  feature: "audit_runs",
  role: "api_surface",
  confidence: 0.95,
});

const manifestOf = (moves: MoveRow[]): Manifest => ({
  scope: "packages/a",
  features: ["audit_runs"],
  floor: 0.8,
  moves,
  review: [],
  pinned: [],
});

const INTO_B = ["one", "two", "three"].map((name) =>
  row(`packages/a/src/${name}.ts`, `packages/b/src/${name}.ts`),
);

const git = (root: string, ...args: string[]) => gitIn(root, ...args).trim();
const read = (root: string, path: string) =>
  readFileSync(join(root, path), "utf8");
const dependenciesOf = (root: string, path: string) =>
  JSON.parse(read(root, path)).dependencies;

/** Every module specifier a file names, in order. */
const specifiers = (root: string, path: string) =>
  [...read(root, path).matchAll(/from "([^"]+)"/g)].map(([, s]) => s);

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

/** Every type error in one package, read through its own tsconfig. */
const typeErrors = (root: string, pkgRoot: string): string[] =>
  new Project({ tsConfigFilePath: join(root, pkgRoot, "tsconfig.json") })
    .getPreEmitDiagnostics()
    .map((d) => `${d.getSourceFile()?.getFilePath()}: ${d.getMessageText()}`);

/** The arguments of code-graph's `runBoundaryGate`, as this test passes them. */
type BoundaryGateArgs = {
  readonly rootAbsolute: string;
  readonly repoRoot: string;
  readonly boundaryRulesFile: string;
  readonly ci: boolean;
  readonly writeCeilings: boolean;
  readonly acceptCrossings: boolean;
  readonly reason: string | undefined;
  readonly migrateCeilings: boolean;
  readonly emit: (payload: string) => void;
  readonly report: (message: string) => void;
  readonly json: boolean;
  readonly pretty: boolean;
};

/**
 * code-graph's boundary gate, the one `code-graph --boundaries` runs, loaded from its source at
 * test time: CI tests before it builds, and code-graph publishes no subpath for the gate. A runtime
 * path keeps code-graph's sources out of this package's typecheck, which runs stricter options.
 */
const { runBoundaryGate } = (await import(
  /* @vite-ignore */ fileURLToPath(
    new URL("../../code-graph/src/boundaries/gate.ts", import.meta.url),
  )
)) as { runBoundaryGate: (args: BoundaryGateArgs) => number };

/** The `[importer, workspace]` of every B19 crossing code-graph's boundary gate reports. */
function relativeCrossings(root: string): string[][] {
  const rules = join(mkdtempSync(join(tmpdir(), "b19-rules-")), "rules.json");
  write(join(rules, ".."), {
    "rules.json": JSON.stringify({
      features: { ".": ["packages"] },
      acrossDeployables: ["relative-import-crosses-workspace"],
    }),
  });
  const out: string[] = [];
  const errors: string[] = [];
  const code = runBoundaryGate({
    rootAbsolute: root,
    repoRoot: root,
    boundaryRulesFile: rules,
    ci: false,
    writeCeilings: false,
    acceptCrossings: false,
    reason: undefined,
    migrateCeilings: false,
    emit: (payload) => {
      out.push(payload);
    },
    report: (message) => {
      errors.push(message);
    },
    json: true,
    pretty: false,
  });
  expect({ code, errors }).toEqual({ code: 0, errors: [] });
  const report = JSON.parse(out.join("")) as {
    scopes: { violations: { kind: string; from: string; to: string }[] }[];
  };
  return report.scopes
    .flatMap((s) => s.violations)
    .filter((v) => v.kind === "relative-import-crosses-workspace")
    .map((v) => [v.from, v.to]);
}

/** Runs `body` with `PATH` holding git alone, so no `pnpm` can be found. */
function withoutPnpm<T>(body: () => T): T {
  const bin = mkdtempSync(join(tmpdir(), "no-pnpm-"));
  const gitBinary = onPath("git");
  if (gitBinary === undefined) throw new Error("git is not on PATH");
  symlinkSync(realpathSync(gitBinary), join(bin, "git"));
  const saved = process.env.PATH;
  process.env.PATH = bin;
  try {
    expect(onPath("pnpm")).toBeUndefined();
    return body();
  } finally {
    process.env.PATH = saved;
  }
}

describe("applyManifest adds the workspace:* dependencies a split needs", () => {
  it("splits three files from a into b: imports by package name, dependencies declared, lockfile frozen-installable, typecheck green, no B19", () => {
    const root = workspace();
    const before = git(root, "rev-parse", "HEAD");
    expect(relativeCrossings(root)).toEqual([
      ["packages/c/src/rel.ts", "packages/a"],
    ]);

    const report = applyManifest(root, manifestOf(INTO_B));

    // One rename commit, then one rewrite commit carrying the imports, manifests and lockfile.
    expect(report.commits).toEqual({
      rename: git(root, "rev-parse", "HEAD~1"),
      rewrite: git(root, "rev-parse", "HEAD"),
    });
    expect(git(root, "rev-parse", "HEAD~2")).toBe(before);
    expect(
      git(root, "diff", "--name-status", "-M100%", "HEAD~2", "HEAD~1")
        .split("\n")
        .sort(),
    ).toEqual(
      ["one", "three", "two"].map(
        (n) => `R100\tpackages/a/src/${n}.ts\tpackages/b/src/${n}.ts`,
      ),
    );
    expect(
      git(root, "diff", "--name-only", "HEAD~1", "HEAD").split("\n").sort(),
    ).toEqual([
      "packages/a/package.json",
      "packages/a/src/index.ts",
      "packages/a/src/uses-three.ts",
      "packages/c/package.json",
      "packages/c/src/index.ts",
      "packages/c/src/rel.ts",
      "pnpm-lock.yaml",
    ]);
    expect(report.dependenciesAdded).toEqual([
      "@fixture/a -> @fixture/b",
      "@fixture/c -> @fixture/b",
    ]);

    // Every cross-package import reads @fixture/b/<subpath>.
    expect(specifiers(root, "packages/a/src/index.ts")).toEqual([
      "@fixture/b/first",
      "@fixture/b/second",
      "@fixture/b/third",
    ]);
    expect(specifiers(root, "packages/a/src/uses-three.ts")).toEqual([
      "@fixture/b/third",
    ]);
    expect(specifiers(root, "packages/c/src/index.ts")).toEqual([
      "@fixture/b/first",
    ]);
    expect(specifiers(root, "packages/c/src/rel.ts")).toEqual([
      "@fixture/b/second",
      "@fixture/b/third",
    ]);

    // Each importing package declares b; c keeps what it declared.
    expect(dependenciesOf(root, "packages/a/package.json")).toEqual({
      "@fixture/b": "workspace:*",
    });
    expect(dependenciesOf(root, "packages/c/package.json")).toEqual({
      "@fixture/a": "workspace:*",
      "@fixture/b": "workspace:*",
    });
    expect(dependenciesOf(root, "packages/b/package.json")).toBeUndefined();
    expect(git(root, "status", "--porcelain")).toBe("");

    // A second apply commits nothing.
    const head = git(root, "rev-parse", "HEAD");
    const again = applyManifest(root, manifestOf(INTO_B));
    expect(again.commits).toEqual({ rename: null, rewrite: null });
    expect(again.dependenciesAdded).toEqual([]);
    expect(git(root, "rev-parse", "HEAD")).toBe(head);

    // The committed lockfile installs frozen, and the result typechecks with no B19.
    // Unlinked, `@fixture/b` resolves nowhere, so the typecheck below is not vacuous.
    expect(typeErrors(root, "packages/a").join("\n")).toContain(
      "Cannot find module '@fixture/b/first'",
    );
    pnpm(root, "install", "--frozen-lockfile", "--offline");
    for (const p of ["packages/a", "packages/b", "packages/c"])
      expect(typeErrors(root, p)).toEqual([]);
    expect(relativeCrossings(root)).toEqual([]);
  });

  it("adds no dependency a package already declares, and then never runs pnpm", () => {
    const root = workspace({
      "packages/a/package.json": pkg(
        "@fixture/a",
        { ".": "./src/index.ts", "./one": "./src/one.ts" },
        { "@fixture/b": "workspace:*" },
      ),
      "packages/c/package.json": pkg(
        "@fixture/c",
        { ".": "./src/index.ts" },
        { "@fixture/a": "workspace:*", "@fixture/b": "workspace:*" },
      ),
    });

    const report = withoutPnpm(() => applyManifest(root, manifestOf(INTO_B)));

    expect(report.dependenciesAdded).toEqual([]);
    expect(
      git(root, "diff", "--name-only", "HEAD~1", "HEAD").split("\n").sort(),
    ).toEqual([
      "packages/a/src/index.ts",
      "packages/a/src/uses-three.ts",
      "packages/c/src/index.ts",
      "packages/c/src/rel.ts",
    ]);
  });

  it("refuses a split that would make two packages depend on each other, naming both, before the rename commit", () => {
    // `one` moves into b but imports a's helper, while a's own files import the moved files.
    const root = workspace({
      "packages/a/src/one.ts": [
        'import { helper } from "./helper";',
        'import { two } from "./two";',
        "",
        "export const one = helper + two;",
        "",
      ].join("\n"),
    });
    const before = snapshot(root);

    const message = refusal(() => applyManifest(root, manifestOf(INTO_B)));

    expect(message).toContain("depend on each other");
    expect(message.split("\n").filter((l) => l.includes(" -> "))).toEqual([
      "  @fixture/a -> @fixture/b -> @fixture/a",
    ]);
    expect(snapshot(root)).toEqual(before);
  });

  it("refuses a cycle the workspace's declared dependencies close, before the rename commit", () => {
    // b already depends on c, so c gaining b would close c -> b -> c.
    const root = workspace({
      "packages/c/package.json": pkg("@fixture/c", { ".": "./src/index.ts" }),
      "packages/b/package.json": pkg(
        "@fixture/b",
        {
          ".": "./src/index.ts",
          "./first": "./src/one.ts",
          "./second": "./src/two.ts",
          "./third": "./src/three.ts",
        },
        { "@fixture/c": "workspace:*" },
      ),
    });
    const before = snapshot(root);

    const message = refusal(() => applyManifest(root, manifestOf(INTO_B)));

    expect(message.split("\n").filter((l) => l.includes(" -> "))).toEqual([
      "  @fixture/c -> @fixture/b -> @fixture/c",
    ]);
    expect(snapshot(root)).toEqual(before);
  });

  it("refuses a split that must add a dependency when no pnpm is on PATH, before the rename commit", () => {
    const root = workspace();
    const before = snapshot(root);

    const message = withoutPnpm(() =>
      refusal(() => applyManifest(root, manifestOf(INTO_B))),
    );

    expect(message).toContain("pnpm was not found");
    expect(message.split("\n").filter((l) => l.includes(" -> "))).toEqual([
      "  @fixture/a -> @fixture/b",
      "  @fixture/c -> @fixture/b",
    ]);
    expect(snapshot(root)).toEqual(before);
  });

  it("applies a move that stays inside one package with no pnpm on PATH", () => {
    const root = workspace();
    const inside = [
      row("packages/a/src/uses-three.ts", "packages/a/src/num/uses-three.ts"),
    ];

    const report = withoutPnpm(() => applyManifest(root, manifestOf(inside)));

    expect(report.commits.rewrite).not.toBeNull();
    expect(report.dependenciesAdded).toEqual([]);
    expect(specifiers(root, "packages/a/src/num/uses-three.ts")).toEqual([
      "../three",
    ]);
    expect(git(root, "diff", "--name-only", "HEAD~1", "HEAD")).toBe(
      "packages/a/src/num/uses-three.ts",
    );
  });
});
