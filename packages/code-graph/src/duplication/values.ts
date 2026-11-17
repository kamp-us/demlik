import type { SourceUnit } from "../extract/project.js";
import { field, nodeField, type SyntaxNode } from "../syntax/file.js";

export type ArgumentValue = {
  value: string;
  kind: "name" | "literal";
  index: number;
  line: number;
  column: number;
};

const WRAPPERS = new Set([
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "ChainExpression",
]);

const REFERENCE_READERS: ReadonlyMap<string, (node: SyntaxNode) => string> = new Map([
  ["Identifier", (node) => String(field(node, "name"))],
  ["ThisExpression", () => "this"],
  ["Super", () => "super"],
]);

export function referenceName(node: SyntaxNode): string | null {
  const read = REFERENCE_READERS.get(node.type);
  if (read !== undefined) return read(node);
  if (WRAPPERS.has(node.type)) {
    const expression = nodeField(node, "expression");
    return expression === null ? null : referenceName(expression);
  }
  if (node.type !== "MemberExpression" || field(node, "computed") === true) return null;
  const object = nodeField(node, "object");
  const property = nodeField(node, "property");
  const base = object === null ? null : referenceName(object);
  return base === null || property?.type !== "Identifier"
    ? null
    : `${base}.${String(field(property, "name"))}`;
}

export function argumentsOf(node: SyntaxNode): readonly SyntaxNode[] {
  const args = field(node, "arguments");
  return Array.isArray(args) ? args : [];
}

type ValueContext = {
  unit: SourceUnit;
  add: (node: SyntaxNode, value: string, kind: ArgumentValue["kind"], index: number) => void;
  read: (node: SyntaxNode, index: number) => void;
};
type ValueReader = (node: SyntaxNode, index: number, context: ValueContext) => void;

const readExpression: ValueReader = (node, index, context) => {
  const expression = nodeField(node, "expression");
  if (expression !== null) context.read(expression, index);
};
const readArguments: ValueReader = (node, index, context) => {
  for (const argument of argumentsOf(node)) context.read(argument, index);
};
const readChildren: ValueReader = (node, index, context) => {
  for (const child of context.unit.syntax.children(node)) context.read(child, index);
};
const readProperty: ValueReader = (node, index, context) => {
  if (field(node, "kind") !== "init" || field(node, "method") === true) return;
  const value = nodeField(node, "value");
  if (value !== null) context.read(value, index);
};
const readLiteral: ValueReader = (node, index, context) => {
  const value = field(node, "value");
  if (typeof value === "string" || typeof value === "number") {
    context.add(node, JSON.stringify(value), "literal", index);
  }
};

const VALUE_READERS: ReadonlyMap<string, ValueReader> = new Map([
  ...[...WRAPPERS].map((kind): [string, ValueReader] => [kind, readExpression]),
  ["Literal", readLiteral],
  ["Property", readProperty],
  ["CallExpression", readArguments],
  ["NewExpression", readArguments],
  ["ObjectExpression", readChildren],
  ["ArrayExpression", readChildren],
]);

export function argumentValues(unit: SourceUnit, call: SyntaxNode): ArgumentValue[] {
  const out: ArgumentValue[] = [];
  const add = (node: SyntaxNode, value: string, kind: ArgumentValue["kind"], index: number) => {
    const line = unit.syntax.lineOf(node.start);
    out.push({
      value,
      kind,
      index,
      line,
      column: unit.syntax.startColumn(node),
    });
  };
  const read = (node: SyntaxNode, index: number): void => {
    const name = referenceName(node);
    if (name !== null) {
      add(node, name, "name", index);
      return;
    }
    VALUE_READERS.get(node.type)?.(node, index, context);
  };
  const context: ValueContext = { unit, add, read };
  argumentsOf(call).forEach(read);
  return out;
}
