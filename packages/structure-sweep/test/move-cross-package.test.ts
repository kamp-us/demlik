import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyManifest } from "../src/move/apply.js";
import type { Manifest, MoveRow } from "../src/move/manifest.js";
import { gitIn, repo } from "./helpers.js";

const tsconfig = JSON.stringify({
  compilerOptions: {
    module: "ESNext",
    moduleResolution: "Bundler",
    strict: true,
  },
  include: ["src"],
});

/** `@fixture/b` names each destination by a key that is not its file name, so a subpath read off the file would be wrong. */
const B_EXPORTS = {
  ".": "./dist/index.js",
  "./first": { types: "./dist/one.d.ts", import: "./dist/one.js" },
  "./second": "./dist/two.js",
  "./third": "./dist/three.js",
};

/**
 * Three packages. `a` holds `one`, `two` and `three`, imported by two files of its own and two of
 * `c` — one through `@fixture/a`'s exports, one through a relative path into `a/src` — and by one
 * file of `b`. `one` imports `two`, which moves with it. Nothing moved imports back into `a`, since
 * `a` importing the moved files makes that a cycle between `a` and `b`.
 */
function workspace(
  bExports: unknown = B_EXPORTS,
  extra: Readonly<Record<string, string>> = {},
) {
  const pkg = (name: string, exports: unknown) =>
    JSON.stringify({ name, exports });
  return repo({
    "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
    "package.json": JSON.stringify({ name: "fixture-root", private: true }),
    "packages/a/package.json": pkg("@fixture/a", {
      ".": "./dist/index.js",
      "./one": "./dist/one.js",
      "./helper": "./dist/helper.js",
    }),
    "packages/b/package.json": pkg("@fixture/b", bExports),
    "packages/c/package.json": pkg("@fixture/c", { ".": "./dist/index.js" }),
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
    "packages/b/src/consumer.ts":
      'import { one } from "@fixture/a/one";\n\nexport const used = one;\n',
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

describe("applyManifest across workspace packages", () => {
  it("moves three files from a into b, writing every import that crosses a package line through b's exports", () => {
    const root = workspace();
    const before = git(root, "rev-parse", "HEAD");

    const report = applyManifest(root, manifestOf(INTO_B));

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
      "packages/b/src/consumer.ts",
      "packages/c/package.json",
      "packages/c/src/index.ts",
      "packages/c/src/rel.ts",
      "pnpm-lock.yaml",
    ]);

    // Importers in a and c now cross into b: package name plus the exports key, not the file name.
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
    // Imports that end up inside one package are relative.
    expect(specifiers(root, "packages/b/src/consumer.ts")).toEqual(["./one"]);
    expect(specifiers(root, "packages/b/src/one.ts")).toEqual(["./two"]);
    expect(git(root, "status", "--porcelain")).toBe("");

    const head = git(root, "rev-parse", "HEAD");
    const again = applyManifest(root, manifestOf(INTO_B));
    expect(again.commits).toEqual({ rename: null, rewrite: null });
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
  });

  it("finishes the rewrite when an earlier run stopped after the rename commit", () => {
    const fresh = workspace();
    applyManifest(fresh, manifestOf(INTO_B));
    const root = workspace();
    applyManifest(root, manifestOf(INTO_B));
    gitIn(root, "reset", "-q", "--hard", "HEAD~1");

    const report = applyManifest(root, manifestOf(INTO_B));

    expect(report.commits.rename).toBeNull();
    expect(report.commits.rewrite).not.toBeNull();
    for (const path of [
      "packages/a/src/index.ts",
      "packages/c/src/rel.ts",
      "packages/b/src/one.ts",
      "packages/b/src/consumer.ts",
    ])
      expect(read(root, path)).toBe(read(fresh, path));
  });

  it("writes a destination reached only through a wildcard exports entry with the matching subpath", () => {
    const root = workspace({
      ".": "./dist/index.js",
      "./api/*": "./dist/handlers/*.js",
    });
    const moves = ["one", "two", "three"].map((name) =>
      row(`packages/a/src/${name}.ts`, `packages/b/src/handlers/${name}.ts`),
    );

    applyManifest(root, manifestOf(moves));

    expect(specifiers(root, "packages/a/src/index.ts")).toEqual([
      "@fixture/b/api/one",
      "@fixture/b/api/two",
      "@fixture/b/api/three",
    ]);
    expect(specifiers(root, "packages/c/src/rel.ts")).toEqual([
      "@fixture/b/api/two",
      "@fixture/b/api/three",
    ]);
    expect(specifiers(root, "packages/b/src/handlers/one.ts")).toEqual([
      "./two",
    ]);
  });

  it("writes a moved file's import back into the package it left through that package's exports", () => {
    // Only c and b import the moved files, so b gaining a dependency on a closes no cycle.
    const root = workspace(B_EXPORTS, {
      "packages/a/src/index.ts": "export const all = 0;\n",
      "packages/a/src/uses-three.ts": "export const twice = 6;\n",
      "packages/a/src/one.ts": [
        'import { helper } from "./helper";',
        'import { two } from "./two";',
        "",
        "export const one = helper + two;",
        "",
      ].join("\n"),
    });

    applyManifest(root, manifestOf(INTO_B));

    expect(specifiers(root, "packages/b/src/one.ts")).toEqual([
      "@fixture/a/helper",
      "./two",
    ]);
    expect(
      JSON.parse(read(root, "packages/b/package.json")).dependencies,
    ).toEqual({ "@fixture/a": "workspace:*" });
  });

  it("refuses a row whose destination no exports entry of the target package reaches, before the rename commit", () => {
    const root = workspace({
      ".": "./dist/index.js",
      "./first": "./dist/one.js",
    });
    const before = snapshot(root);

    const message = refusal(() => applyManifest(root, manifestOf(INTO_B)));

    expect(message).toContain("no exports entry");
    expect(message.split("\n").filter((l) => l.includes(" -> "))).toEqual(
      ["two", "three"].map(
        (n) =>
          `  packages/a/src/${n}.ts -> packages/b/src/${n}.ts  (no exports entry of @fixture/b reaches it)`,
      ),
    );
    expect(snapshot(root)).toEqual(before);
  });

  it("refuses a moved file's import of a file its old package does not export, before the rename commit", () => {
    const root = workspace(B_EXPORTS, {
      "packages/a/src/one.ts": [
        'import { secret } from "./secret";',
        'import { two } from "./two";',
        "",
        "export const one = secret + two;",
        "",
      ].join("\n"),
      "packages/a/src/secret.ts": "export const secret = 7;\n",
    });
    const before = snapshot(root);

    const message = refusal(() => applyManifest(root, manifestOf(INTO_B)));

    expect(message.split("\n").filter((l) => l.includes(" -> "))).toEqual([
      "  packages/a/src/one.ts -> packages/b/src/one.ts  (packages/b/src/one.ts imports packages/a/src/secret.ts, which no exports entry of @fixture/a reaches)",
    ]);
    expect(snapshot(root)).toEqual(before);
  });
});
