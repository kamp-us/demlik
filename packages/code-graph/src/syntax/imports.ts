import fs from "node:fs";
import { createModuleResolver } from "../engine/oxc.js";
import { type SourceUnit, toRelative } from "../extract/project.js";
import type { ImportEdge } from "../schema.js";
import { field, nodeField, type SyntaxFile, type SyntaxNode } from "./file.js";

export type ImportLiteral = {
  readonly specifier: string;
  readonly kind: ImportEdge["kind"];
  readonly typeOnly: boolean;
  readonly start: number;
};

function stringValue(node: SyntaxNode | null): string | null {
  if (node === null) return null;
  if (node.type === "Literal") {
    const value = field(node, "value");
    return typeof value === "string" ? value : null;
  }
  if (node.type === "TemplateLiteral") {
    const expressions = field(node, "expressions");
    const quasis = field(node, "quasis");
    if (!Array.isArray(expressions) || expressions.length > 0 || !Array.isArray(quasis))
      return null;
    const cooked = (quasis[0] as { value?: { cooked?: unknown } } | undefined)?.value?.cooked;
    return typeof cooked === "string" ? cooked : null;
  }
  return null;
}

function isRelativeName(name: string): boolean {
  return /^\.\.?($|[\\/])/.test(name);
}

function literalOf(
  source: SyntaxNode | null,
  kind: ImportEdge["kind"],
  typeOnly: boolean,
  inAmbientModule: boolean,
): ImportLiteral[] {
  const specifier = stringValue(source);
  if (source === null || specifier === null || specifier === "") return [];
  if (inAmbientModule && isRelativeName(specifier)) return [];
  return [{ specifier, kind, typeOnly, start: source.start }];
}

function declarationLiterals(
  statement: SyntaxNode,
  kind: ImportEdge["kind"],
  typeField: string,
  inAmbientModule: boolean,
): ImportLiteral[] {
  const typeOnly = field(statement, typeField) === "type";
  return literalOf(nodeField(statement, "source"), kind, typeOnly, inAmbientModule);
}

function importEqualsLiterals(statement: SyntaxNode, inAmbientModule: boolean): ImportLiteral[] {
  const reference = nodeField(statement, "moduleReference");
  if (reference?.type !== "TSExternalModuleReference") return [];
  return literalOf(nodeField(reference, "expression"), "static", false, inAmbientModule);
}

// `declare module "x" { import … }`: TypeScript records the specifiers an ambient module's body
// names, relative ones excepted.
function ambientModuleLiterals(statement: SyntaxNode, inAmbientModule: boolean): ImportLiteral[] {
  const id = nodeField(statement, "id");
  const body = nodeField(statement, "body");
  if (id?.type !== "Literal" || body === null) return [];
  if (!inAmbientModule && field(statement, "declare") !== true) return [];
  const inner = field(body, "body");
  if (!Array.isArray(inner)) return [];
  return inner.flatMap((s) => statementLiterals(s as SyntaxNode, true));
}

function statementLiterals(statement: SyntaxNode, inAmbientModule: boolean): ImportLiteral[] {
  switch (statement.type) {
    case "ImportDeclaration":
      return declarationLiterals(statement, "static", "importKind", inAmbientModule);
    case "ExportNamedDeclaration":
    case "ExportAllDeclaration":
      return declarationLiterals(statement, "export-from", "exportKind", inAmbientModule);
    case "TSImportEqualsDeclaration":
      return importEqualsLiterals(statement, inAmbientModule);
    case "TSModuleDeclaration":
      return ambientModuleLiterals(statement, inAmbientModule);
    default:
      return [];
  }
}

function expressionLiterals(syntax: SyntaxFile): ImportLiteral[] {
  const out: ImportLiteral[] = [];
  const visit = (node: SyntaxNode): void => {
    if (node.type === "ImportExpression") {
      out.push(...literalOf(nodeField(node, "source"), "dynamic", false, false));
    } else if (node.type === "TSImportType") {
      out.push(...literalOf(nodeField(node, "source"), "static", false, false));
    }
    for (const child of syntax.children(node)) visit(child);
  };
  visit(syntax.program);
  return out;
}

// Every module specifier TypeScript records in `SourceFile.imports`, classified the way the edge
// pass always classified them: an `import` declaration is static, `export … from` is export-from,
// `import()` is dynamic, and anything else (`import x = require()`, `typeof import()`) is static.
export function importLiterals(syntax: SyntaxFile): ImportLiteral[] {
  const statements = syntax.program.body.flatMap((s) => statementLiterals(s as SyntaxNode, false));
  return [...statements, ...expressionLiterals(syntax)];
}

