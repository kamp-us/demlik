import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { parse as parseToml } from "smol-toml";
import { Node, Project, ts } from "ts-morph";
import { z } from "zod";

/**
 * Files a runtime or framework loads by path, so moving one breaks the program even with every import
 * rewritten. Three sources say which: a config's `main`/`bin`/`exports` (followed back from `dist/` to
 * the source that builds it), a wrangler `main`, and framework file conventions no config names.
 */
export type EntryFiles = ReadonlyMap<string, string>;

const WranglerMains = z
  .object({
    main: z.string().optional(),
    env: z
      .record(z.string(), z.object({ main: z.string().optional() }))
      .optional(),
  })
  .transform((w) => [w.main, ...Object.values(w.env ?? {}).map((e) => e.main)]);

const PackageEntries = z.object({
  main: z.string().optional(),
  module: z.string().optional(),
  types: z.string().optional(),
  bin: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
  exports: z.unknown().optional(),
});

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === "object" && value !== null)
    return Object.values(value).flatMap(strings);
  return [];
}

// ── Next.js app router ─────────────────────────────────────────────────────

/** The files the Next.js app router loads by name from anywhere under `app/`. */
const NEXT_APP_FILE =
  /^(page|layout|route|loading|error|global-error|not-found|template|default)\.(tsx|ts|jsx|js|mdx)$/;

/** The files Next.js loads by name from the project root (or `src/`). */
const NEXT_ROOT_FILE = /^(middleware|instrumentation)\.(ts|js)$/;

function nextConventionEntries(
  scope: string,
  tree: readonly string[],
): [string, string][] {
  const appDirs = [posix.join(scope, "app/"), posix.join(scope, "src/app/")];
  const rootDirs = new Set([scope, posix.join(scope, "src")]);
  return tree.flatMap((path): [string, string][] => {
    const name = posix.basename(path);
    const appDir = appDirs.find((dir) => path.startsWith(dir));
    if (appDir !== undefined && NEXT_APP_FILE.test(name)) {
      return [
        [
          path,
          `Next.js ${appDir.slice(scope.length + 1, -1)}/ ${name.split(".")[0]}`,
        ],
      ];
    }
    if (rootDirs.has(posix.dirname(path)) && NEXT_ROOT_FILE.test(name)) {
      return [[path, `Next.js root ${name.split(".")[0]}`]];
    }
    return [];
  });
}

// ── dist/ back to src/ ─────────────────────────────────────────────────────

const BUILT = /(\.d)?\.(c|m)?js$|\.d\.(c|m)?ts$/;
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

