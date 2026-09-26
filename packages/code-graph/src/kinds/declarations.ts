import type { TypeContext } from "../checker/context.js";
import * as ts from "../engine/tsgo.js";
import { type CompiledRule, matchingRules } from "./rules.js";

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const modifiers = (node as { modifiers?: readonly ts.Node[] }).modifiers;
  return modifiers?.some((m) => m.kind === kind) ?? false;
}

function baseClassName(ctx: TypeContext, method: ts.MethodDeclaration): string | null {
  const owner = method.parent;
  if (!ts.isClassDeclaration(owner) && !ts.isClassExpression(owner)) return null;
  const heritage = owner.heritageClauses
    ?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)
    ?.types.at(0);
  if (heritage === undefined) return null;
  const text = ctx.text(heritage.expression);
  return text.slice(text.lastIndexOf(".") + 1);
}

function isPublicInstanceMethod(method: ts.MethodDeclaration): boolean {
  return (
    !hasModifier(method, ts.SyntaxKind.StaticKeyword) &&
    !hasModifier(method, ts.SyntaxKind.PrivateKeyword) &&
    !hasModifier(method, ts.SyntaxKind.ProtectedKeyword) &&
    !ts.isPrivateIdentifier(method.name)
  );
}

export function publicMethodRulesByBaseClass(
  ctx: TypeContext,
  rules: readonly CompiledRule[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [node, id] of ctx.nodeToId) {
    if (!ts.isMethodDeclaration(node) || !isPublicInstanceMethod(node)) continue;
    const base = baseClassName(ctx, node);
    if (base === null) continue;
    const keys = matchingRules(rules, base);
    if (keys.length > 0) out.set(id, keys);
  }
  return out;
}

function owningObjectLiteral(node: ts.Node): ts.ObjectLiteralExpression | null {
  const parent = node.parent;
  if (ts.isMethodDeclaration(node) && ts.isObjectLiteralExpression(parent)) return parent;
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return null;
  if (!ts.isPropertyAssignment(parent)) return null;
  const owner = parent.parent;
  return ts.isObjectLiteralExpression(owner) ? owner : null;
}

function siblingPropertyNames(ctx: TypeContext, literal: ts.ObjectLiteralExpression): string[] {
  const names: string[] = [];
  for (const property of literal.properties) {
    if (
      ts.isPropertyAssignment(property) ||
      ts.isShorthandPropertyAssignment(property) ||
      ts.isMethodDeclaration(property)
    ) {
      names.push(ctx.text(property.name));
    }
  }
  return names;
}

function guardKeys(
  ctx: TypeContext,
  literal: ts.ObjectLiteralExpression,
  rules: readonly CompiledRule[],
): string[] {
  return [
    ...new Set(siblingPropertyNames(ctx, literal).flatMap((name) => matchingRules(rules, name))),
  ].sort((a, b) => a.localeCompare(b));
}

export function siblingPropertyRules(
  ctx: TypeContext,
  rules: readonly CompiledRule[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [node, id] of ctx.nodeToId) {
    const literal = owningObjectLiteral(node);
    if (literal === null) continue;
    const keys = guardKeys(ctx, literal, rules);
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

function propertyNamed(
  ctx: TypeContext,
  literal: ts.ObjectLiteralExpression,
  name: string,
): ts.Node | undefined {
  return literal.properties.find(
    (p) => (ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p)) && ctx.text(p.name) === name,
  );
}

function declarationOf(ctx: TypeContext, expression: ts.Node | undefined): ts.Node | null {
  if (expression === undefined || !ts.isIdentifier(expression)) return null;
  const symbol = ctx.symbolOf(expression);
  if (symbol === undefined) return null;
  return ctx.declarationsOf(ctx.aliasedSymbol(symbol) ?? symbol)[0] ?? null;
}

function refsDefinedBy(ctx: TypeContext, typeConfig: ts.ObjectLiteralExpression): ts.Node[] {
  const call = typeConfig.parent;
  if (!ts.isCallExpression(call)) return [];
  const callee = call.expression;
  if (ts.isPropertyAccessExpression(callee) && ctx.text(callee.name) === "implement") {
    const ref = declarationOf(ctx, callee.expression);
    return ref === null ? [] : [ref];
  }
  const refs: ts.Node[] = [];
  const named = declarationOf(ctx, call.arguments[0]);
  if (named !== null) refs.push(named);
  const owner = call.parent;
  if (ts.isVariableDeclaration(owner)) refs.push(owner);
  return refs;
}

function typeConfigOwning(
  ctx: TypeContext,
  fieldsProperty: ts.Node,
): ts.ObjectLiteralExpression | null {
  if (!ts.isPropertyAssignment(fieldsProperty) && !ts.isMethodDeclaration(fieldsProperty)) {
    return null;
  }
  if (ctx.text(fieldsProperty.name) !== "fields") return null;
  const literal = fieldsProperty.parent;
  return ts.isObjectLiteralExpression(literal) ? literal : null;
}

function objectLiteralsIn(source: ts.SourceFile): ts.ObjectLiteralExpression[] {
  const out: ts.ObjectLiteralExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) out.push(node);
    node.forEachChild(visit);
  };
  source.forEachChild(visit);
  return out;
}

function scopedTypeRefs(ctx: TypeContext, rules: readonly CompiledRule[]): Map<ts.Node, string[]> {
  const scoped = new Map<ts.Node, string[]>();
  const files = new Set([...ctx.nodeToId.keys()].map((node) => node.getSourceFile()));
  for (const file of files) {
    for (const literal of objectLiteralsIn(file)) {
      if (propertyNamed(ctx, literal, "fields") === undefined) continue;
      const keys = guardKeys(ctx, literal, rules);
      if (keys.length === 0) continue;
      for (const ref of refsDefinedBy(ctx, literal)) scoped.set(ref, keys);
    }
  }
  return scoped;
}

function skipsTypeScopes(ctx: TypeContext, node: ts.Node): boolean {
  const literal = owningObjectLiteral(node);
  if (literal === null) return false;
  const skip = propertyNamed(ctx, literal, "skipTypeScopes");
  return (
    skip !== undefined &&
    ts.isPropertyAssignment(skip) &&
    skip.initializer.kind === ts.SyntaxKind.TrueKeyword
  );
}

function typeGuardOf(
  ctx: TypeContext,
  node: ts.Node,
  scoped: ReadonlyMap<ts.Node, string[]>,
  rules: readonly CompiledRule[],
): string[] {
  for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) {
    const typeConfig = typeConfigOwning(ctx, ancestor);
    if (typeConfig !== null) return guardKeys(ctx, typeConfig, rules);
    if (!ts.isCallExpression(ancestor)) continue;
    const callee = ancestor.expression;
    if (!ts.isPropertyAccessExpression(callee)) continue;
    if (!TYPE_FIELD_ATTACHERS.has(ctx.text(callee.name))) continue;
    const ref = declarationOf(ctx, ancestor.arguments[0]);
    return ref === null ? [] : (scoped.get(ref) ?? []);
  }
  return [];
}

export function typeScopeRules(
  ctx: TypeContext,
  rules: readonly CompiledRule[],
): Map<string, string[]> {
  const scoped = scopedTypeRefs(ctx, rules);
  const out = new Map<string, string[]>();
  for (const [node, id] of ctx.nodeToId) {
    if (skipsTypeScopes(ctx, node)) continue;
    const keys = typeGuardOf(ctx, node, scoped, rules);
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
