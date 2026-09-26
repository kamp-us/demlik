import fs from "node:fs";
import path from "node:path";
import * as ts from "./engine/tsgo.js";
import { type EdgeScope, resolveEdgeTsConfig } from "./extract/project.js";

export interface ExportOrigin {
  readonly file: string;
  readonly name: string;
}

// The graph holds one tsgo process from its first lookup until `dispose()`, so a long-lived caller
// disposes the graph when it is done with it. A lookup after `dispose()` throws.
export interface InProcessGraph {
  resolveExportOrigin(fromFile: string, specifier: string, exportName: string): ExportOrigin | null;
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
  const exported = program.exportsOf(moduleSymbol).get(exportName);
  if (exported === undefined) return null;
  const decl = program.declarations(program.aliasTarget(exported) ?? exported)[0];
  if (decl === undefined) return null;
  return { file: decl.getSourceFile().fileName, name: declaredName(decl) ?? exportName };
}

type SessionState =
  | { readonly kind: "idle" }
  | { readonly kind: "open"; readonly session: ts.TypeSession }
  | { readonly kind: "disposed" };

// Each lookup opens a program over the importing file alone, so its answer does not depend on which
// files earlier lookups named; the programs share one tsgo session, opened on the first lookup.
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

  let state: SessionState = { kind: "idle" };
  const session = (): ts.TypeSession => {
    switch (state.kind) {
      case "open":
        return state.session;
      case "idle":
        state = { kind: "open", session: ts.openTypeSession(tsConfigPath) };
        return state.session;
      case "disposed":
        throw new Error("code-graph: resolveExportOrigin called on a disposed InProcessGraph");
      default: {
        const exhaustive: never = state;
        return exhaustive;
      }
    }
  };

  return {
    resolveExportOrigin(fromFile, specifier, exportName) {
      const absFrom = path.resolve(fromFile);
      if (!fs.existsSync(absFrom)) return null;
      const program = session().program({ rootFiles: [absFrom], includeConfigFiles: false });
      try {
        return exportOrigin(program, absFrom, specifier, exportName);
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
