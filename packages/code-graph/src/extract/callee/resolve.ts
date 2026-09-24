import { type CallExpression, Node } from "ts-morph";
import { toRelative } from "../project.js";
import type { FactoryResolver } from "./factory.js";

export type ResolvedCallee = { calleeId: string; declaration: string | null };

function externalId(name: string): string {
  return `external:${name}`;
}

function enclosingId(node: Node, nodeToId: Map<Node, string>): string | null {
  let current: Node | undefined = node;
  while (current) {
    const id = nodeToId.get(current);
    if (id !== undefined) return id;
    current = current.getParent();
  }
  return null;
}

function isImplementation(decl: Node): boolean {
  if (Node.isFunctionDeclaration(decl) || Node.isMethodDeclaration(decl)) {
    return decl.hasBody();
  }
  if (!Node.isVariableDeclaration(decl)) return false;
  const initializer = decl.getInitializer();
  return Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer);
}

function workspaceId(rootAbsolute: string, decl: Node, name: string): string | null {
  const sourceFile = decl.getSourceFile();
  if (sourceFile.isDeclarationFile() || sourceFile.isInNodeModules()) return null;
  if (!isImplementation(decl)) return null;
  return `workspace:${toRelative(rootAbsolute, sourceFile.getFilePath())}:${name}`;
}

const NODE_MODULES = "/node_modules/";
const TYPES_SCOPE = "@types/";

function packageOf(filePath: string): string | null {
  const at = filePath.lastIndexOf(NODE_MODULES);
  if (at === -1) return null;
  const segments = filePath.slice(at + NODE_MODULES.length).split("/");
  const name = segments[0]?.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
  if (name === undefined || name === "") return null;
  return name.startsWith(TYPES_SCOPE) ? name.slice(TYPES_SCOPE.length) : name;
}

function ambientModuleName(decl: Node): string | null {
  for (const ancestor of decl.getAncestors()) {
    if (!Node.isModuleDeclaration(ancestor)) continue;
    const name = ancestor.getNameNode();
    if (Node.isStringLiteral(name)) return name.getLiteralValue();
  }
  return null;
}

function declarationOrigin(decl: Node): string {
  return ambientModuleName(decl) ?? packageOf(decl.getSourceFile().getFilePath()) ?? "workspace";
}

function ownerName(decl: Node): string | null {
  const parent = decl.getParent();
  if (
    Node.isClassDeclaration(parent) ||
    Node.isClassExpression(parent) ||
    Node.isInterfaceDeclaration(parent)
  ) {
    return parent.getName() ?? null;
  }
  if (!Node.isTypeLiteral(parent)) return null;
  const alias = parent.getParent();
  return Node.isTypeAliasDeclaration(alias) ? alias.getName() : null;
}

function qualifiedDeclaration(decl: Node, name: string): string {
  const owner = ownerName(decl);
  const member = owner === null ? name : `${owner}.${name}`;
  return `${declarationOrigin(decl)}:${member}`;
}

function resolveCallee(
  rootAbsolute: string,
  callExpr: CallExpression,
  nodeToId: Map<Node, string>,
): ResolvedCallee {
  const expression = callExpr.getExpression();
  const external = { calleeId: externalId(simpleCalleeName(expression)), declaration: null };

  const symbol = expression.getSymbol();
  if (symbol === undefined) return external;
  const target = symbol.getAliasedSymbol() ?? symbol;
  const declarations = target.getDeclarations();
  for (const decl of declarations) {
    const id = enclosingId(decl, nodeToId);
    if (id !== null) return { calleeId: id, declaration: null };
  }
  for (const decl of declarations) {
    const id = workspaceId(rootAbsolute, decl, target.getName());
    if (id !== null) return { calleeId: id, declaration: null };
  }
  const first = declarations[0];
  if (first === undefined) return external;
  return { ...external, declaration: qualifiedDeclaration(first, target.getName()) };
}

function simpleCalleeName(expression: Node): string {
  if (Node.isPropertyAccessExpression(expression)) return expression.getName();
  if (Node.isIdentifier(expression)) return expression.getText();
  if (Node.isElementAccessExpression(expression)) {
    const arg = expression.getArgumentExpression();
    if (arg && Node.isStringLiteral(arg)) return arg.getLiteralValue();
  }
  return "(dynamic)";
}

export function resolveCallees(
  rootAbsolute: string,
  callExpr: CallExpression,
  nodeToId: Map<Node, string>,
  factories: FactoryResolver,
): ResolvedCallee[] {
  const forwarded = factories(callExpr);
  if (forwarded.length === 0) return [resolveCallee(rootAbsolute, callExpr, nodeToId)];
  return forwarded.map((calleeId) => ({ calleeId, declaration: null }));
}
