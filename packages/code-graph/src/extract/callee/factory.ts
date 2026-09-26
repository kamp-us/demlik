import type { TypeContext } from "../../checker/context.js";
import * as ts from "../../engine/tsgo.js";

type Factory = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

type ForwardedMember = { readonly parameter: number; readonly member: string };

function declarationOf(ctx: TypeContext, expression: ts.Node): ts.Node | undefined {
  const symbol = ctx.symbolOf(expression);
  if (symbol === undefined) return undefined;
  return ctx.declarationsOf(ctx.aliasedSymbol(symbol) ?? symbol)[0];
}

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node)
  );
}

// ts-morph's `FunctionDeclaration.getImplementation()`: an overload signature's implementation is
// the same-named declaration with a body among its siblings.
function implementationOf(decl: ts.FunctionDeclaration): ts.FunctionDeclaration | undefined {
  if (decl.body !== undefined) return decl;
  const name = decl.name?.text;
  if (name === undefined) return undefined;
  let found: ts.FunctionDeclaration | undefined;
  decl.parent.forEachChild((sibling) => {
    if (found === undefined && ts.isFunctionDeclaration(sibling)) {
      if (sibling.name?.text === name && sibling.body !== undefined) found = sibling;
    }
    return undefined;
  });
  return found;
}

function factoryOf(decl: ts.Node | undefined): Factory | undefined {
  if (decl === undefined) return undefined;
  if (ts.isFunctionDeclaration(decl)) return implementationOf(decl) ?? decl;
  if (!ts.isVariableDeclaration(decl)) return undefined;
  const initializer = decl.initializer;
  return initializer !== undefined &&
    (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
    ? initializer
    : undefined;
}

function returnedFunctions(factory: Factory): ts.Node[] {
  const body = factory.body;
  if (body === undefined) return [];
  if (ts.isArrowFunction(body) || ts.isFunctionExpression(body)) return [body];
  const out: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) {
      const returned = node.expression;
      if (
        returned !== undefined &&
        (ts.isArrowFunction(returned) || ts.isFunctionExpression(returned))
      ) {
        out.push(returned);
      }
    }
    node.forEachChild(visit);
  };
  body.forEachChild(visit);
  return out;
}

function callsWithin(node: ts.Node): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const visit = (child: ts.Node): void => {
    if (ts.isCallExpression(child)) out.push(child);
    child.forEachChild(visit);
  };
  node.forEachChild(visit);
  return out;
}

function forwardedMembers(ctx: TypeContext, factory: Factory): ForwardedMember[] {
  const parameters = factory.parameters.map((p) => p.name);
  const out: ForwardedMember[] = [];
  for (const returned of returnedFunctions(factory)) {
    for (const call of callsWithin(returned)) {
      const callee = call.expression;
      if (!ts.isPropertyAccessExpression(callee)) continue;
      const receiver = declarationOf(ctx, callee.expression);
      const parameter = parameters.findIndex((name) => name.parent === receiver);
      if (parameter !== -1) out.push({ parameter, member: ctx.text(callee.name) });
    }
  }
  return out;
}

function propertyName(ctx: TypeContext, property: ts.Node): string | undefined {
  const name = (property as { name?: ts.Node }).name;
  return name === undefined ? undefined : ctx.text(name);
}

function memberImplementation(
  ctx: TypeContext,
  config: ts.Node | undefined,
  member: string,
): ts.Node | undefined {
  if (config === undefined || !ts.isObjectLiteralExpression(config)) return undefined;
  const property = config.properties.find((p) => propertyName(ctx, p) === member);
  if (property === undefined) return undefined;
  if (ts.isMethodDeclaration(property)) return property;
  return ts.isPropertyAssignment(property) ? property.initializer : undefined;
}

export type FactoryResolver = (callExpr: ts.CallExpression) => string[];

export function createFactoryResolver(ctx: TypeContext): FactoryResolver {
  const membersByFactory = new Map<Factory, ForwardedMember[]>();
  const membersOf = (factory: Factory): ForwardedMember[] => {
    const cached = membersByFactory.get(factory);
    if (cached !== undefined) return cached;
    const members = forwardedMembers(ctx, factory);
    membersByFactory.set(factory, members);
    return members;
  };

  return (callExpr) => {
    const produced = declarationOf(ctx, callExpr.expression);
    if (produced === undefined || !ts.isVariableDeclaration(produced)) return [];
    const construction = produced.initializer;
    if (construction === undefined || !ts.isCallExpression(construction)) return [];
    const factory = factoryOf(declarationOf(ctx, construction.expression));
    if (factory === undefined) return [];
    const ids = new Set<string>();
    for (const { parameter, member } of membersOf(factory)) {
      const implementation = memberImplementation(ctx, construction.arguments[parameter], member);
      const id = implementation === undefined ? undefined : ctx.nodeToId.get(implementation);
      if (id !== undefined) ids.add(id);
    }
    return [...ids].sort((a, b) => a.localeCompare(b));
  };
}