export function importDeclarationSpecifiers(syntax: SyntaxFile): string[] {
  const values = new Set<string>();
  for (const statement of syntax.program.body) {
    if (statement.type === "ImportDeclaration") values.add(statement.source.value);
  }
  return [...values].sort((a, b) => a.localeCompare(b));
}

export type ImportGraph = {
  readonly importsByFile: Map<string, string[]>;
  readonly importedByFile: Map<string, string[]>;
  readonly importEdgesByFile: Map<string, ImportEdge[]>;
};

function dedupSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function dedupImportEdges(edges: ImportEdge[]): ImportEdge[] {
  const seen = new Set<string>();
  const out: ImportEdge[] = [];
  for (const e of edges) {
    const key = `${e.specifier} ${e.kind} ${e.typeOnly}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  out.sort(
    (a, b) =>
      a.specifier.localeCompare(b.specifier) ||
      a.kind.localeCompare(b.kind) ||
      Number(a.typeOnly) - Number(b.typeOnly),
  );
  return out;
}

const MODULE_STATEMENTS = new Set([
  "ImportDeclaration",
  "ExportNamedDeclaration",
  "ExportDefaultDeclaration",
  "ExportAllDeclaration",
  "TSExportAssignment",
]);

function usesImportMeta(syntax: SyntaxFile, node: SyntaxNode): boolean {
  if (node.type === "MetaProperty" && field(nodeField(node, "meta") ?? node, "name") === "import") {
    return true;
  }
  return syntax.children(node).some((child) => usesImportMeta(syntax, child));
}

// TypeScript gives a module specifier a symbol only when the file it names is a module; a script
// resolves on disk and still carries no edge.
function isExternalModule(syntax: SyntaxFile): boolean {
  for (const statement of syntax.program.body) {
    if (MODULE_STATEMENTS.has(statement.type)) return true;
    if (
      statement.type === "TSImportEqualsDeclaration" &&
      statement.moduleReference.type === "TSExternalModuleReference"
    ) {
      return true;
    }
  }
  return usesImportMeta(syntax, syntax.program);
}

function realPath(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

// Resolves every import literal under the one tsconfig the edge pass reads, keeping a target only
// when it lands in the loaded file set — the same module edge set the ts-morph edge program gave.
export function resolveImports(
  rootAbsolute: string,
  sourceFiles: readonly SourceUnit[],
  tsConfigPath: string,
): ImportGraph {
  const resolve = createModuleResolver(tsConfigPath);
  const rootReal = realPath(rootAbsolute);
  const units = new Map(sourceFiles.map((unit) => [unit.file, unit]));
  const fileSet = new Set(units.keys());
  const modules = new Map<string, boolean>();
  const isModuleFile = (file: string): boolean => {
    const known = modules.get(file);
    if (known !== undefined) return known;
    const unit = units.get(file);
    const answer = unit !== undefined && isExternalModule(unit.syntax);
    modules.set(file, answer);
    return answer;
  };
  const inScope = (resolved: string): string | null => {
    const direct = toRelative(rootAbsolute, resolved);
    const file = fileSet.has(direct) ? direct : toRelative(rootReal, realPath(resolved));
    return fileSet.has(file) && isModuleFile(file) ? file : null;
  };

  const importsByFile = new Map<string, string[]>();
  const importEdgesByFile = new Map<string, ImportEdge[]>();
  const importedAccum = new Map<string, string[]>();
  for (const f of fileSet) importedAccum.set(f, []);

  for (const unit of sourceFiles) {
    const edges: ImportEdge[] = [];
    for (const literal of importLiterals(unit.syntax)) {
      const resolved = resolve(unit.absolutePath, literal.specifier);
      const target = resolved === null ? null : inScope(resolved);
      edges.push({
        specifier: literal.specifier,
        kind: literal.kind,
        typeOnly: literal.typeOnly,
        target,
      });
      if (target !== null) importedAccum.get(target)?.push(unit.file);
    }
    importsByFile.set(unit.file, dedupSorted(edges.map((e) => e.specifier)));
    importEdgesByFile.set(unit.file, dedupImportEdges(edges));
  }

  const importedByFile = new Map<string, string[]>();
  for (const f of fileSet) importedByFile.set(f, dedupSorted(importedAccum.get(f) ?? []));
  return { importsByFile, importedByFile, importEdgesByFile };
}
