import fs from "node:fs";
import path from "node:path";
import * as ts from "./engine/tsgo.js";
import { type EdgeScope, resolveEdgeTsConfig } from "./extract/project.js";

export interface ExportOrigin {
  readonly file: string;
  readonly name: string;
}

export interface InProcessGraph {
  resolveExportOrigin(fromFile: string, specifier: string, exportName: string): ExportOrigin | null;
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

// Each lookup opens tsgo over the importing file alone and closes it again: the interface carries no
// lifecycle, and a checker left running would hold the caller's process open.
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

  return {
    resolveExportOrigin(fromFile, specifier, exportName) {
      const absFrom = path.resolve(fromFile);
      if (!fs.existsSync(absFrom)) return null;
      const program = ts.openTypeProgram({
        tsConfigPath,
        rootFiles: [absFrom],
        includeConfigFiles: false,
      });
      try {
        return exportOrigin(program, absFrom, specifier, exportName);
      } finally {
        program.close();
      }
    },
  };
}
