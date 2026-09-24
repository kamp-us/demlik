import {
  type MethodDeclaration,
  Node,
  type ObjectLiteralExpression,
  Scope,
  SyntaxKind,
} from "ts-morph";
import { type CompiledRule, matchingRules } from "./rules.js";

function baseClassName(method: MethodDeclaration): string | null {
  const owner = method.getParent();
  if (!Node.isClassDeclaration(owner) && !Node.isClassExpression(owner)) return null;
  const heritage = owner.getExtends();
  if (heritage === undefined) return null;
  const text = heritage.getExpression().getText();
  return text.slice(text.lastIndexOf(".") + 1);
}

function isPublicInstanceMethod(method: MethodDeclaration): boolean {
  return (
    !method.isStatic() &&
    method.getScope() === Scope.Public &&
    !Node.isPrivateIdentifier(method.getNameNode())
  );
}

export function publicMethodRulesByBaseClass(
  nodeToId: Map<Node, string>,
  rules: readonly CompiledRule[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [node, id] of nodeToId) {
    if (!Node.isMethodDeclaration(node) || !isPublicInstanceMethod(node)) continue;
    const base = baseClassName(node);
    if (base === null) continue;
    const keys = matchingRules(rules, base);
    if (keys.length > 0) out.set(id, keys);
  }
  return out;
}

function owningObjectLiteral(node: Node): ObjectLiteralExpression | null {
  const parent = node.getParent();
  if (Node.isMethodDeclaration(node) && Node.isObjectLiteralExpression(parent)) return parent;
  if (!Node.isArrowFunction(node) && !Node.isFunctionExpression(node)) return null;
  if (!Node.isPropertyAssignment(parent)) return null;
  const owner = parent.getParent();
  return Node.isObjectLiteralExpression(owner) ? owner : null;
}

function siblingPropertyNames(literal: ObjectLiteralExpression): string[] {
  const names: string[] = [];
  for (const property of literal.getProperties()) {
    if (
      Node.isPropertyAssignment(property) ||
      Node.isShorthandPropertyAssignment(property) ||
      Node.isMethodDeclaration(property)
    ) {
      names.push(property.getName());
    }
  }
  return names;
}

function guardKeys(literal: ObjectLiteralExpression, rules: readonly CompiledRule[]): string[] {
  return [
    ...new Set(siblingPropertyNames(literal).flatMap((name) => matchingRules(rules, name))),
  ].sort((a, b) => a.localeCompare(b));
}

export function siblingPropertyRules(
  nodeToId: Map<Node, string>,
  rules: readonly CompiledRule[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [node, id] of nodeToId) {
    const literal = owningObjectLiteral(node);
    if (literal === null) continue;
    const keys = guardKeys(literal, rules);
    if (keys.length > 0) out.set(id, keys);
  }
  return out;
}

const TYPE_FIELD_ATTACHERS: ReadonlySet<string> = new Set([
  "objectField",
  "objectFields",
  "interfaceField",
  "interfaceFields",
]);

function propertyNamed(literal: ObjectLiteralExpression, name: string): Node | undefined {
  return literal
    .getProperties()
    .find(
      (p) => (Node.isPropertyAssignment(p) || Node.isMethodDeclaration(p)) && p.getName() === name,
    );
}

function declarationOf(expression: Node | undefined): Node | null {
  if (expression === undefined || !Node.isIdentifier(expression)) return null;
  const symbol = expression.getSymbol();
  if (symbol === undefined) return null;
  return (symbol.getAliasedSymbol() ?? symbol).getDeclarations()[0] ?? null;
}

function refsDefinedBy(typeConfig: ObjectLiteralExpression): Node[] {
  const call = typeConfig.getParent();
  if (!Node.isCallExpression(call)) return [];
  const callee = call.getExpression();
  if (Node.isPropertyAccessExpression(callee) && callee.getName() === "implement") {
    const ref = declarationOf(callee.getExpression());
    return ref === null ? [] : [ref];
  }
  const refs: Node[] = [];
  const named = declarationOf(call.getArguments()[0]);
  if (named !== null) refs.push(named);
  const owner = call.getParent();
  if (Node.isVariableDeclaration(owner)) refs.push(owner);
  return refs;
}

function typeConfigOwning(fieldsProperty: Node): ObjectLiteralExpression | null {
  if (!Node.isPropertyAssignment(fieldsProperty) && !Node.isMethodDeclaration(fieldsProperty)) {
    return null;
  }
  if (fieldsProperty.getName() !== "fields") return null;
  const literal = fieldsProperty.getParent();
  return Node.isObjectLiteralExpression(literal) ? literal : null;
}

function scopedTypeRefs(
  nodeToId: Map<Node, string>,
  rules: readonly CompiledRule[],
): Map<Node, string[]> {
  const scoped = new Map<Node, string[]>();
  const files = new Set([...nodeToId.keys()].map((node) => node.getSourceFile()));
  for (const file of files) {
    for (const literal of file.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
      if (propertyNamed(literal, "fields") === undefined) continue;
      const keys = guardKeys(literal, rules);
      if (keys.length === 0) continue;
      for (const ref of refsDefinedBy(literal)) scoped.set(ref, keys);
    }
  }
  return scoped;
}

function skipsTypeScopes(node: Node): boolean {
  const literal = owningObjectLiteral(node);
  if (literal === null) return false;
  const skip = propertyNamed(literal, "skipTypeScopes");
  return (
    Node.isPropertyAssignment(skip) && skip.getInitializer()?.getKind() === SyntaxKind.TrueKeyword
  );
}

function typeGuardOf(
  node: Node,
  scoped: ReadonlyMap<Node, string[]>,
  rules: readonly CompiledRule[],
): string[] {
  for (const ancestor of node.getAncestors()) {
    const typeConfig = typeConfigOwning(ancestor);
    if (typeConfig !== null) return guardKeys(typeConfig, rules);
    if (!Node.isCallExpression(ancestor)) continue;
    const callee = ancestor.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) continue;
    if (!TYPE_FIELD_ATTACHERS.has(callee.getName())) continue;
    const ref = declarationOf(ancestor.getArguments()[0]);
    return ref === null ? [] : (scoped.get(ref) ?? []);
  }
  return [];
}

export function typeScopeRules(
  nodeToId: Map<Node, string>,
  rules: readonly CompiledRule[],
): Map<string, string[]> {
  const scoped = scopedTypeRefs(nodeToId, rules);
  const out = new Map<string, string[]>();
  for (const [node, id] of nodeToId) {
    if (skipsTypeScopes(node)) continue;
    const keys = typeGuardOf(node, scoped, rules);
    if (keys.length > 0) out.set(id, keys);
  }
  return out;
}

export function mergeRuleMaps(
  ...maps: ReadonlyArray<ReadonlyMap<string, readonly string[]>>
): Map<string, string[]> {
  const merged = new Map<string, Set<string>>();
  for (const map of maps) {
    for (const [id, keys] of map) {
      const bucket = merged.get(id) ?? new Set<string>();
      for (const key of keys) bucket.add(key);
      merged.set(id, bucket);
    }
  }
  const out = new Map<string, string[]>();
  for (const [id, keys] of merged)
    out.set(
      id,
      [...keys].sort((a, b) => a.localeCompare(b)),
    );
  return out;
}
