import { field, nodeField, type SyntaxFile, type SyntaxNode } from "../../syntax/file.js";

// What an entry file may hold is named re-exports and nothing else. Anything else is a form the
// ledger spells by one of these labels, and the first one in source order is the entry's whole
// identity: a file that fixes its first form and keeps another is a new entry.
type Form = "export *" | "export default" | "local export" | "import" | "declaration" | "statement";

// The statements that declare a name: a `const`, `function`, `class`, `type`, `interface` or
// `enum`, exported or not.
const DECLARATIONS: ReadonlySet<string> = new Set([
  "VariableDeclaration",
  "FunctionDeclaration",
  "ClassDeclaration",
  "TSTypeAliasDeclaration",
  "TSInterfaceDeclaration",
  "TSEnumDeclaration",
]);

// What a statement is that no named re-export is: `export * from` and `export * as ns from` are a
// namespace and not a named list, a default export is a value, and every other statement is code.
function formOf(statement: SyntaxNode): Form | null {
  switch (statement.type) {
    case "ExportAllDeclaration":
      return "export *";
    case "ExportDefaultDeclaration":
      return "export default";
    case "ExportNamedDeclaration":
      return namedExportForm(statement);
    case "ImportDeclaration":
      return "import";
    default:
      return DECLARATIONS.has(statement.type) ? "declaration" : "statement";
  }
}

// `export const a = 1` holds a declaration, `export { a }` names a local, and `export { a } from`
// is the one clean spelling. It must name its members: `export {} from "m"` names none.
function namedExportForm(statement: SyntaxNode): Form | null {
  const declaration = nodeField(statement, "declaration");
  if (declaration !== null) return formOf(declaration);
  if (nodeField(statement, "source") === null) return "local export";
  const specifiers = field(statement, "specifiers") as readonly unknown[];
  return specifiers.length > 0 ? null : "statement";
}

// The first form in a file that is not a named re-export, or null for a file that holds only those
// (an empty file included).
export function firstOffendingForm(syntax: SyntaxFile): string | null {
  for (const statement of syntax.program.body) {
    const form = formOf(statement as SyntaxNode);
    if (form !== null) return form;
  }
  return null;
}
