import type { TypeContext } from "../../checker/context.js";
import * as ts from "../../engine/tsgo.js";
import type { FactoryResolver } from "./factory.js";

export type ResolvedCallee = { calleeId: string; declaration: string | null };

function externalId(name: string): string {
  return `external:${name}`;
}

export function enclosingId(node: ts.Node, nodeToId: ReadonlyMap<ts.Node, string>): string | null {
  let current: ts.Node | undefined = node;
  while (current) {
    const id = nodeToId.get(current);
    if (id !== undefined) return id;
    current = current.parent;
  }
  return null;
}

function isImplementation(decl: ts.Node): boolean {
  if (ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl)) {
    return decl.body !== undefined;
  }
  if (!ts.isVariableDeclaration(decl)) return false;
  const initializer = decl.initializer;
  return (
    initializer !== undefined &&
    (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
  );
}

const NODE_MODULES = "/node_modules/";
const TYPES_SCOPE = "@types/";

function isInNodeModules(ctx: TypeContext, source: ts.SourceFile): boolean {
  return ctx.libraryKind(source) !== null || source.fileName.includes(NODE_MODULES);
}

function workspaceId(ctx: TypeContext, decl: ts.Node, name: string): string | null {
  const source = decl.getSourceFile();
  if (source.isDeclarationFile || isInNodeModules(ctx, source)) return null;
  if (!isImplementation(decl)) return null;
  return `workspace:${ctx.relativePath(source)}:${name}`;
}

function packageOf(filePath: string): string | null {
  const at = filePath.lastIndexOf(NODE_MODULES);
  if (at === -1) return null;
  const segments = filePath.slice(at + NODE_MODULES.length).split("/");
  const name = segments[0]?.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
  if (name === undefined || name === "") return null;
  return name.startsWith(TYPES_SCOPE) ? name.slice(TYPES_SCOPE.length) : name;
}

function ambientModuleName(decl: ts.Node): string | null {
  for (let ancestor = decl.parent; ancestor; ancestor = ancestor.parent) {
    if (!ts.isModuleDeclaration(ancestor)) continue;
    const name = ancestor.name;
    if (ts.isStringLiteral(name)) return name.text;
  }
  return null;
}

// The TypeScript lib files: ts-morph served them from `/node_modules/typescript/lib`, so their
// declarations have always read as the `typescript` package's.
function declarationOrigin(ctx: TypeContext, decl: ts.Node): string {
  const source = decl.getSourceFile();
  if (ctx.libraryKind(source) !== null) return ambientModuleName(decl) ?? "typescript";
  return ambientModuleName(decl) ?? packageOf(source.fileName) ?? "workspace";
}

function ownerName(decl: ts.Node): string | null {
  const parent = decl.parent;
  if (
    ts.isClassDeclaration(parent) ||
    ts.isClassExpression(parent) ||
    ts.isInterfaceDeclaration(parent)
  ) {
    return parent.name?.text ?? null;
  }
  if (!ts.isTypeLiteralNode(parent)) return null;
  const alias = parent.parent;
  return ts.isTypeAliasDeclaration(alias) ? alias.name.text : null;
}

function qualifiedDeclaration(ctx: TypeContext, decl: ts.Node, name: string): string {
  const owner = ownerName(decl);
  const member = owner === null ? name : `${owner}.${name}`;
  return `${declarationOrigin(ctx, decl)}:${member}`;
}

export function simpleCalleeName(ctx: TypeContext, expression: ts.Node): string {
  if (ts.isPropertyAccessExpression(expression)) return ctx.text(expression.name);
  if (ts.isIdentifier(expression)) return ctx.text(expression);
  if (ts.isElementAccessExpression(expression)) {
    const arg = expression.argumentExpression;
    if (ts.isStringLiteral(arg)) return arg.text;
  }
  return "(dynamic)";
}

function inGlobalAugmentation(decl: ts.Node): boolean {
  for (let ancestor = decl.parent; ancestor; ancestor = ancestor.parent) {
    if (ts.isModuleDeclaration(ancestor) && ts.isIdentifier(ancestor.name)) {
      if (ancestor.name.text === "global") return true;
    }
  }
  return false;
}

const MERGE_RANK: Record<ts.LibraryKind, number> = { referenced: 0, root: 2 };

// Where a declaration sat in the order TypeScript merged globals for ts-morph: the libs a root lib
// references, then the program's own files and packages, then the root libs, and every
// `declare global` augmentation after all of them. tsgo lists every lib first, so a global a
// package and a lib both declare (`console` beside @cloudflare/workers-types, `String` beside
// @types/node) would otherwise name a different declaration than it always has.
function mergeRank(ctx: TypeContext, decl: ts.Node): number {
  if (inGlobalAugmentation(decl)) return 3;
  const library = ctx.libraryKind(decl.getSourceFile());
  return library === null ? 1 : MERGE_RANK[library];
}

function firstDeclaration(ctx: TypeContext, declarations: readonly ts.Node[]): ts.Node | undefined {
  let first: ts.Node | undefined;
  let firstRank = Number.POSITIVE_INFINITY;
  for (const decl of declarations) {
    const rank = mergeRank(ctx, decl);
    if (rank < firstRank) {
      first = decl;
      firstRank = rank;
    }
  }
  return first;
}

function resolveCallee(ctx: TypeContext, callExpr: ts.CallExpression): ResolvedCallee {
  const expression = callExpr.expression;
  const external = { calleeId: externalId(simpleCalleeName(ctx, expression)), declaration: null };

  const symbol = ctx.symbolOf(expression);
  if (symbol === undefined) return external;
  const target = ctx.aliasedSymbol(symbol) ?? symbol;
  const declarations = ctx.declarationsOf(target);
  for (const decl of declarations) {
    const id = enclosingId(decl, ctx.nodeToId);
    if (id !== null) return { calleeId: id, declaration: null };
  }
  for (const decl of declarations) {
    const id = workspaceId(ctx, decl, target.name);
    if (id !== null) return { calleeId: id, declaration: null };
  }
  const first = firstDeclaration(ctx, declarations);
  if (first === undefined) return external;
  return { ...external, declaration: qualifiedDeclaration(ctx, first, target.name) };
}

export function resolveCallees(
  ctx: TypeContext,
  callExpr: ts.CallExpression,
  factories: FactoryResolver,
): ResolvedCallee[] {
  const forwarded = factories(callExpr);
  if (forwarded.length === 0) return [resolveCallee(ctx, callExpr)];
  return forwarded.map((calleeId) => ({ calleeId, declaration: null }));
}
