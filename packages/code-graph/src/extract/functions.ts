import type { FunctionKind } from "../schema.js";
import {
  field,
  isAccessorKind,
  isMethodValue,
  nodeField,
  type SyntaxFile,
  type SyntaxNode,
} from "../syntax/file.js";
import type { SourceUnit } from "./project.js";

export type DiscoveredFunction = {
  node: SyntaxNode;
  unit: SourceUnit;
  id: string;
  name: string;
  kind: FunctionKind;
  file: string;
  startLine: number;
  endLine: number;
  isExported: boolean;
  isTest: boolean;
};

export type FunctionDiscovery = {
  functions: DiscoveredFunction[];
};

const TEST_FILE = /\.(test|spec)\.tsx?$/;

export function isTestFile(file: string): boolean {
  return TEST_FILE.test(file);
}

// The text TypeScript's `getName()` reports for a member or binding name: a string key keeps its
// quotes, a private one its `#`, a computed one its brackets.
export function nameText(syntax: SyntaxFile, holder: SyntaxNode, key: SyntaxNode): string {
  if (field(holder, "computed") === true) {
    const open = syntax.text.lastIndexOf("[", key.start);
    const close = syntax.text.indexOf("]", key.end);
    return syntax.text.slice(open, close + 1);
  }
  if (key.type === "Identifier") return String(field(key, "name"));
  return syntax.textOf(key);
}

export function bindingNameText(syntax: SyntaxFile, id: SyntaxNode): string {
  if (id.type === "Identifier") return String(field(id, "name"));
  const annotation = nodeField(id, "typeAnnotation");
  const end = annotation === null ? id.end : annotation.start;
  return syntax.text.slice(id.start, end).trimEnd();
}

const CLASS_FIELDS = new Set([
  "PropertyDefinition",
  "TSAbstractPropertyDefinition",
  "AccessorProperty",
  "TSAbstractAccessorProperty",
]);

export function isPropertyAssignment(node: SyntaxNode, parent: SyntaxNode | undefined): boolean {
  return (
    node.type === "Property" &&
    parent?.type === "ObjectExpression" &&
    field(node, "kind") === "init" &&
    field(node, "method") !== true &&
    field(node, "shorthand") !== true
  );
}

export function isClassField(node: SyntaxNode): boolean {
  return CLASS_FIELDS.has(node.type);
}

function nameFromBinding(syntax: SyntaxFile, node: SyntaxNode): string | null {
  const parent = syntax.parentOf(node);
  if (parent === undefined) return null;
  if (parent.type === "VariableDeclarator") {
    const id = nodeField(parent, "id");
    return id === null ? null : bindingNameText(syntax, id);
  }
  if (isPropertyAssignment(parent, syntax.parentOf(parent)) || isClassField(parent)) {
    const key = nodeField(parent, "key");
    return key === null ? null : nameText(syntax, parent, key);
  }
  if (parent.type === "ExportDefaultDeclaration" || parent.type === "TSExportAssignment") {
    return "default";
  }
  return null;
}

type Classified = { kind: FunctionKind; name: string };

function memberName(syntax: SyntaxFile, member: SyntaxNode): string {
  const key = nodeField(member, "key");
  return key === null ? "" : nameText(syntax, member, key);
}

function classifyMember(syntax: SyntaxFile, member: SyntaxNode): Classified | null {
  switch (field(member, "kind")) {
    case "constructor":
      return { kind: "constructor", name: "constructor" };
    case "get":
      return { kind: "getter", name: memberName(syntax, member) };
    case "set":
      return { kind: "setter", name: memberName(syntax, member) };
    default: {
      const value = nodeField(member, "value");
      if (value?.type !== "FunctionExpression") return null;
      return { kind: "method", name: memberName(syntax, member) };
    }
  }
}

function classifyFunctionDeclaration(syntax: SyntaxFile, node: SyntaxNode): Classified | null {
  if (nodeField(node, "body") === null) return null;
  const id = nodeField(node, "id");
  if (id !== null) return { kind: "function", name: String(field(id, "name")) };
  return syntax.parentOf(node)?.type === "ExportDefaultDeclaration"
    ? { kind: "function", name: "default" }
    : null;
}

function classifyObjectMember(syntax: SyntaxFile, node: SyntaxNode): Classified | null {
  if (syntax.parentOf(node)?.type !== "ObjectExpression") return null;
  if (field(node, "method") !== true && !isAccessorKind(node)) return null;
  return classifyMember(syntax, node);
}

function classifyArrow(syntax: SyntaxFile, node: SyntaxNode): Classified | null {
  const name = nameFromBinding(syntax, node);
  return name === null ? null : { kind: "arrow", name };
}

function classifyFunctionExpression(syntax: SyntaxFile, node: SyntaxNode): Classified | null {
  if (isMethodValue(node, syntax.parentOf(node))) return null;
  const id = nodeField(node, "id");
  const name = id === null ? nameFromBinding(syntax, node) : String(field(id, "name"));
  return name === null ? null : { kind: "function-expression", name };
}

function classifySignature(syntax: SyntaxFile, node: SyntaxNode): Classified | null {
  return isAccessorKind(node) ? classifyMember(syntax, node) : null;
}

type Classifier = (syntax: SyntaxFile, node: SyntaxNode) => Classified | null;

