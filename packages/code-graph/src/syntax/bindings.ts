import { field, nodeField, type SyntaxFile, type SyntaxNode } from "./file.js";

// Every local a binding pattern introduces: `db`, `db = x`, `...db`, `{ db }`, `[db]`, and a
// TypeScript parameter property's `private db`.
export function patternNames(pattern: SyntaxNode | null): string[] {
  if (pattern === null) return [];
  switch (pattern.type) {
    case "Identifier":
      return [String(field(pattern, "name"))];
    case "AssignmentPattern":
      return patternNames(nodeField(pattern, "left"));
    case "RestElement":
      return patternNames(nodeField(pattern, "argument"));
    case "TSParameterProperty":
      return patternNames(nodeField(pattern, "parameter"));
    case "Property":
      return patternNames(nodeField(pattern, "value"));
    case "ObjectPattern":
      return (field(pattern, "properties") as SyntaxNode[]).flatMap(patternNames);
    case "ArrayPattern":
      return (field(pattern, "elements") as (SyntaxNode | null)[]).flatMap(patternNames);
    default:
      return [];
  }
}

// TypeScript's type-only nodes hold no runtime reference. These host code, so they are read: an
// assertion's operand, a namespace's body, `export = expr`.
const TS_CODE = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
  "TSParameterProperty",
  "TSModuleDeclaration",
  "TSModuleBlock",
  "TSExportAssignment",
]);

// The children of a node that can hold a runtime reference: every child but a type position.
export function codeChildren(syntax: SyntaxFile, node: SyntaxNode): SyntaxNode[] {
  return syntax.children(node).filter((c) => !c.type.startsWith("TS") || TS_CODE.has(c.type));
}

function declaredNames(node: SyntaxNode): string[] {
  if (field(node, "declare") === true) return [];
  return (field(node, "declarations") as SyntaxNode[]).flatMap((d) =>
    patternNames(nodeField(d, "id")),
  );
}

function functionNames(node: SyntaxNode): string[] {
  return [
    ...patternNames(nodeField(node, "id")),
    ...(field(node, "params") as SyntaxNode[]).flatMap(patternNames),
  ];
}

const namedBy = (key: string) => (node: SyntaxNode) => patternNames(nodeField(node, key));

// The nodes that bind names, and the names each one binds.
const BINDERS: ReadonlyMap<string, (node: SyntaxNode) => string[]> = new Map([
  ["VariableDeclaration", declaredNames],
  ["FunctionDeclaration", functionNames],
  ["FunctionExpression", functionNames],
  ["ArrowFunctionExpression", functionNames],
  ["ClassDeclaration", namedBy("id")],
  ["ClassExpression", namedBy("id")],
  ["CatchClause", namedBy("param")],
  ["ImportSpecifier", namedBy("local")],
  ["ImportDefaultSpecifier", namedBy("local")],
  ["ImportNamespaceSpecifier", namedBy("local")],
]);

function bindingsOf(node: SyntaxNode): string[] {
  return BINDERS.get(node.type)?.(node) ?? [];
}

// Every name the file binds anywhere, and how many times: an import, a declaration, a parameter, a
// catch clause. A `declare` binds nothing: it types the real global. The count is per file, not per
// scope, so a name bound twice anywhere reads as bound twice everywhere.
export function bindingCounts(syntax: SyntaxFile): Map<string, number> {
  const counts = new Map<string, number>();
  const visit = (node: SyntaxNode): void => {
    for (const name of bindingsOf(node)) counts.set(name, (counts.get(name) ?? 0) + 1);
    for (const child of codeChildren(syntax, node)) visit(child);
  };
  visit(syntax.program);
  return counts;
}

// Identifier slots that name something rather than read it: `a.b`'s `b`, `{ b: 1 }`'s `b`, a
// label, an export's name. A computed key is an expression and is read.
const COMPUTABLE_NAME = new Map([
  ["MemberExpression", "property"],
  ["Property", "key"],
  ["MethodDefinition", "key"],
  ["PropertyDefinition", "key"],
  ["AccessorProperty", "key"],
]);

const PLAIN_NAMES = new Map([
  ["LabeledStatement", ["label"]],
  ["BreakStatement", ["label"]],
  ["ContinueStatement", ["label"]],
  ["MetaProperty", ["meta", "property"]],
  ["ExportSpecifier", ["local", "exported"]],
  ["ExportAllDeclaration", ["exported"]],
  ["ImportAttribute", ["key"]],
  ["TSModuleDeclaration", ["id"]],
]);

// Whether `node` sits in a slot of `parent` that names something instead of reading it.
export function isNameSlot(node: SyntaxNode, parent: SyntaxNode | undefined): boolean {
  if (parent === undefined) return false;
  const computable = COMPUTABLE_NAME.get(parent.type);
  if (computable !== undefined && nodeField(parent, computable) === node) {
    return field(parent, "computed") !== true;
  }
  return PLAIN_NAMES.get(parent.type)?.some((key) => nodeField(parent, key) === node) ?? false;
}
