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

/**
 * Resolve specifiers from the checkout at `root` the way the scope's own build would: oxc-resolver
 * under the tsconfig `resolveEdgeTsConfig` picks for `scope`, so a `paths` alias resolves to the
 * file it names. With no tsconfig at or above the scope, aliases stay `unknown`.
 */
export function specifierResolver(
  root: string,
  scope: string,
): SpecifierResolver {
  let configFile: string | undefined;
  try {
    configFile = resolveEdgeTsConfig(join(root, scope), "package", root);
  } catch {
    configFile = undefined;
  }
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
    return { kind: "repo", path: path.split(sep).join("/") };
  };
}
