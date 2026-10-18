import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyManifest } from "../src/move/apply.js";
import type { Manifest } from "../src/move/manifest.js";
import { gitIn, repo } from "./helpers.js";

const git = (root: string, ...args: string[]) => gitIn(root, ...args).trim();
const read = (root: string, path: string) =>
  readFileSync(join(root, path), "utf8");

const TSC = createRequire(import.meta.url).resolve("typescript/bin/tsc");

/** `tsc --noEmit` over the fixture's own tsconfig: its output, empty when it typechecks. */
function typecheck(root: string): string {
  try {
    execFileSync(process.execPath, [TSC, "-p", join(root, "app")], {
      encoding: "utf8",
      stdio: "pipe",
    });
    return "";
  } catch (error) {
    const { stdout } = error as { stdout?: string };
    return stdout || String(error);
  }
}

/**
 * A NodeNext scope whose every relative specifier ends in `ext`: four files that move, named by
 * import and export declarations, a dynamic `import()` and a type-position `import("…")`, one of
 * them through a directory's index file; the moved runner also names a file that stays put.
 */
function nodeNext(ext: ".ts" | ".js") {
  return repo({
    "app/package.json": JSON.stringify({ name: "app", type: "module" }),
    "app/tsconfig.json": JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
        ...(ext === ".ts" ? { allowImportingTsExtensions: true } : {}),
      },
      include: ["src"],
    }),
    "app/src/lib/check.ts":
      "export const check = (n: number): boolean => n > 0;\n",
    "app/src/lib/shape.ts": "export type Shape = { readonly size: number };\n",
    "app/src/x/index.ts": "export const x = 1;\n",
    "app/src/reviewer.ts":
      "export type Reviewer = { readonly name: string };\n",
    "app/src/runner.ts": `import { check } from "./lib/check${ext}";\n\nexport type R = import("./reviewer${ext}").Reviewer;\nexport const run = (r: R): boolean => check(r.name.length);\n`,
    "app/src/main.ts": `import { check } from "./lib/check${ext}";\nimport { run } from "./runner${ext}";\n\nexport const ok = check(1) && run({ name: "a" });\n`,
    "app/src/barrel.ts": `export type { Shape } from "./lib/shape${ext}";\nexport { x } from "./x/index${ext}";\n`,
    "app/src/lazy.ts": `export const load = () => import("./lib/check${ext}");\n`,
    "app/src/typed.ts": `export type S = import("./lib/shape${ext}").Shape;\nexport const size = (s: S): number => s.size;\n`,
  });
}

const row = (from: string, to: string) => ({
  from: `app/src/${from}`,
  to: `app/src/${to}`,
  feature: "core",
  role: "domain",
  confidence: 1,
});

const MANIFEST: Manifest = {
  scope: "app",
  features: ["core"],
  floor: 0.8,
  moves: [
    row("lib/check.ts", "core/check.ts"),
    row("lib/shape.ts", "core/shape.ts"),
    row("x/index.ts", "parts/x/index.ts"),
    row("runner.ts", "jobs/runner.ts"),
  ],
  review: [],
  pinned: [],
};

/** Every quoted relative specifier in the scope's sources. */
function relativeSpecifiers(root: string): string[] {
  return git(root, "ls-files", "app/src")
    .split("\n")
    .flatMap((source) =>
      [...read(root, source).matchAll(/["'](\.\.?\/[^"']+)["']/g)].map(
        ([, spec]) => `${source}: ${spec}`,
      ),
    );
}

describe.each([
  ".ts",
  ".js",
] as const)("move apply over NodeNext %s specifiers", (ext) => {
  it("keeps every rewritten specifier's extension, typechecks, and re-applies as a no-op", () => {
    const root = nodeNext(ext);
    expect(typecheck(root)).toBe("");
    const before = git(root, "rev-parse", "HEAD");

    const report = applyManifest(root, MANIFEST);

    expect(report.moved).toBe(4);
    expect(report.commits).toEqual({
      rename: git(root, "rev-parse", "HEAD~1"),
      rewrite: git(root, "rev-parse", "HEAD"),
    });
    expect(git(root, "rev-parse", "HEAD~2")).toBe(before);

    expect(read(root, "app/src/main.ts")).toContain(
      `from "./core/check${ext}"`,
    );
    expect(read(root, "app/src/main.ts")).toContain(
      `from "./jobs/runner${ext}"`,
    );
    expect(read(root, "app/src/barrel.ts")).toContain(
      `from "./core/shape${ext}"`,
    );
    expect(read(root, "app/src/barrel.ts")).toContain(
      `from "./parts/x/index${ext}"`,
    );
    expect(read(root, "app/src/lazy.ts")).toContain(
      `import("./core/check${ext}")`,
    );
    expect(read(root, "app/src/typed.ts")).toContain(
      `import("./core/shape${ext}")`,
    );
    const runner = read(root, "app/src/jobs/runner.ts");
    expect(runner).toContain(`from "../core/check${ext}"`);
    expect(runner).toContain(`import("../reviewer${ext}")`);
    expect(relativeSpecifiers(root).filter((s) => !s.endsWith(ext))).toEqual(
      [],
    );

    expect(typecheck(root)).toBe("");

    const head = git(root, "rev-parse", "HEAD");
    const again = applyManifest(root, MANIFEST);
    expect(again.commits).toEqual({ rename: null, rewrite: null });
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(git(root, "status", "--porcelain")).toBe("");
  });
});
