import fs from "node:fs";
import path from "node:path";
import * as ts from "./engine/tsgo.js";
import { type EdgeScope, resolveEdgeTsConfig } from "./extract/project.js";

export interface ExportOrigin {
  readonly file: string;
  readonly name: string;
}

// `line` is 1-based and points at the declaration's first token, past any doc comment, so two
// declarations of one name in one file stay apart.
export interface ExportDeclaration {
  readonly file: string;
  readonly name: string;
  readonly line: number;
}

export interface SubpathExport {
  readonly subpath: string;
  readonly entry: string;
  readonly declaration: ExportDeclaration;
}

// A map entry whose source file does not exist, so nothing can be said about what it publishes.
// `given` is the path as the caller wrote it; `entry` is that path made absolute.
export interface UnresolvableSubpath {
  readonly subpath: string;
  readonly given: string;
  readonly entry: string;
  readonly unresolvable: "missing-entry-file";
}

// Narrow with `"unresolvable" in result`. A correct map yields only `SubpathExport` values.
export type SubpathAnswer = SubpathExport | UnresolvableSubpath;

// The caller's own subpath-to-source map, e.g. `{ ".": "src/index.ts", "./testing":
// "src/testing/index.ts" }`. An export map points at build output, and only the build config knows
// which source file each entry comes from, so the resolver never guesses that layout.
export type SubpathEntries = Readonly<Record<string, string>>;

// The graph holds one tsgo process from its first lookup until `dispose()`, so a long-lived caller
// disposes the graph when it is done with it. A lookup after `dispose()` throws.
export interface InProcessGraph {
  resolveExportOrigin(fromFile: string, specifier: string, exportName: string): ExportOrigin | null;
  resolveModuleExport(moduleFile: string, exportName: string): ExportDeclaration | null;
  resolvePublishingSubpaths(entries: SubpathEntries, exportName: string): readonly SubpathAnswer[];
  dispose(): void;
}

export interface InProcessGraphOptions {
  readonly scope?: EdgeScope;
  readonly repoRoot?: string;
}

function declaredName(decl: ts.Node): string | null {
  const name = (decl as { name?: ts.Node }).name;
  if (name === undefined || !ts.isIdentifier(name)) return null;
  return name.text;
}

function importedModule(
  program: ts.TypeProgram,
  source: ts.SourceFile,
  specifier: string,
): ts.TsSymbol | undefined {
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const literal = statement.moduleSpecifier;
    if (!ts.isStringLiteral(literal) || literal.text !== specifier) continue;
    return program.symbolAt(literal);
  }
  return undefined;
}

// The first declaration, as for an overload set or a merged name: the first overload signature.
function exportedDeclaration(
  program: ts.TypeProgram,
  moduleSymbol: ts.TsSymbol,
  exportName: string,
): ts.Node | undefined {
  const exported = program.exportsOf(moduleSymbol).get(exportName);
  if (exported === undefined) return undefined;
  return program.declarations(program.aliasTarget(exported) ?? exported)[0];
}

function exportOrigin(
  program: ts.TypeProgram,
  fromFile: string,
  specifier: string,
  exportName: string,
): ExportOrigin | null {
  const source = program.sourceFile(fromFile);
  if (source === undefined) return null;
  const moduleSymbol = importedModule(program, source, specifier);
  if (moduleSymbol === undefined) return null;
  const decl = exportedDeclaration(program, moduleSymbol, exportName);
  if (decl === undefined) return null;
  return { file: decl.getSourceFile().fileName, name: declaredName(decl) ?? exportName };
}

function moduleExport(
  program: ts.TypeProgram,
  moduleFile: string,
  exportName: string,
): ExportDeclaration | null {
  const source = program.sourceFile(moduleFile);
  if (source === undefined) return null;
  const moduleSymbol = program.symbolAt(source);
  if (moduleSymbol === undefined) return null;
  const decl = exportedDeclaration(program, moduleSymbol, exportName);
  if (decl === undefined) return null;
  const declaring = decl.getSourceFile();
  return {
    file: declaring.fileName,
    name: declaredName(decl) ?? exportName,
    line: declaring.getLineAndCharacterOfPosition(decl.getStart(declaring)).line + 1,
  };
}

type SessionState =
  | { readonly kind: "idle" }
  | { readonly kind: "open"; readonly session: ts.TypeSession }
  | { readonly kind: "disposed" };

interface LazySession {
  // Opens a program over `file` alone, hands it to `read`, and closes it. A missing file answers
  // `null` before any session opens.
  withProgram<A>(file: string, read: (program: ts.TypeProgram) => A | null): A | null;
  dispose(): void;
}

function lazySession(tsConfigPath: string): LazySession {
  let state: SessionState = { kind: "idle" };
  const session = (): ts.TypeSession => {
    switch (state.kind) {
      case "open":
        return state.session;
      case "idle":
        state = { kind: "open", session: ts.openTypeSession(tsConfigPath) };
        return state.session;
      case "disposed":
        throw new Error("code-graph: lookup called on a disposed InProcessGraph");
      default: {
        const exhaustive: never = state;
        return exhaustive;
      }
    }
  };

  return {
    withProgram(file, read) {
      if (!fs.existsSync(file)) return null;
      const program = session().program({ rootFiles: [file], includeConfigFiles: false });
      try {
        return read(program);
      } finally {
        program.close();
      }
    },
    dispose() {
      if (state.kind === "open") state.session.close();
      state = { kind: "disposed" };
    },
  };
}

// Each lookup opens a program over the file it asks about alone, so its answer does not depend on
// which files earlier lookups named; the programs share one tsgo session, opened on the first lookup.
export function loadInProcessGraph(
  root: string,
  options: InProcessGraphOptions = {},
): InProcessGraph | null {
  const rootAbsolute = path.resolve(root);
  const scope: EdgeScope = options.scope ?? "package";
  const repoRoot = options.repoRoot ?? rootAbsolute;

  let tsConfigPath: string;
  try {
    tsConfigPath = resolveEdgeTsConfig(rootAbsolute, scope, repoRoot);
  } catch {
    return null;
  }

  const session = lazySession(tsConfigPath);
  const resolveModuleExport = (moduleFile: string, exportName: string) => {
    const absModule = path.resolve(moduleFile);
    return session.withProgram(absModule, (program) =>
      moduleExport(program, absModule, exportName),
    );
  };

  return {
    resolveExportOrigin(fromFile, specifier, exportName) {
      const absFrom = path.resolve(fromFile);
      return session.withProgram(absFrom, (program) =>
        exportOrigin(program, absFrom, specifier, exportName),
      );
    },
    resolveModuleExport,
    resolvePublishingSubpaths(entries, exportName) {
      return Object.entries(entries).flatMap(([subpath, given]): SubpathAnswer[] => {
        const entry = path.resolve(given);
        if (!fs.existsSync(entry))
          return [{ subpath, given, entry, unresolvable: "missing-entry-file" }];
        const declaration = resolveModuleExport(entry, exportName);
        return declaration === null ? [] : [{ subpath, entry, declaration }];
      });
    },
    dispose: () => session.dispose(),
  };
}
