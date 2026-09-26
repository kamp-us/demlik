import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { resolveEdgeTsConfig } from "@demlik/code-graph/project";
import {
  type Node,
  type Program,
  parseSync,
  type StaticExportEntry,
  Visitor,
} from "oxc-parser";
import { ResolverFactory } from "oxc-resolver";
import { ts } from "ts-morph";
import {
  trackedPaths,
  type UntrackedFile,
  untrackedFiles,
  type WorkingTreeChange,
  workingTreeChanges,
} from "./git.js";

/**
 * One `import … from` / `import "…"` statement, or one `export … from` re-export: the module it
 * names and the statement's own span, `[start, end)` in UTF-16 code units.
 */
export interface ModuleStatement {
  readonly specifier: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Where a module specifier sits in source: the string literal's span, quotes included. A static
 * import, an `export … from`, an `import("…")` or `require("…")` with a string literal, an
 * `import x = require("…")`, and a type-position `import("…")`.
 */
export interface SpecifierSite {
  readonly specifier: string;
  readonly start: number;
  readonly end: number;
}

/** What one TypeScript file says about the modules around it, read by oxc-parser. */
export interface ModuleSyntax {
  /** Whether the parser read the file without an error; the lists below may be partial when not. */
  readonly parsed: boolean;
  /** Static import statements, bare `import "…"` included, in source order. */
  readonly imports: readonly ModuleStatement[];
  /** `export * from`, `export * as ns from`, `export { a } from`, `export type { T } from`. */
  readonly reExports: readonly ModuleStatement[];
  /**
   * Names this file declares and exports, in source order, one per exporting declaration: a
   * default export counts under its declaration's own name, and an anonymous one not at all.
   */
  readonly exports: readonly string[];
  /** Every module specifier site, in source order. */
  readonly sites: readonly SpecifierSite[];
}

const localName = (entry: StaticExportEntry): string | null => {
  if (entry.moduleRequest !== null) return null;
  if (entry.exportName.kind === "Name") return entry.exportName.name;
  if (entry.exportName.kind === "Default" && entry.localName.kind === "Name")
    return entry.localName.name;
  return null;
};

const stringLiteral = (
  node: Node | null | undefined,
): SpecifierSite | undefined =>
  node?.type === "Literal" && typeof node.value === "string"
    ? { specifier: node.value, start: node.start, end: node.end }
    : undefined;

/** The specifier sites the module record does not carry: dynamic, `require`, import-equals, type. */
function expressionSites(program: Program): SpecifierSite[] {
  const sites: SpecifierSite[] = [];
  const add = (site: SpecifierSite | undefined) => {
    if (site !== undefined) sites.push(site);
  };
  new Visitor({
    ImportExpression: (node) => add(stringLiteral(node.source)),
    CallExpression: (node) => {
      if (
        node.callee.type === "Identifier" &&
        node.callee.name === "require" &&
        node.arguments.length === 1
      )
        add(stringLiteral(node.arguments[0]));
    },
    TSExternalModuleReference: (node) => add(stringLiteral(node.expression)),
    TSImportType: (node) => add(stringLiteral(node.source)),
  }).visit(program);
  return sites;
}

const bySpan = (a: { start: number }, b: { start: number }) =>
  a.start - b.start;

/** Parse `text` as the TypeScript file at `path` (`.tsx` as TSX) and read its module syntax. */
export function readModule(path: string, text: string): ModuleSyntax {
  const lang = path.endsWith(".tsx") ? "tsx" : "ts";
  const result = parseSync(path, text, { lang, sourceType: "module" });
  const record = result.module;
  const imports = record.staticImports.map((s) => ({
    specifier: s.moduleRequest.value,
    start: s.start,
    end: s.end,
  }));
  const reExports: ModuleStatement[] = [];
  const exports: string[] = [];
  const sites: SpecifierSite[] = record.staticImports.map((s) => ({
    specifier: s.moduleRequest.value,
    start: s.moduleRequest.start,
    end: s.moduleRequest.end,
  }));
  for (const statement of record.staticExports) {
    const from = statement.entries.find(
      (e) => e.moduleRequest !== null,
    )?.moduleRequest;
    if (from != null) {
      reExports.push({
        specifier: from.value,
        start: statement.start,
        end: statement.end,
      });
      sites.push({ specifier: from.value, start: from.start, end: from.end });
    }
    for (const entry of statement.entries) {
      const name = localName(entry);
      if (name !== null) exports.push(name);
    }
  }
  sites.push(...expressionSites(result.program));
  return {
    parsed: result.errors.length === 0,
    imports,
    reExports,
    exports,
    sites: sites.sort(bySpan),
  };
}

/** The modules a file depends on statically: its imports and re-exports, in source order. */
export const staticDependencies = (syntax: ModuleSyntax): string[] =>
  [...syntax.imports, ...syntax.reExports].sort(bySpan).map((s) => s.specifier);

/**
 * Where a specifier leads: a file in the repository (repo-relative path), somewhere outside it the
 * code does not own (a `node_modules` install or a runtime builtin), or nowhere the resolver found.
 */
export type Destination =
  | { readonly kind: "repo"; readonly path: string }
  | { readonly kind: "external" }
  | { readonly kind: "unknown" };

/** Resolve `specifier` as written in the repo-relative file `from`. */
export type SpecifierResolver = (
  from: string,
  specifier: string,
) => Destination;

/** A resolver that knows nothing: every specifier is `unknown`, the reading that hides the most. */
export const resolvesNothing: SpecifierResolver = () => ({ kind: "unknown" });

const inNodeModules = (path: string) =>
  path.split(sep).includes("node_modules");

const repoPath = (root: string, path: string) =>
  relative(root, path).split(sep).join("/");

const outsideRepo = (path: string) => path === ".." || path.startsWith("../");

const installed = (path: string) => path.split("/").includes("node_modules");

/**
 * The tsconfig `configFile` and every config its `extends` chain reads, repo-relative: the only
 * files whose content decides where an alias resolves.
 */
function tsconfigChain(root: string, configFile: string): Set<string> {
  const source = ts.readJsonConfigFile(configFile, ts.sys.readFile);
  ts.parseJsonSourceFileConfigFileContent(
    source,
    ts.sys,
    dirname(configFile),
    undefined,
    configFile,
  );
  return new Set(
    [configFile, ...(source.extendedSourceFiles ?? [])].map((path) =>
      repoPath(root, path),
    ),
  );
}

const within = (path: string, owned: string) =>
  path === owned || path.startsWith(`${owned}/`);

const isPackageJson = (path: string) =>
  path.split("/").at(-1) === "package.json";

/**
 * Whether a change to a tracked path can move where a specifier resolves. A path appearing,
 * vanishing or changing type can: a specifier may name any path exactly. So can a symlink pointing
 * somewhere else, since resolution follows it to a real path. A content edit can only in a file
 * resolution reads as configuration — a `package.json`, or a member of the tsconfig `chain`.
 */
const movesResolution =
  (chain: ReadonlySet<string>) =>
  (change: WorkingTreeChange): boolean =>
    change.kind !== "modified" ||
    isPackageJson(change.path) ||
    chain.has(change.path);

/**
 * A path the working tree holds differently from `--ref` in a way that can steer where a specifier
 * resolves: a tracked change, a configuration file on disk the ref tree does not hold (`untracked`
 * or `ignored`), or a tsconfig the chain extends from outside the repository.
 */
type Divergence =
  | WorkingTreeChange
  | UntrackedFile
  | { readonly kind: "outside"; readonly path: string };

/**
 * Every divergence between the working tree at `root` and the tree `ref` names (`atRef`) that can
 * move a specifier onto a different file at `ref`, sorted by path. An answer that is not a file at
 * `ref` already reads `unknown`, so what is left is a tracked path appearing, vanishing, retyped or
 * retargeted, and configuration: a `package.json` outside any `node_modules`, or a member of the
 * tsconfig `chain`, edited or on disk off the ref tree. The run's own files (`owned`:
 * repo-relative files, or directories taken whole) are neither a destination nor configuration.
 */
function resolutionDivergence(
  root: string,
  ref: string,
  atRef: ReadonlySet<string>,
  chain: ReadonlySet<string>,
  owned: readonly string[],
): Divergence[] {
  const config = [...chain].filter((path) => !installed(path));
  const offRef = untrackedFiles(root, [
    ":(glob)**/package.json",
    ...config
      .filter((path) => !outsideRepo(path))
      .map((path) => `:(literal)${path}`),
    ":(exclude,glob)**/node_modules/**",
  ]).filter((file) => !atRef.has(file.path));
  const divergences: Divergence[] = [
    ...workingTreeChanges(root, ref).filter(movesResolution(chain)),
    ...offRef,
    ...config
      .filter(outsideRepo)
      .map((path) => ({ kind: "outside" as const, path })),
  ];
  return divergences
    .filter((d) => !owned.some((path) => within(d.path, path)))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Resolve specifiers written in the tree `ref` names the way the scope's own build would:
 * oxc-resolver under the tsconfig `resolveEdgeTsConfig` picks for `scope`, so a `paths` alias
 * resolves to the file it names. With no tsconfig at or above the scope, aliases stay `unknown`.
 * oxc-resolver reads the checkout on disk, so an in-repo answer is `repo` only when it is a file in
 * the tree `ref` names: an ignored or untracked file, a file inside a submodule, or build output
 * reads `unknown`. That check cannot see the working tree steering resolution onto a different
 * file that is at `ref`, so this throws, naming every path, on any divergence that can
 * (`resolutionDivergence`). `owned` lists the absolute paths — files, or directories taken whole —
 * the run itself reads or writes outside resolution.
 */
export function specifierResolver(
  root: string,
  scope: string,
  ref: string,
  owned: readonly string[] = [],
): SpecifierResolver {
  let configFile: string | undefined;
  try {
    configFile = resolveEdgeTsConfig(join(root, scope), "package", root);
  } catch {
    configFile = undefined;
  }
  const chain =
    configFile === undefined
      ? new Set<string>()
      : tsconfigChain(root, configFile);
  const atRef = new Set(trackedPaths(root, { ref }));
  const diverging = resolutionDivergence(
    root,
    ref,
    atRef,
    chain,
    owned.map((path) => repoPath(root, path)),
  );
  if (diverging.length > 0)
    throw new Error(
      `--redact resolves module aliases from the working tree, which differs from ${ref} in ${diverging.length} path(s) that decide where a specifier resolves:\n${diverging
        .map((divergence) => `  ${divergence.kind} ${divergence.path}`)
        .join(
          "\n",
        )}\nsweep --ref at a commit the working tree matches, or check out ${ref} first`,
    );
  const factory = new ResolverFactory({
    ...(configFile === undefined ? {} : { tsconfig: { configFile } }),
    builtinModules: true,
    extensions: [
      ".ts",
      ".tsx",
      ".d.ts",
      ".mts",
      ".cts",
      ".js",
      ".jsx",
      ".mjs",
      ".cjs",
      ".json",
    ],
    extensionAlias: {
      ".js": [".ts", ".tsx", ".d.ts", ".js"],
      ".jsx": [".tsx", ".jsx"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"],
    },
    conditionNames: ["types", "import", "node", "default"],
  });
  // The resolver answers real paths, so compare against the real root: a temp or symlinked
  // checkout would otherwise read every file in it as outside the repository.
  const real = realpathSync(root);
  return (from, specifier) => {
    const result = factory.sync(dirname(join(real, from)), specifier);
    if (result.builtin !== undefined) return { kind: "external" };
    if (result.path === undefined) return { kind: "unknown" };
    const path = relative(real, result.path);
    if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
      return { kind: "unknown" };
    if (inNodeModules(path)) return { kind: "external" };
    const file = path.split(sep).join("/");
    return atRef.has(file) ? { kind: "repo", path: file } : { kind: "unknown" };
  };
}
