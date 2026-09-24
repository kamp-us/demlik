// ═══════════════════════════════════════════════════════════════════════════
// ONE NEUTRAL CORE, TWO ENGINES, AND NO PATH BETWEEN THEM (#274 R2.1, #275).
//
// The package has three entry points: the core at `@demlik/tea`, the Promise
// engine at `@demlik/tea/promise`, and the Effect engine at
// `@demlik/tea/effect`. A Promise user must install and bundle no Effect code,
// and the core must stay usable by either engine. Three rules hold that:
//
//   1. the core's import graph reaches neither engine;
//   2. `./promise` and `./effect` never reach each other;
//   3. no module outside `src/effect/` imports the `effect` package.
//
// The walk is the one `src/pure/import-graph.test.ts` uses: every `from "…"`
// and bare `import "…"` specifier, relative ones followed. Type-only imports
// count too, so the rule reads the same whether or not a line is erased.
// ═══════════════════════════════════════════════════════════════════════════
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** Source files keyed by their path relative to `src/`, POSIX-separated. */
type Tree = ReadonlyMap<string, string>;

type Violation =
  | { readonly rule: "core-imports-engine"; readonly file: string }
  | { readonly rule: "engine-imports-engine"; readonly file: string }
  | {
      readonly rule: "effect-outside-effect";
      readonly file: string;
      readonly specifier: string;
    };

const ENGINES = ["promise", "effect"] as const;
type Engine = (typeof ENGINES)[number];

const FROM = /from\s*["']([^"']+)["']/g;
const BARE = /\bimport\s*["']([^"']+)["']/g;

function specifiers(src: string): Set<string> {
  const specs = new Set<string>();
  for (const m of src.matchAll(FROM)) if (m[1]) specs.add(m[1]);
  for (const m of src.matchAll(BARE)) if (m[1]) specs.add(m[1]);
  return specs;
}

function resolveIn(tree: Tree, fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null; // a package — outside our graph
  const base = posix.normalize(posix.join(posix.dirname(fromFile), spec));
  for (const c of [
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    base,
  ]) {
    if (tree.has(c)) return c;
  }
  return null;
}

function graphOf(tree: Tree, entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop();
    if (file === undefined || seen.has(file)) continue;
    const src = tree.get(file);
    if (src === undefined) continue;
    seen.add(file);
    for (const spec of specifiers(src)) {
      const next = resolveIn(tree, file, spec);
      if (next !== null) stack.push(next);
    }
  }
  return seen;
}

const inEngine = (file: string, engine: Engine): boolean =>
  file.startsWith(`${engine}/`);

const isEffectPackage = (spec: string): boolean =>
  spec === "effect" ||
  spec.startsWith("effect/") ||
  spec.startsWith("@effect/");

/** Every way `tree` breaks the three entry-point rules. Empty means clean. */
function entryPointViolations(tree: Tree): Violation[] {
  const out: Violation[] = [];

  for (const file of graphOf(tree, "index.ts")) {
    if (ENGINES.some((e) => inEngine(file, e))) {
      out.push({ rule: "core-imports-engine", file });
    }
  }

  for (const engine of ENGINES) {
    const other = engine === "promise" ? "effect" : "promise";
    for (const file of graphOf(tree, `${engine}/index.ts`)) {
      if (inEngine(file, other)) {
        out.push({ rule: "engine-imports-engine", file });
      }
    }
  }

  for (const [file, src] of tree) {
    if (inEngine(file, "effect")) continue;
    for (const specifier of specifiers(src)) {
      if (isEffectPackage(specifier)) {
        out.push({ rule: "effect-outside-effect", file, specifier });
      }
    }
  }

  return out;
}

const SRC = dirname(fileURLToPath(import.meta.url));

function readSrcTree(): Tree {
  const tree = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) walk(abs);
      else if (/\.tsx?$/.test(ent.name)) {
        tree.set(
          relative(SRC, abs).split("\\").join("/"),
          readFileSync(abs, "utf8"),
        );
      }
    }
  };
  walk(resolve(SRC));
  return tree;
}

// Spelled through a variable so this file's own fixture text never reads as an
// `effect` import when the real-tree scan below walks it.
const EFFECT_PACKAGE = "effect";

/** A tree that obeys every rule — each case below breaks exactly one. */
const clean = (): Map<string, string> =>
  new Map([
    ["index.ts", 'export * from "./pure";'],
    ["pure/index.ts", "export const defineMachine = () => {};"],
    [
      "promise/index.ts",
      'export * from "./run";\nimport { defineMachine } from "../index";',
    ],
    ["promise/run.ts", 'import type { Machine } from "../pure";'],
    [
      "effect/index.ts",
      `import { Effect } from "${EFFECT_PACKAGE}";\nexport {};`,
    ],
  ]);

describe("the entry-point rules fire on each break", () => {
  it("passes a tree that obeys them", () => {
    expect(entryPointViolations(clean())).toEqual([]);
  });

  it("fails when the core reaches the Promise engine", () => {
    const tree = clean();
    tree.set("pure/index.ts", 'export { run } from "../promise/run";');
    expect(entryPointViolations(tree)).toContainEqual({
      rule: "core-imports-engine",
      file: "promise/run.ts",
    });
  });

  it("fails when the core reaches the Effect engine, type-only included", () => {
    const tree = clean();
    tree.set("index.ts", 'export type * from "./effect";');
    expect(entryPointViolations(tree)).toContainEqual({
      rule: "core-imports-engine",
      file: "effect/index.ts",
    });
  });

  it("fails when ./promise imports ./effect", () => {
    const tree = clean();
    tree.set("promise/run.ts", 'import "../effect";');
    expect(entryPointViolations(tree)).toContainEqual({
      rule: "engine-imports-engine",
      file: "effect/index.ts",
    });
  });

  it("fails when ./effect imports ./promise", () => {
    const tree = clean();
    tree.set("effect/index.ts", 'import { run } from "../promise";');
    expect(entryPointViolations(tree)).toContainEqual({
      rule: "engine-imports-engine",
      file: "promise/index.ts",
    });
  });

  it.each([
    "effect",
    "effect/Stream",
    "@effect/platform",
  ])("fails when a module outside ./effect imports %s", (specifier) => {
    const tree = clean();
    tree.set("promise/run.ts", `import { x } from "${specifier}";`);
    expect(entryPointViolations(tree)).toEqual([
      { rule: "effect-outside-effect", file: "promise/run.ts", specifier },
    ]);
  });
});

describe("src/ obeys the entry-point rules", () => {
  const tree = readSrcTree();

  it("reads the three entries it guards", () => {
    for (const entry of ["index.ts", "promise/index.ts", "effect/index.ts"]) {
      expect(tree.has(entry)).toBe(true);
    }
  });

  it("has no violations", () => {
    expect(entryPointViolations(tree)).toEqual([]);
  });

  it("exports `run` from ./promise and not from the core", async () => {
    const core = (await import("./index")) as Record<string, unknown>;
    const promise = (await import("./promise")) as Record<string, unknown>;
    expect("run" in core).toBe(false);
    expect(typeof promise.run).toBe("function");
  });
});
