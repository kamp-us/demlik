import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyManifest } from "../src/move/apply.js";
import type { Manifest, MoveRow } from "../src/move/manifest.js";
import { commit, gitIn, repo } from "./helpers.js";

const TSC = createRequire(import.meta.url).resolve("typescript/bin/tsc");

const PACKAGES = ["packages/a", "packages/b", "packages/c"];

const options = {
  NodeNext: { module: "NodeNext", moduleResolution: "NodeNext" },
  Bundler: { module: "ESNext", moduleResolution: "Bundler" },
} as const;

const tsconfig = (resolution: keyof typeof options) =>
  JSON.stringify({
    compilerOptions: {
      ...options[resolution],
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
    },
    include: ["src"],
  });

const pkg = (
  name: string,
  exports: unknown,
  dependencies: Record<string, string> = {},
) =>
  `${JSON.stringify({ name, private: true, type: "module", exports, dependencies }, null, 2)}\n`;

const pnpm = (root: string, ...args: string[]) =>
  execFileSync("pnpm", args, { cwd: root, encoding: "utf8", stdio: "pipe" });

/** `tsc --noEmit` over one package's tsconfig: its output, empty when it typechecks. */
function typecheck(root: string, pkgRoot: string): string {
  try {
    execFileSync(process.execPath, [TSC, "-p", join(root, pkgRoot)], {
      encoding: "utf8",
      stdio: "pipe",
    });
    return "";
  } catch (error) {
    const { stdout } = error as { stdout?: string };
    return stdout || String(error);
  }
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

const git = (root: string, ...args: string[]) => gitIn(root, ...args).trim();
const read = (root: string, path: string) =>
  readFileSync(join(root, path), "utf8");
const specifiers = (root: string, path: string) =>
  [...read(root, path).matchAll(/from "([^"]+)"/g)].map(([, s]) => s);

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

/**
 * Three packages, each with `"./*"` reaching its `src`. `one`, `two` and `three` leave `a` for `b`;
 * two files of `b` import them through `@fixture/a`, so those imports land inside their own package,
 * and `c` imports one too. `a` keeps a file importing none of them, so no cycle closes. `ext` is what
 * every relative specifier in the fixture ends in.
 */
function bImportsA(resolution: keyof typeof options, ext: ".js" | "") {
  const exports = { "./*": "./src/*.ts" };
  const root = repo({
    ".gitignore": "node_modules\n",
    "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
    "package.json": `${JSON.stringify({ name: "fixture-root", private: true }, null, 2)}\n`,
    "packages/a/package.json": pkg("@fixture/a", exports),
    "packages/b/package.json": pkg("@fixture/b", exports, {
      "@fixture/a": "workspace:*",
    }),
    "packages/c/package.json": pkg("@fixture/c", exports, {
      "@fixture/a": "workspace:*",
    }),
    ...Object.fromEntries(
      PACKAGES.map((p) => [`${p}/tsconfig.json`, tsconfig(resolution)]),
    ),
    "packages/a/src/one.ts": `import { two } from "./two${ext}";\n\nexport const one = two + 1;\n`,
    "packages/a/src/two.ts": "export const two = 2;\n",
    "packages/a/src/three.ts": "export const three = 3;\n",
    "packages/a/src/stays.ts": "export const stays = 0;\n",
    "packages/b/src/uses-one.ts":
      'import { one } from "@fixture/a/one";\n\nexport const a = one;\n',
    "packages/b/src/deep/uses-two.ts": [
      'import { two } from "@fixture/a/two";',
      'import { three } from "@fixture/a/three";',
      `import { a } from "../uses-one${ext}";`,
      "",
      "export const sum = a + two + three;",
      "",
    ].join("\n"),
    "packages/c/src/uses-three.ts":
      'import { three } from "@fixture/a/three";\n\nexport const c = three;\n',
  });
  pnpm(root, "install", "--lockfile-only");
  commit(root, "lockfile");
  return root;
}

const INTO_B = ["one", "two", "three"].map((name) =>
  row(`packages/a/src/${name}.ts`, `packages/b/src/${name}.ts`),
);

describe("a package-name import a move lands inside its own package", () => {
  it.each([
    { installed: false },
    { installed: true },
  ])("on NodeNext becomes a relative path ending in .js, and every package typechecks (installed before apply: $installed)", ({
    installed,
  }) => {
    const root = bImportsA("NodeNext", ".js");
    if (installed) pnpm(root, "install", "--frozen-lockfile", "--offline");

    applyManifest(root, manifestOf(INTO_B));

    expect(specifiers(root, "packages/b/src/uses-one.ts")).toEqual([
      "./one.js",
    ]);
    expect(specifiers(root, "packages/b/src/deep/uses-two.ts")).toEqual([
      "../two.js",
      "../three.js",
      "../uses-one.js",
    ]);
    expect(specifiers(root, "packages/b/src/one.ts")).toEqual(["./two.js"]);
    expect(specifiers(root, "packages/c/src/uses-three.ts")).toEqual([
      "@fixture/b/three",
    ]);

    pnpm(root, "install", "--frozen-lockfile", "--offline");
    for (const p of PACKAGES) expect(typecheck(root, p)).toBe("");
  });

  it("stays extensionless on Bundler", () => {
    const root = bImportsA("Bundler", "");

    applyManifest(root, manifestOf(INTO_B));

    expect(specifiers(root, "packages/b/src/uses-one.ts")).toEqual(["./one"]);
    expect(specifiers(root, "packages/b/src/deep/uses-two.ts")).toEqual([
      "../two",
      "../three",
      "../uses-one",
    ]);

    pnpm(root, "install", "--frozen-lockfile", "--offline");
    for (const p of PACKAGES) expect(typecheck(root, p)).toBe("");
  });
});

/**
 * `a` holds `m.mts` and `k.cts`, imported from `a` and `c`, relatively and by name, from `.ts` and
 * `.mts` files, always with the `.mjs` / `.cjs` the compiler asks for. `exportsOfB` decides how `b`
 * can reach them once they land there.
 */
function moduleKinds(exportsOfB: unknown) {
  const aExports = { "./m": "./src/m.mts", "./k": "./src/k.cts" };
  const root = repo({
    ".gitignore": "node_modules\n",
    "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
    "package.json": `${JSON.stringify({ name: "fixture-root", private: true }, null, 2)}\n`,
    "packages/a/package.json": pkg("@fixture/a", aExports),
    "packages/b/package.json": pkg("@fixture/b", exportsOfB),
    "packages/c/package.json": pkg(
      "@fixture/c",
      { ".": "./src/uses.ts" },
      { "@fixture/a": "workspace:*" },
    ),
    ...Object.fromEntries(
      PACKAGES.map((p) => [`${p}/tsconfig.json`, tsconfig("NodeNext")]),
    ),
    "packages/a/src/m.mts": "export const m = 1;\n",
    "packages/a/src/k.cts": "export const k = 2;\n",
    "packages/a/src/uses.ts": [
      'import { m } from "./m.mjs";',
      'import { k } from "./k.cjs";',
      "",
      "export const a = m + k;",
      "",
    ].join("\n"),
    "packages/b/src/index.ts": "export const b = 1;\n",
    "packages/c/src/uses.ts": [
      'import { m } from "../../a/src/m.mjs";',
      'import { k } from "@fixture/a/k";',
      "",
      "export const c = m + k;",
      "",
    ].join("\n"),
    "packages/c/src/uses-too.mts":
      'import { m } from "../../a/src/m.mjs";\n\nexport const d = m;\n',
  });
  pnpm(root, "install", "--lockfile-only");
  commit(root, "lockfile");
  return root;
}

const KINDS = [
  row("packages/a/src/m.mts", "packages/b/src/m.mts"),
  row("packages/a/src/k.cts", "packages/b/src/k.cts"),
];

describe("a row moving an .mts or .cts file across a package line", () => {
  it.each([
    {
      name: "exact entries",
      exportsOfB: { "./m": "./src/m.mts", "./k": "./src/k.cts" },
    },
    {
      name: "wildcard entries with the matching extension",
      exportsOfB: { "./*.mts": "./src/*.mts", "./*.cts": "./src/*.cts" },
    },
  ])("writes every import by package name and adds the dependency, through $name", ({
    exportsOfB,
  }) => {
    const root = moduleKinds(exportsOfB);
    const wild = Object.keys(exportsOfB).some((key) => key.includes("*"));
    const m = wild ? "@fixture/b/m.mts" : "@fixture/b/m";
    const k = wild ? "@fixture/b/k.cts" : "@fixture/b/k";

    const report = applyManifest(root, manifestOf(KINDS));

    expect(specifiers(root, "packages/a/src/uses.ts")).toEqual([m, k]);
    expect(specifiers(root, "packages/c/src/uses.ts")).toEqual([m, k]);
    expect(specifiers(root, "packages/c/src/uses-too.mts")).toEqual([m]);
    expect(report.dependenciesAdded).toEqual([
      "@fixture/a -> @fixture/b",
      "@fixture/c -> @fixture/b",
    ]);

    pnpm(root, "install", "--frozen-lockfile", "--offline");
    for (const p of PACKAGES) expect(typecheck(root, p)).toBe("");
  });

  it("is refused when the only wildcard entry builds a plain .js, which an .mts never becomes", () => {
    const root = moduleKinds({ "./*": "./dist/*.js" });
    const before = snapshot(root);

    const message = refusal(() => applyManifest(root, manifestOf(KINDS)));

    expect(message.split("\n").filter((l) => l.includes(" -> "))).toEqual([
      "  packages/a/src/m.mts -> packages/b/src/m.mts  (no exports entry of @fixture/b reaches it)",
      "  packages/a/src/k.cts -> packages/b/src/k.cts  (no exports entry of @fixture/b reaches it)",
    ]);
    expect(snapshot(root)).toEqual(before);
  });
});
