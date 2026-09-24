import { Node, type SourceFile } from "ts-morph";
import type { FunctionKind } from "../schema.js";
import { toRelative } from "./project.js";

export type DiscoveredFunction = {
  node: Node;
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
  nodeToId: Map<Node, string>;
};

const TEST_FILE = /\.(test|spec)\.tsx?$/;

export function isTestFile(file: string): boolean {
  return TEST_FILE.test(file);
}

function nameFromBinding(node: Node): string | null {
  const parent = node.getParent();
  if (!parent) return null;
  if (Node.isVariableDeclaration(parent)) return parent.getName();
  if (Node.isPropertyAssignment(parent)) return parent.getName();
  if (Node.isPropertyDeclaration(parent)) return parent.getName();
  if (Node.isExportAssignment(parent)) return "default";
  return null;
}

type Classified = { kind: FunctionKind; name: string };

function classifyFunctionDeclaration(node: Node): Classified | null {
  if (!Node.isFunctionDeclaration(node)) return null;
  if (node.isOverload() || !node.hasBody()) return null;
  const name = node.getName();
  if (name) return { kind: "function", name };
  return node.isDefaultExport() ? { kind: "function", name: "default" } : null;
}

function classifyClassMember(node: Node): Classified | null {
  if (Node.isMethodDeclaration(node)) {
    if (node.isOverload() || !node.hasBody()) return null;
    return { kind: "method", name: node.getName() };
  }
  if (Node.isConstructorDeclaration(node)) return { kind: "constructor", name: "constructor" };
  if (Node.isGetAccessorDeclaration(node)) return { kind: "getter", name: node.getName() };
  if (Node.isSetAccessorDeclaration(node)) return { kind: "setter", name: node.getName() };
  return null;
}

function classifyExpressionCallable(node: Node): Classified | null {
  if (Node.isArrowFunction(node)) {
    const name = nameFromBinding(node);
    return name ? { kind: "arrow", name } : null;
  }
  if (Node.isFunctionExpression(node)) {
    const name = node.getName() ?? nameFromBinding(node);
    return name ? { kind: "function-expression", name } : null;
  }
  return null;
}

function classify(node: Node): Classified | null {
  return (
    classifyFunctionDeclaration(node) ??
    classifyClassMember(node) ??
    classifyExpressionCallable(node)
  );
}

function isExported(node: Node): boolean {
  if (Node.isExportable(node)) return node.isExported();
  return false;
}

function callableIsExported(node: Node, classified: FunctionKind): boolean {
  if (classified === "arrow" || classified === "function-expression") {
    const parent = node.getParent();
    if (parent && Node.isExportAssignment(parent)) return true;
    if (parent && Node.isVariableDeclaration(parent)) {
      const stmt = parent.getVariableStatement();
      return stmt ? stmt.isExported() : false;
    }
    if (parent && Node.isPropertyDeclaration(parent)) return isExported(parent);
    return false;
  }
  return isExported(node);
}

function discoverInFile(
  rootAbsolute: string,
  sourceFile: SourceFile,
  nodeToId: Map<Node, string>,
): DiscoveredFunction[] {
  const file = toRelative(rootAbsolute, sourceFile.getFilePath());
  const isTest = isTestFile(file);

  const raw: { node: Node; name: string; kind: FunctionKind }[] = [];
  sourceFile.forEachDescendant((node) => {
    const c = classify(node);
    if (c) raw.push({ node, name: c.name, kind: c.kind });
  });

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
    nodeToId.set(r.node, id);
    out.push({
      node: r.node,
      id,
      name: r.name,
      kind: r.kind,
      file,
      startLine: r.node.getStartLineNumber(),
      endLine: r.node.getEndLineNumber(),
      isExported: callableIsExported(r.node, r.kind),
      isTest,
    });
  }
  return out;
}

export function discoverFunctions(
  rootAbsolute: string,
  sourceFiles: SourceFile[],
): FunctionDiscovery {
  const nodeToId = new Map<Node, string>();
  const functions: DiscoveredFunction[] = [];
  for (const sf of sourceFiles) {
    functions.push(...discoverInFile(rootAbsolute, sf, nodeToId));
  }
  functions.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.startLine - b.startLine ||
      a.name.localeCompare(b.name) ||
      a.id.localeCompare(b.id),
  );
  return { functions, nodeToId };
}
