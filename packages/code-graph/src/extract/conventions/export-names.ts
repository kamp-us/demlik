import { DEFAULT_EXPORT } from "../../kinds/conventions.js";
import { field, nodeField, type SyntaxFile, type SyntaxNode } from "../../syntax/file.js";
import type { DiscoveredFunction } from "../functions.js";

function moduleExportName(node: SyntaxNode | null): string | null {
  if (node?.type === "Identifier") return String(field(node, "name"));
  if (node?.type === "Literal") return String(field(node, "value"));
  return null;
}

// Local top-level name → the names the module exports it under, from `export { f, g as GET }`
// and `export default f`. Re-exports (`export { x } from "./y"`) export no local binding.
function localExportNames(syntax: SyntaxFile): ReadonlyMap<string, readonly string[]> {
  const names = new Map<string, string[]>();
  const add = (local: string, exported: string): void => {
    const bucket = names.get(local);
    if (bucket === undefined) names.set(local, [exported]);
    else bucket.push(exported);
  };
  for (const statement of syntax.program.body) {
    if (statement.type === "ExportDefaultDeclaration") {
      const declaration = nodeField(statement, "declaration");
      const local = moduleExportName(declaration);
      if (declaration?.type === "Identifier" && local !== null) add(local, DEFAULT_EXPORT);
    } else if (
      statement.type === "ExportNamedDeclaration" &&
      nodeField(statement, "source") === null
    ) {
      for (const specifier of field(statement, "specifiers") as SyntaxNode[]) {
        const local = moduleExportName(nodeField(specifier, "local"));
        const exported = moduleExportName(nodeField(specifier, "exported"));
        if (local !== null && exported !== null) add(local, exported);
      }
    }
  }
  return names;
}

// The export a declaration statement carries on itself, and the top-level name it binds.
function declared(
  syntax: SyntaxFile,
  node: SyntaxNode,
): { direct: string | null; local: string | null } {
  const parent = syntax.parentOf(node);
  if (parent?.type === "ExportDefaultDeclaration") return { direct: DEFAULT_EXPORT, local: null };
  if (node.type === "FunctionDeclaration") {
    const id = moduleExportName(nodeField(node, "id"));
    if (parent?.type === "ExportNamedDeclaration") return { direct: id, local: null };
    return { direct: null, local: parent?.type === "Program" ? id : null };
  }
  if (parent?.type !== "VariableDeclarator") return { direct: null, local: null };
  const id = moduleExportName(nodeField(parent, "id"));
  const statement = syntax.parentOf(parent);
  const holder = statement === undefined ? undefined : syntax.parentOf(statement);
  if (statement?.type !== "VariableDeclaration") return { direct: null, local: null };
  if (holder?.type === "ExportNamedDeclaration") return { direct: id, local: null };
  return { direct: null, local: holder?.type === "Program" ? id : null };
}

// Function id → every name its module exports it under (`default` for the default export),
// sorted. A function no export reaches is absent.
export function exportNamesById(
  functions: readonly DiscoveredFunction[],
): ReadonlyMap<string, readonly string[]> {
  const localsBySyntax = new Map<SyntaxFile, ReadonlyMap<string, readonly string[]>>();
  const out = new Map<string, readonly string[]>();
  for (const fn of functions) {
    const { syntax } = fn.unit;
    const { direct, local } = declared(syntax, fn.node);
    const names = new Set<string>();
    if (direct !== null) names.add(direct);
    if (local !== null) {
      let locals = localsBySyntax.get(syntax);
      if (locals === undefined) {
        locals = localExportNames(syntax);
        localsBySyntax.set(syntax, locals);
      }
      for (const name of locals.get(local) ?? []) names.add(name);
    }
    if (names.size === 0) continue;
    out.set(
      fn.id,
      [...names].sort((a, b) => a.localeCompare(b)),
    );
  }
  return out;
}