/** tsup's `entry`, as `{ outputName: sourcePath }` — read off the config's syntax, never executed. */
function tsupEntries(dir: string): {
  outDir: string;
  entries: Map<string, string>;
} {
  const entries = new Map<string, string>();
  let outDir = "dist";
  const file = readdirSync(dir).find((f) =>
    /^tsup\.config\.(c|m)?(t|j)s$/.test(f),
  );
  if (file === undefined) return { outDir, entries };
  const project = new Project({ useInMemoryFileSystem: true });
  const source = project.createSourceFile(
    file,
    readFileSync(join(dir, file), "utf8"),
  );
  for (const property of source
    .getDescendants()
    .filter(Node.isPropertyAssignment)) {
    const value = property.getInitializer();
    if (property.getName() === "outDir" && Node.isStringLiteral(value)) {
      outDir = posix.normalize(value.getLiteralValue());
    }
    if (property.getName() !== "entry") continue;
    if (Node.isObjectLiteralExpression(value)) {
      for (const item of value
        .getProperties()
        .filter(Node.isPropertyAssignment)) {
        const target = item.getInitializer();
        if (Node.isStringLiteral(target)) {
          entries.set(
            item.getName().replace(/^["']|["']$/g, ""),
            target.getLiteralValue(),
          );
        }
      }
    } else if (Node.isArrayLiteralExpression(value)) {
      for (const element of value.getElements().filter(Node.isStringLiteral)) {
        const path = element.getLiteralValue();
        entries.set(posix.basename(path).replace(/\.(c|m)?tsx?$/, ""), path);
      }
    }
  }
  return { outDir, entries };
}

/** tsconfig's `outDir` → `rootDir`, when it declares both. */
function tsconfigDirs(
  dir: string,
): { outDir: string; rootDir: string } | undefined {
  const path = join(dir, "tsconfig.json");
  if (!existsSync(path)) return undefined;
  const { config } = ts.parseConfigFileTextToJson(
    path,
    readFileSync(path, "utf8"),
  );
  const options = (
    config as { compilerOptions?: { outDir?: unknown; rootDir?: unknown } }
  )?.compilerOptions;
  if (
    typeof options?.outDir !== "string" ||
    typeof options.rootDir !== "string"
  )
    return undefined;
  return {
    outDir: posix.normalize(options.outDir),
    rootDir: posix.normalize(options.rootDir),
  };
}

/**
 * The source file a built path under `dist/` comes from, scope-relative, or `undefined` when the
 * target is not built output or no source for it is in the tree. Tried in order: tsup's `entry` map,
 * tsconfig `outDir`/`rootDir`, then the `dist/` ↔ `src/` convention.
 */
interface BuildLayout {
  readonly tsup: ReturnType<typeof tsupEntries>;
  readonly tsconfig: ReturnType<typeof tsconfigDirs>;
}

function sourceEntryOf(
  { tsup, tsconfig }: BuildLayout,
  target: string,
  exists: (scopeRelative: string) => boolean,
): string | undefined {
  if (!BUILT.test(target)) return undefined;
  const firstExisting = (stem: string) =>
    SOURCE_EXTENSIONS.map((ext) => `${stem}${ext}`).find(exists);

  const underOut = (outDir: string) =>
    target.startsWith(`${outDir}/`)
      ? target.slice(outDir.length + 1).replace(BUILT, "")
      : undefined;

  const tsupName = underOut(tsup.outDir);
  const tsupSource =
    tsupName === undefined ? undefined : tsup.entries.get(tsupName);
  if (tsupSource !== undefined && exists(posix.normalize(tsupSource))) {
    return posix.normalize(tsupSource);
  }
  if (tsconfig !== undefined) {
    const rest = underOut(tsconfig.outDir);
    const found =
      rest === undefined
        ? undefined
        : firstExisting(posix.join(tsconfig.rootDir, rest));
    if (found !== undefined) return found;
  }
  const rest = underOut("dist");
  return rest === undefined
    ? undefined
    : firstExisting(posix.join("src", rest));
}

// ── assembling the set ─────────────────────────────────────────────────────

/**
 * Every file under `scope` that must not move, keyed by repo-relative path. `tree` is every file
 * under `scope`, repo-relative — the framework conventions are read off it, not off the disk.
 */
export function entryFiles(
  repoRoot: string,
  scope: string,
  tree: readonly string[],
): EntryFiles {
  const dir = join(repoRoot, scope);
  const inTree = new Set(tree);
  const entries = new Map<string, string>();
  const layout: BuildLayout = existsSync(dir)
    ? { tsup: tsupEntries(dir), tsconfig: tsconfigDirs(dir) }
    : { tsup: { outDir: "dist", entries: new Map() }, tsconfig: undefined };
  const repoPath = (scopeRelative: string) =>
    posix.join(scope, posix.normalize(scopeRelative));
  const exists = (scopeRelative: string) =>
    inTree.has(repoPath(scopeRelative)) || existsSync(join(dir, scopeRelative));
  // The first reason a file is pinned for is the one the manifest names.
  const record = (path: string, why: string) => {
    if (!entries.has(path)) entries.set(path, why);
  };
  const pin = (target: string | undefined, why: string) => {
    if (target === undefined || target.includes("*")) return;
    const normalized = posix.normalize(target);
    record(repoPath(normalized), why);
    const source = sourceEntryOf(layout, normalized, exists);
    if (source !== undefined)
      record(repoPath(source), `${why} (source of ${normalized})`);
  };

  if (existsSync(dir)) {
    for (const name of readdirSync(dir)
      .filter((f) => /^wrangler.*\.toml$/.test(f))
      .sort()) {
      const mains = WranglerMains.parse(
        parseToml(readFileSync(join(dir, name), "utf8")),
      );
      for (const main of mains) pin(main, `${name} main`);
    }
  }

  const pkgPath = join(dir, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = PackageEntries.parse(JSON.parse(readFileSync(pkgPath, "utf8")));
    pin(pkg.main, "package.json main");
    pin(pkg.module, "package.json module");
    pin(pkg.types, "package.json types");
    for (const bin of strings(pkg.bin)) pin(bin, "package.json bin");
    for (const target of strings(pkg.exports))
      pin(target, "package.json exports");
  }

  for (const [path, why] of nextConventionEntries(scope, tree))
    record(path, why);
  return entries;
}