// The ESTree node types that are a callable TypeScript names: `TSMethodSignature` for an
// interface's `get`/`set`, which TypeScript parses as accessors.
const CLASSIFIERS: ReadonlyMap<string, Classifier> = new Map<string, Classifier>([
  ["FunctionDeclaration", classifyFunctionDeclaration],
  ["MethodDefinition", classifyMember],
  ["TSAbstractMethodDefinition", classifyMember],
  ["Property", classifyObjectMember],
  ["TSMethodSignature", classifySignature],
  ["ArrowFunctionExpression", classifyArrow],
  ["FunctionExpression", classifyFunctionExpression],
]);

function classify(syntax: SyntaxFile, node: SyntaxNode): Classified | null {
  return CLASSIFIERS.get(node.type)?.(syntax, node) ?? null;
}

function identifierName(node: SyntaxNode | null | undefined): string | null {
  return node?.type === "Identifier" ? String(field(node, "name")) : null;
}

function namedExportNames(statement: SyntaxNode): string[] {
  const names: string[] = [];
  if (nodeField(statement, "source") === null) {
    for (const specifier of field(statement, "specifiers") as SyntaxNode[]) {
      const local = identifierName(nodeField(specifier, "local"));
      if (local !== null) names.push(local);
    }
  }
  const declaration = nodeField(statement, "declaration");
  const declared = declaration === null ? null : identifierName(nodeField(declaration, "id"));
  if (declared !== null) names.push(declared);
  return names;
}

function exportNamesOf(statement: SyntaxNode): string[] {
  switch (statement.type) {
    case "ExportNamedDeclaration":
      return namedExportNames(statement);
    case "ExportDefaultDeclaration":
      return [identifierName(nodeField(statement, "declaration"))].filter((n) => n !== null);
    case "TSExportAssignment":
      return [identifierName(nodeField(statement, "expression"))].filter((n) => n !== null);
    default:
      return [];
  }
}

// The names a module exports from its own top level: `export { f }`, `export default f`,
// `export = f`, and the declarations a function's symbol can merge with. TypeScript's
// `isExported()` answers from the module symbol's exports, and these are the ones a top-level
// function declaration can be reached through.
function exportedLocalNames(syntax: SyntaxFile): ReadonlySet<string> {
  return new Set(syntax.program.body.flatMap((statement) => exportNamesOf(statement)));
}

function isExportWrapped(syntax: SyntaxFile, node: SyntaxNode): boolean {
  const parent = syntax.parentOf(node);
  return parent?.type === "ExportNamedDeclaration" || parent?.type === "ExportDefaultDeclaration";
}

function functionIsExported(
  syntax: SyntaxFile,
  node: SyntaxNode,
  exported: () => ReadonlySet<string>,
): boolean {
  if (isExportWrapped(syntax, node)) return true;
  if (syntax.parentOf(node)?.type !== "Program") return false;
  const id = nodeField(node, "id");
  return id !== null && exported().has(String(field(id, "name")));
}

function expressionIsExported(syntax: SyntaxFile, node: SyntaxNode): boolean {
  const parent = syntax.parentOf(node);
  if (parent === undefined) return false;
  if (parent.type === "ExportDefaultDeclaration" || parent.type === "TSExportAssignment") {
    return true;
  }
  if (parent.type !== "VariableDeclarator") return false;
  const statement = syntax.parentOf(parent);
  return statement?.type === "VariableDeclaration" && isExportWrapped(syntax, statement);
}

function callableIsExported(
  syntax: SyntaxFile,
  node: SyntaxNode,
  kind: FunctionKind,
  exported: () => ReadonlySet<string>,
): boolean {
  if (kind === "arrow" || kind === "function-expression") return expressionIsExported(syntax, node);
  if (kind === "function") return functionIsExported(syntax, node, exported);
  return false;
}

function discoverInFile(unit: SourceUnit): DiscoveredFunction[] {
  const { syntax, file } = unit;
  const isTest = isTestFile(file);

  const raw: { node: SyntaxNode; name: string; kind: FunctionKind }[] = [];
  const visit = (node: SyntaxNode): void => {
    const c = classify(syntax, node);
    if (c) raw.push({ node, name: c.name, kind: c.kind });
    for (const child of syntax.children(node)) visit(child);
  };
  for (const child of syntax.children(syntax.program)) visit(child);

  let exportedNames: ReadonlySet<string> | null = null;
  const exported = (): ReadonlySet<string> => {
    exportedNames ??= exportedLocalNames(syntax);
    return exportedNames;
  };

  const baseIdCounts = new Map<string, number>();
  for (const r of raw)
    baseIdCounts.set(`${file}:${r.name}`, (baseIdCounts.get(`${file}:${r.name}`) ?? 0) + 1);
  const ordinalSeen = new Map<string, number>();

  const out: DiscoveredFunction[] = [];
  for (const r of raw) {
    const base = `${file}:${r.name}`;
    let id = base;
    if ((baseIdCounts.get(base) ?? 0) > 1) {
      const ord = ordinalSeen.get(base) ?? 0;
      ordinalSeen.set(base, ord + 1);
      id = `${base}#${ord}`;
    }
    out.push({
      node: r.node,
      unit,
      id,
      name: r.name,
      kind: r.kind,
      file,
      startLine: syntax.startLine(r.node),
      endLine: syntax.endLine(r.node),
      isExported: callableIsExported(syntax, r.node, r.kind, exported),
      isTest,
    });
  }
  return out;
}

export function discoverFunctions(sourceFiles: readonly SourceUnit[]): FunctionDiscovery {
  const functions: DiscoveredFunction[] = [];
  for (const unit of sourceFiles) functions.push(...discoverInFile(unit));
  functions.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.startLine - b.startLine ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );
  return { functions };
}
