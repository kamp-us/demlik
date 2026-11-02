import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { parse as parseToml } from "smol-toml";
import { Node, Project, type SourceFile, ts } from "ts-morph";
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

/** One row of a tsup `entry`: the output name it builds and the package-relative source it builds it from. */
export type TsupEntry = { readonly name: string; readonly source: string };

/** A row of a tsup `entry` with the edit that cuts it out of the syntax it was read from. */
type TsupRow = TsupEntry & { readonly cut: () => void };

/** A path a tsup `entry` names by a glob, which reaches files and names none of them. */
const GLOB = /[*?[\]{}!]/;

const literalText = (node: Node | undefined): string | undefined =>
  Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)
    ? node.getLiteralValue()
    : undefined;

/**
 * Every `entry` row a tsup config's syntax writes, the `dts.entry` one included, and why each
 * `entry` it cannot read is unreadable: a value held in a variable, built by a call, spread in, or
 * keyed by a computed name. A glob row is no row, since it names no single file.
 */
function tsupRows(source: SourceFile): {
  readonly rows: readonly TsupRow[];
  readonly unreadable: readonly string[];
} {
  const rows: TsupRow[] = [];
  const unreadable: string[] = [];
  const entries = source
    .getDescendants()
    .filter(
      (node) =>
        (Node.isPropertyAssignment(node) ||
          Node.isShorthandPropertyAssignment(node)) &&
        node.getName() === "entry",
    );
  for (const entry of entries) {
    const at = `line ${entry.getStartLineNumber()}`;
    const value = Node.isPropertyAssignment(entry)
      ? entry.getInitializer()
      : undefined;
    if (Node.isObjectLiteralExpression(value)) {
      for (const item of value.getProperties()) {
        const path = Node.isPropertyAssignment(item)
          ? literalText(item.getInitializer())
          : undefined;
        if (
          !Node.isPropertyAssignment(item) ||
          path === undefined ||
          Node.isComputedPropertyName(item.getNameNode())
        ) {
          unreadable.push(`${at}: ${item.getText()}`);
          continue;
        }
        if (GLOB.test(path)) continue;
        rows.push({
          name: item.getName().replace(/^["'`]|["'`]$/g, ""),
          source: posix.normalize(path),
          cut: () => item.remove(),
        });
      }
    } else if (Node.isArrayLiteralExpression(value)) {
      for (const element of value.getElements()) {
        const path = literalText(element);
        if (path === undefined) {
          unreadable.push(`${at}: ${element.getText()}`);
          continue;
        }
        if (GLOB.test(path)) continue;
        rows.push({
          name: posix.basename(path).replace(/\.(c|m)?tsx?$/, ""),
          source: posix.normalize(path),
          cut: () => value.removeElement(element),
        });
      }
    } else {
      unreadable.push(`${at}: ${entry.getText()}`);
    }
  }
  return { rows, unreadable };
}

/**
 * A package's tsup config, read off its syntax and never executed. `rows` are its `entry` rows,
 * `unreadable` each `entry` written in a form syntax cannot read.
 */
export class TsupConfig {
  private constructor(
    /** The config's file name, in the package's directory. */
    readonly file: string,
    readonly outDir: string,
    readonly rows: readonly TsupEntry[],
    readonly unreadable: readonly string[],
  ) {}

  static read(dir: string): TsupConfig | undefined {
    const file = readdirSync(dir).find((f) =>
      /^tsup\.config\.(c|m)?(t|j)s$/.test(f),
    );
    if (file === undefined) return undefined;
    const text = readFileSync(join(dir, file), "utf8");
    const source = TsupConfig.#parse(file, text);
    let outDir = "dist";
    for (const property of source
      .getDescendants()
      .filter(Node.isPropertyAssignment)) {
      const value = property.getInitializer();
      if (property.getName() === "outDir" && Node.isStringLiteral(value))
        outDir = posix.normalize(value.getLiteralValue());
    }
    const { rows, unreadable } = tsupRows(source);
    return new TsupConfig(
      file,
      outDir,
      rows.map(({ name, source }) => ({ name, source })),
      unreadable,
    );
  }

  static #parse(file: string, text: string): SourceFile {
    return new Project({ useInMemoryFileSystem: true }).createSourceFile(
      file,
      text,
    );
  }

  /** The `entry` map, output name to source; a later row of one name wins, as in an object literal. */
  get entries(): ReadonlyMap<string, string> {
    return new Map(this.rows.map(({ name, source }) => [name, source]));
  }

  /** `text`, a config of this file's kind, with every `entry` row whose source is in `sources` cut out. */
  without(text: string, sources: ReadonlySet<string>): string {
    const source = TsupConfig.#parse(this.file, text);
    // Last row first, so a cut never shifts a row still to be cut.
    for (const row of tsupRows(source).rows.toReversed())
      if (sources.has(row.source)) row.cut();
    return source.getFullText();
  }
}

/** tsup's `entry` and `outDir`, or the defaults when the package has no tsup config. */
type TsupLayout = {
  readonly outDir: string;
  readonly entries: ReadonlyMap<string, string>;
};

const tsupLayout = (config: TsupConfig | undefined): TsupLayout =>
  config === undefined
    ? { outDir: "dist", entries: new Map() }
    : { outDir: config.outDir, entries: config.entries };

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
  readonly tsup: TsupLayout;
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

/** The build layout of the package at `dir`, its tsup config read: tsup's and tsconfig's, or the bare convention without one. */
const layoutWith = (
  dir: string,
  tsup: TsupConfig | undefined,
): BuildLayout => ({
  tsup: tsupLayout(tsup),
  tsconfig: tsconfigDirs(dir),
});

/** The build layout of the package at `dir`: tsup's and tsconfig's, or the bare convention without one. */
const layoutOf = (dir: string): BuildLayout =>
  existsSync(dir)
    ? layoutWith(dir, TsupConfig.read(dir))
    : { tsup: tsupLayout(undefined), tsconfig: undefined };

// ── exports subpaths and the sources behind them ───────────────────────────

/**
 * One `exports` subpath and what answers it, package-relative. An `exact` entry's source is a file,
 * TypeScript or a plain one such as `package.json`; a `pattern` entry's key and source each hold the one `*` a wildcard subpath carries, its source
 * is a stem with no extension, since a pattern names no single file, and `extensions` are the source
 * files its target can be built from. A `sourceless` entry answers its key with no source in this
 * tree: a `null` block, or a target that follows back to nothing. It reaches no file, and it still
 * takes the subpaths a broader pattern would otherwise reach, exactly as Node picks.
 */
export type ExportEntry =
  | { readonly kind: "exact"; readonly key: string; readonly source: string }
  | {
      readonly kind: "pattern";
      readonly key: string;
      readonly source: string;
      readonly extensions: readonly string[];
    }
  | { readonly kind: "sourceless"; readonly key: string };

/** A TypeScript source file, as against a declaration file or built output. */
const SOURCE_FILE = /(?<!\.d)\.(c|m)?tsx?$/;

/** Stands in for a pattern's `*` while the dist-to-src follow-back reads it as a path. */
const STAR = "\u0000";

/**
 * Each `exports` key with its targets: a bare target or condition map answers `.`. A key whose
 * value holds no target at all, `null` above all, comes back with none.
 */
export function exportTargets(
  exports: unknown,
): [key: string, targets: string[]][] {
  const keyed =
    typeof exports === "object" &&
    exports !== null &&
    !Array.isArray(exports) &&
    Object.keys(exports).some((key) => key.startsWith("."));
  return keyed ? keyedTargets(exports) : [[".", strings(exports)]];
}

/** Each key of a `package.json` map with the targets its value holds, through any conditions. */
export function keyedTargets(map: unknown): [key: string, targets: string[]][] {
  return typeof map === "object" && map !== null
    ? Object.entries(map).map(([key, value]) => [key, strings(value)])
    : [];
}

/** The source extensions a wildcard target can be built from: `.mjs` from `.mts` and no other. */
const patternExtensions = (target: string): readonly string[] =>
  /\.(d\.)?m[jt]s$/.test(target)
    ? [".mts"]
    : /\.(d\.)?c[jt]s$/.test(target)
      ? [".cts"]
      : [".ts", ".tsx"];

/** The source stem a wildcard target builds from, `*` kept; `undefined` when none follows back. */
function patternSource(
  layout: BuildLayout,
  target: string,
): string | undefined {
  if (SOURCE_FILE.test(target)) return target.replace(SOURCE_FILE, "");
  const source = sourceEntryOf(layout, target.replace("*", STAR), (path) =>
    path.includes(STAR),
  );
  return source?.replace(SOURCE_FILE, "").replace(STAR, "*");
}

/** The entry one `exports` target makes under `key`; `undefined` when it follows back to no source. */
function entryOf(
  layout: BuildLayout,
  key: string,
  raw: string,
  exists: (packageRelative: string) => boolean,
): ExportEntry | undefined {
  const target = posix.normalize(raw);
  const stars = target.split("*").length - 1;
  if (stars !== key.split("*").length - 1 || stars > 1) return undefined;
  if (stars === 1) {
    const source = patternSource(layout, target);
    return source === undefined
      ? undefined
      : { kind: "pattern", key, source, extensions: patternExtensions(target) };
  }
  const source = BUILT.test(target)
    ? sourceEntryOf(layout, target, exists)
    : exists(target)
      ? target
      : undefined;
  return source === undefined ? undefined : { kind: "exact", key, source };
}

/**
 * Every subpath of the package at `dir` with what answers it: each `exports` target that follows
 * back to a source file, by the same follow-back `entryFiles` pins entries by, and a `sourceless`
 * entry for a key none of whose targets does. `exists` answers for a package-relative path, so the
 * caller picks the tree an exact target is resolved against.
 */
export function exportEntries(
  dir: string,
  exports: unknown,
  exists: (packageRelative: string) => boolean,
): ExportEntry[] {
  const layout = layoutOf(dir);
  return exportTargets(exports).flatMap(([key, targets]): ExportEntry[] => {
    const sourced = targets.flatMap((raw) => {
      const entry = entryOf(layout, key, raw, exists);
      return entry === undefined ? [] : [entry];
    });
    return sourced.length > 0 ? sourced : [{ kind: "sourceless", key }];
  });
}

/** A pattern's text either side of its `*`. */
const sides = (pattern: string): [string, string] => {
  const at = pattern.indexOf("*");
  return [pattern.slice(0, at), pattern.slice(at + 1)];
};

/**
 * The key Node answers `subpath` by: the exact key if there is one, else the pattern with the
 * longest text before its `*`, then the longest key (`PATTERN_KEY_COMPARE`).
 */
function answeringKey(
  keys: readonly string[],
  subpath: string,
): string | undefined {
  if (keys.includes(subpath)) return subpath;
  return keys
    .filter((key) => key.includes("*") && capture(key, subpath) !== undefined)
    .sort(
      (a, b) => sides(b)[0].length - sides(a)[0].length || b.length - a.length,
    )[0];
}

/** What `*` stands for when `pattern` matches `text`, or `undefined` when it does not. */
function capture(pattern: string, text: string): string | undefined {
  const [before, after] = sides(pattern);
  if (
    text.length < before.length + after.length ||
    !text.startsWith(before) ||
    !text.endsWith(after)
  )
    return undefined;
  return text.slice(before.length, text.length - after.length);
}

/**
 * What a map of `exports`, `imports` or tsconfig `paths` shape gives `text`, as written and with no
 * file looked for: the targets of the key that answers it, each `*` filled in.
 */
export function targetsFor(
  map: readonly (readonly [key: string, targets: readonly string[]])[],
  text: string,
): string[] {
  const key = answeringKey(
    map.map(([mapKey]) => mapKey),
    text,
  );
  if (key === undefined) return [];
  const star = key.includes("*") ? (capture(key, text) ?? "") : "";
  return map.flatMap(([mapKey, targets]) =>
    mapKey === key ? targets.map((target) => target.replaceAll("*", star)) : [],
  );
}

/**
 * Every subpath an import can name the package-relative source `file` by — `exports` inverted, most
 * direct first. Exact entries come before patterns, and a pattern reaches the file only where Node
 * would answer the subpath by that same pattern, so a narrower `null` block keeps it out.
 */
export function subpathsOf(
  entries: readonly ExportEntry[],
  file: string,
): string[] {
  const exact = entries.flatMap((e) =>
    e.kind === "exact" && e.source === file ? [e.key] : [],
  );
  const extension = SOURCE_FILE.exec(file)?.[0];
  if (extension === undefined) return exact;
  const stem = file.slice(0, file.length - extension.length);
  const patterned = entries.flatMap((entry) => {
    if (entry.kind !== "pattern" || !entry.extensions.includes(extension))
      return [];
    const star = capture(entry.source, stem);
    if (star === undefined) return [];
    const subpath = entry.key.replace("*", star);
    return answeringKey(
      entries.map((e) => e.key),
      subpath,
    ) === entry.key
      ? [subpath]
      : [];
  });
  return [...exact, ...patterned];
}

/** The subpath an import names `file` by, the first of {@link subpathsOf}; `undefined` when no entry reaches it. */
export const subpathOf = (
  entries: readonly ExportEntry[],
  file: string,
): string | undefined => subpathsOf(entries, file)[0];

/**
 * The package-relative source file `subpath` names, reading only the key Node answers it by.
 * `exists` picks the source extension a pattern's stem is completed with.
 */
export function sourceOfSubpath(
  entries: readonly ExportEntry[],
  subpath: string,
  exists: (packageRelative: string) => boolean,
): string | undefined {
  const key = answeringKey(
    entries.map((entry) => entry.key),
    subpath,
  );
  for (const entry of entries) {
    if (entry.key !== key) continue;
    if (entry.kind === "exact") return entry.source;
    if (entry.kind !== "pattern") continue;
    const star = capture(entry.key, subpath);
    if (star === undefined) continue;
    const stem = entry.source.replace("*", star);
    const found = entry.extensions.map((ext) => `${stem}${ext}`).find(exists);
    if (found !== undefined) return found;
  }
  return undefined;
}

// ── assembling the set ─────────────────────────────────────────────────────

/** A `package.json` field naming one file a runtime loads. */
export type EntryField = "main" | "module" | "types" | "bin";

/** What in a package names a file it loads by path. */
export type EntryRef =
  | { readonly kind: "field"; readonly field: EntryField }
  | { readonly kind: "wrangler"; readonly file: string }
  | { readonly kind: "export"; readonly key: string }
  | { readonly kind: "tsup"; readonly file: string; readonly source: string };

/**
 * One file a package names, repo-relative, with what names it. `via` is the built target the file
 * was followed back from, when the name points into the build output rather than at the file.
 */
export type NamedFile = {
  readonly path: string;
  readonly by: EntryRef;
  readonly via?: string;
};

/** Where a reference sits, as a person reads it: `package.json exports ./one`. */
export function describeRef(ref: EntryRef): string {
  switch (ref.kind) {
    case "field":
      return `package.json ${ref.field}`;
    case "wrangler":
      return `${ref.file} main`;
    case "export":
      return `package.json exports ${ref.key}`;
    case "tsup":
      return `${ref.file} entry ${ref.source}`;
  }
}

/** The why `entryFiles` pins a file for: the kind of name, without an `exports` key or tsup row. */
function pinReason({ by, via }: NamedFile): string {
  const why = by.kind === "export" ? "package.json exports" : describeRef(by);
  return via === undefined ? why : `${why} (source of ${via})`;
}

/**
 * Every file the package at `scope` names by path, in the order `entryFiles` reads them: each
 * wrangler `main`, then `package.json` `main`, `module`, `types`, `bin` and `exports`, then each
 * tsup `entry` row. A name pointing into the build output names the built path and, followed back,
 * the source that builds it. A wildcard target names no file. `exists` answers for a scope-relative
 * path, so the caller picks the tree a name is followed back against. `tsup` is the package's tsup
 * config, `undefined` without one.
 */
export function packageEntries(
  repoRoot: string,
  scope: string,
  exists: (scopeRelative: string) => boolean,
): {
  readonly named: readonly NamedFile[];
  readonly tsup: TsupConfig | undefined;
} {
  const dir = join(repoRoot, scope);
  if (!existsSync(dir)) return { named: [], tsup: undefined };
  const tsup = TsupConfig.read(dir);
  const layout = layoutWith(dir, tsup);
  const repoPath = (scopeRelative: string) =>
    posix.join(scope, posix.normalize(scopeRelative));
  const named: NamedFile[] = [];
  const name = (target: string | undefined, by: EntryRef) => {
    if (target === undefined || target.includes("*")) return;
    const normalized = posix.normalize(target);
    named.push({ path: repoPath(normalized), by });
    const source = sourceEntryOf(layout, normalized, exists);
    if (source !== undefined)
      named.push({ path: repoPath(source), by, via: normalized });
  };

  for (const file of readdirSync(dir)
    .filter((f) => /^wrangler.*\.toml$/.test(f))
    .sort()) {
    const mains = WranglerMains.parse(
      parseToml(readFileSync(join(dir, file), "utf8")),
    );
    for (const main of mains) name(main, { kind: "wrangler", file });
  }

  const pkgPath = join(dir, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = PackageEntries.parse(JSON.parse(readFileSync(pkgPath, "utf8")));
    name(pkg.main, { kind: "field", field: "main" });
    name(pkg.module, { kind: "field", field: "module" });
    name(pkg.types, { kind: "field", field: "types" });
    for (const bin of strings(pkg.bin))
      name(bin, { kind: "field", field: "bin" });
    if (pkg.exports !== undefined)
      for (const [key, targets] of exportTargets(pkg.exports))
        for (const target of targets) name(target, { kind: "export", key });
  }

  if (tsup !== undefined)
    for (const { source } of tsup.rows)
      named.push({
        path: repoPath(source),
        by: { kind: "tsup", file: tsup.file, source },
      });
  return { named, tsup };
}

/**
 * Every file under `scope` that must not move, keyed by repo-relative path. `tree` is every file
 * under `scope`, repo-relative — the framework conventions are read off it, not off the disk. A
 * tsup `entry` row pins its source only when a `package.json` field follows back to it.
 */
export function entryFiles(
  repoRoot: string,
  scope: string,
  tree: readonly string[],
): EntryFiles {
  const dir = join(repoRoot, scope);
  const inTree = new Set(tree);
  const entries = new Map<string, string>();
  const exists = (scopeRelative: string) =>
    inTree.has(posix.join(scope, posix.normalize(scopeRelative))) ||
    existsSync(join(dir, scopeRelative));
  // The first reason a file is pinned for is the one the manifest names.
  const record = (path: string, why: string) => {
    if (!entries.has(path)) entries.set(path, why);
  };
  for (const named of packageEntries(repoRoot, scope, exists).named)
    if (named.by.kind !== "tsup") record(named.path, pinReason(named));
  for (const [path, why] of nextConventionEntries(scope, tree))
    record(path, why);
  return entries;
}
