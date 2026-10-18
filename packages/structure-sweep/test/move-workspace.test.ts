import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyManifest } from "../src/move/apply.js";
import type { Manifest, MoveRow } from "../src/move/manifest.js";
import {
  crossesPackages,
  packageOf,
  placeRow,
  readWorkspace,
} from "../src/move/workspace.js";
import { gitIn, repo } from "./helpers.js";

const tsconfig = JSON.stringify({
  compilerOptions: {
    module: "ESNext",
    moduleResolution: "Bundler",
    strict: true,
  },
  include: ["src"],
});

const EXPORTS = {
  a: { ".": "./dist/index.js" },
  b: { "./*": "./dist/*.js" },
  c: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
} as const;

/** A pnpm workspace of three packages; `a` holds four files its own index imports. */
function workspace(extra: Readonly<Record<string, string>> = {}) {
  return repo({
    "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
    "package.json": JSON.stringify({ name: "fixture-root", private: true }),
    ...Object.fromEntries(
      (["a", "b", "c"] as const).flatMap((p) => [
        [
          `packages/${p}/package.json`,
          JSON.stringify({ name: `@fixture/${p}`, exports: EXPORTS[p] }),
        ],
        [`packages/${p}/tsconfig.json`, tsconfig],
      ]),
    ),
    "packages/a/src/index.ts": [
      'import { one } from "./one";',
      'import { two } from "./two";',
      'import { three } from "./three";',
      'import { four } from "./four";',
      "",
      "export const all = [one, two, three, four];",
      "",
    ].join("\n"),
    "packages/a/src/one.ts": "export const one = 1;\n",
    "packages/a/src/two.ts": "export const two = 2;\n",
    "packages/a/src/three.ts": "export const three = 3;\n",
    "packages/a/src/four.ts": "export const four = 4;\n",
    "packages/b/src/index.ts": "export const b = 1;\n",
    "packages/c/src/index.ts": "export const c = 1;\n",
    ...extra,
  });
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

const CROSSING = ["one", "two", "three"].map((name) =>
  row(`packages/a/src/${name}.ts`, `packages/b/src/${name}.ts`),
);
const INSIDE = row("packages/a/src/four.ts", "packages/a/src/feature/four.ts");

const git = (root: string, ...args: string[]) => gitIn(root, ...args).trim();

/** HEAD, the index and the working tree, ignored files included. */
const snapshot = (root: string) => ({
  head: git(root, "rev-parse", "HEAD"),
  index: git(root, "ls-files", "--stage"),
  tree: git(root, "status", "--porcelain", "--ignored", "--untracked=all"),
});

describe("readWorkspace", () => {
  it("resolves each package's name, root and exports from its package.json", () => {
    const ws = readWorkspace(workspace());

    expect(ws.root).toEqual({
      root: ".",
      name: "fixture-root",
      exports: undefined,
    });
    expect(ws.members).toEqual([
      { root: "packages/a", name: "@fixture/a", exports: EXPORTS.a },
      { root: "packages/b", name: "@fixture/b", exports: EXPORTS.b },
      { root: "packages/c", name: "@fixture/c", exports: EXPORTS.c },
    ]);
  });

  it("is the root package alone when the repository has no pnpm-workspace.yaml", () => {
    const root = repo({
      "svc/package.json": JSON.stringify({ name: "svc" }),
      "svc/src/index.ts": "export const x = 1;\n",
    });

    expect(readWorkspace(root)).toEqual({
      root: { root: ".", name: undefined, exports: undefined },
      members: [],
    });
  });

  it("follows ** globs, drops ! globs, and never reads node_modules", () => {
    const root = repo({
      "pnpm-workspace.yaml":
        "packages:\n  - apps/**\n  - libs/*\n  - '!libs/legacy'\n",
      "apps/web/package.json": JSON.stringify({ name: "web" }),
      "apps/tools/cli/package.json": JSON.stringify({ name: "cli" }),
      "apps/web/node_modules/dep/package.json": JSON.stringify({
        name: "dep",
      }),
      "libs/core/package.json": JSON.stringify({ name: "core" }),
      "libs/legacy/package.json": JSON.stringify({ name: "legacy" }),
      "libs/core/nested/package.json": JSON.stringify({ name: "nested" }),
      "other/package.json": JSON.stringify({ name: "other" }),
    });

    expect(readWorkspace(root).members.map((p) => [p.root, p.name])).toEqual([
      ["apps/tools/cli", "cli"],
      ["apps/web", "web"],
      ["libs/core", "core"],
    ]);
  });

  it("places a path in the member that is its nearest ancestor, else in the root", () => {
    const ws = readWorkspace(workspace());

    expect(packageOf(ws, "packages/a/src/one.ts").name).toBe("@fixture/a");
    expect(packageOf(ws, "packages/b/src/new/x.ts").name).toBe("@fixture/b");
    expect(packageOf(ws, "packages/ab/x.ts").name).toBe("fixture-root");
    expect(packageOf(ws, "scripts/x.ts").name).toBe("fixture-root");
    expect(crossesPackages(placeRow(ws, CROSSING[0] as MoveRow))).toBe(true);
    expect(crossesPackages(placeRow(ws, INSIDE))).toBe(false);
  });
});

describe("applyManifest over a pnpm workspace", () => {
  it("refuses rows into a package whose exports reach none of them before any commit, naming each with the package", () => {
    const root = workspace();
    const before = snapshot(root);
    const intoC = ["one", "two", "three"].map((name) =>
      row(`packages/a/src/${name}.ts`, `packages/c/src/${name}.ts`),
    );

    let message = "";
    try {
      applyManifest(root, manifestOf([...intoC, INSIDE]));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("another workspace package");
    const named = message.split("\n").filter((l) => l.includes(" -> "));
    expect(named).toEqual(
      ["one", "two", "three"].map(
        (n) =>
          `  packages/a/src/${n}.ts -> packages/c/src/${n}.ts  (no exports entry of @fixture/c reaches it)`,
      ),
    );
    expect(message).not.toContain("four.ts");
    expect(snapshot(root)).toEqual(before);
  });

  it("applies rows that stay inside one package as a rename commit then a rewrite commit", () => {
    const root = workspace();
    const before = git(root, "rev-parse", "HEAD");

    const report = applyManifest(root, manifestOf([INSIDE]));

    expect(report.commits).toEqual({
      rename: git(root, "rev-parse", "HEAD~1"),
      rewrite: git(root, "rev-parse", "HEAD"),
    });
    expect(git(root, "rev-parse", "HEAD~2")).toBe(before);
    expect(
      git(root, "diff", "--name-status", "-M100%", "HEAD~2", "HEAD~1"),
    ).toBe("R100\tpackages/a/src/four.ts\tpackages/a/src/feature/four.ts");
    expect(git(root, "diff", "--name-only", "HEAD~1", "HEAD")).toBe(
      "packages/a/src/index.ts",
    );
    expect(
      readFileSync(join(root, "packages/a/src/index.ts"), "utf8"),
    ).toContain('from "./feature/four"');
    expect(git(root, "status", "--porcelain")).toBe("");
  });
});
