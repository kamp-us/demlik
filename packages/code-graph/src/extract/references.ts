import type { TypeContext } from "../checker/context.js";
import * as ts from "../engine/tsgo.js";
import { isTestFile } from "./functions.js";

export type ReferenceResult = {
  referencesById: Map<string, string[]>;
  moduleScopeRoots: string[];
  testModuleScopeRoots: string[];
  identifierFiles: Map<string, string[]>;
};

const MODULE_SCOPE = "<module-scope>";

function inModuleSpecifierClause(node: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isImportDeclaration(current) || ts.isExportDeclaration(current)) return true;
    if (ts.isStatement(current)) return false;
    current = current.parent;
  }
  return false;
}

// ts-morph's `Node.hasName(parent) && parent.getNameNode() === node`: the node is the `name` of
// whatever declares it.
function isDeclarationName(node: ts.Node): boolean {
  const parent = node.parent;
  return parent !== undefined && (parent as { name?: ts.Node }).name === node;
}

function isCalleePosition(node: ts.Node): boolean {
  const parent = node.parent;
  if (parent === undefined) return false;
  if (ts.isCallExpression(parent)) return parent.expression === node;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    const grand = parent.parent;
    return grand !== undefined && ts.isCallExpression(grand) && grand.expression === parent;
  }
  return false;
}

function ownerId(node: ts.Node, nodeToId: ReadonlyMap<ts.Node, string>): string {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    const id = nodeToId.get(current);
    if (id !== undefined) return id;
    current = current.parent;
  }
  return MODULE_SCOPE;
}

function idOfDeclaration(decl: ts.Node, nodeToId: ReadonlyMap<ts.Node, string>): string | null {
  const direct = nodeToId.get(decl);
  if (direct !== undefined) return direct;
  if (
    ts.isVariableDeclaration(decl) ||
    ts.isPropertyAssignment(decl) ||
    ts.isPropertyDeclaration(decl)
  ) {
    const initializer = decl.initializer;
    if (initializer !== undefined) return nodeToId.get(initializer) ?? null;
  }
  return null;
}

function candidateSymbols(ctx: TypeContext, node: ts.Node): ts.TsSymbol[] {
  const symbol = ctx.symbolOf(node);
  if (symbol === undefined) return [];
  const aliased = ctx.aliasedSymbol(symbol);
  return aliased ? [aliased] : [symbol];
}

function referencedId(ctx: TypeContext, node: ts.Node): string | null {
  for (const cand of candidateSymbols(ctx, node)) {
    for (const decl of ctx.declarationsOf(cand)) {
      const id = idOfDeclaration(decl, ctx.nodeToId);
      if (id !== null) return id;
    }
  }
  return null;
}

type Accum = {
  refs: Map<string, Set<string>>;
  moduleRoots: Set<string>;
  testModuleRoots: Set<string>;
  identifierFiles: Map<string, Set<string>>;
};

function addEdge(acc: Accum, owner: string, target: string, inTest: boolean): void {
  if (owner === MODULE_SCOPE) {
    (inTest ? acc.testModuleRoots : acc.moduleRoots).add(target);
    return;
  }
  const bucket = acc.refs.get(owner);
  if (bucket === undefined) acc.refs.set(owner, new Set([target]));
  else bucket.add(target);
}

function dynamicImportTargets(
  ctx: TypeContext,
  call: ts.CallExpression,
  exportsByFile: Map<string, string[]>,
): string[] {
  const literal = call.arguments[0];
  if (literal === undefined || !ts.isStringLiteral(literal)) return [];
  const symbol = ctx.symbolOf(literal);
  const target = symbol === undefined ? undefined : ctx.declarationsOf(symbol)[0]?.getSourceFile();
  if (target === undefined) return [];
  return exportsByFile.get(ctx.relativePath(target)) ?? [];
}

type FileContext = {
  file: string;
  inTest: boolean;
  ctx: TypeContext;
  knownNames: ReadonlySet<string>;
  exportsByFile: Map<string, string[]>;
  methodsByClass: Map<ts.Node, string[]>;
};

function indexClassMethods(nodeToId: ReadonlyMap<ts.Node, string>): Map<ts.Node, string[]> {
  const index = new Map<ts.Node, string[]>();
  for (const [node, id] of nodeToId) {
    const parent = node.parent;
    if (parent === undefined) continue;
    if (!ts.isClassDeclaration(parent) && !ts.isClassExpression(parent)) continue;
    index.set(parent, [...(index.get(parent) ?? []), id]);
  }
  return index;
}

function classMethodRoots(node: ts.Node, fc: FileContext, acc: Accum): void {
  for (const cand of candidateSymbols(fc.ctx, node)) {
    for (const decl of fc.ctx.declarationsOf(cand)) {
      for (const id of fc.methodsByClass.get(decl) ?? []) {
        addEdge(acc, MODULE_SCOPE, id, fc.inTest);
      }
    }
  }
}

function visitIdentifier(node: ts.Node, fc: FileContext, acc: Accum): void {
  const name = fc.ctx.text(node);
  if (ownerId(node, fc.ctx.nodeToId) === MODULE_SCOPE) classMethodRoots(node, fc, acc);

  if (!fc.knownNames.has(name)) return;
  const files = acc.identifierFiles.get(name);
  if (files === undefined) acc.identifierFiles.set(name, new Set([fc.file]));
  else files.add(fc.file);

  if (inModuleSpecifierClause(node) || isDeclarationName(node)) return;
  const owner = ownerId(node, fc.ctx.nodeToId);
  if (owner !== MODULE_SCOPE && isCalleePosition(node)) return;
  const target = referencedId(fc.ctx, node);
  if (target !== null) addEdge(acc, owner, target, fc.inTest);
}

function forEachDescendant(node: ts.Node, visit: (descendant: ts.Node) => void): void {
  node.forEachChild((child) => {
    visit(child);
    forEachDescendant(child, visit);
    return undefined;
  });
}

function visitCallArguments(call: ts.CallExpression, fc: FileContext, acc: Accum): void {
  const owner = ownerId(call, fc.ctx.nodeToId);
  for (const arg of call.arguments) {
    const direct = fc.ctx.nodeToId.get(arg);
    if (direct !== undefined) {
      addEdge(acc, owner, direct, fc.inTest);
      continue;
    }
    forEachDescendant(arg, (d) => {
      const id = fc.ctx.nodeToId.get(d);
      if (id !== undefined) addEdge(acc, owner, id, fc.inTest);
    });
  }
}

function visitDynamicImport(call: ts.CallExpression, fc: FileContext, acc: Accum): void {
  const owner = ownerId(call, fc.ctx.nodeToId);
  for (const target of dynamicImportTargets(fc.ctx, call, fc.exportsByFile)) {
    addEdge(acc, owner, target, fc.inTest);
  }
}

function isDynamicImport(fc: FileContext, node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node) && fc.ctx.text(node.expression) === "import";
}

function visitLiteralMember(node: ts.Node, fc: FileContext, acc: Accum): void {
  const id = fc.ctx.nodeToId.get(node);
  if (id === undefined) return;
  const parent = node.parent;
  if (parent === undefined) return;
  const grand = parent.parent;
  const isMember =
    ts.isObjectLiteralExpression(parent) ||
    (ts.isPropertyAssignment(parent) && grand !== undefined && ts.isObjectLiteralExpression(grand));
  if (!isMember) return;
  addEdge(acc, ownerId(node, fc.ctx.nodeToId), id, fc.inTest);
}

function walkFile(source: ts.SourceFile, fc: FileContext, acc: Accum): void {
  forEachDescendant(source, (node) => {
    if (isDynamicImport(fc, node)) visitDynamicImport(node, fc, acc);
    else if (ts.isCallExpression(node)) visitCallArguments(node, fc, acc);
    else if (ts.isIdentifier(node)) visitIdentifier(node, fc, acc);
    else visitLiteralMember(node, fc, acc);
  });
}

function freeze(map: Map<string, Set<string>>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const key of [...map.keys()].sort((a, b) => a.localeCompare(b))) {
    out.set(
      key,
      [...(map.get(key) ?? [])].sort((a, b) => a.localeCompare(b)),
    );
  }
  return out;
}

function prefetchIdentifiers(ctx: TypeContext, source: ts.SourceFile): void {
  const identifiers: ts.Node[] = [];
  forEachDescendant(source, (node) => {
    if (ts.isIdentifier(node)) identifiers.push(node);
  });
  ctx.prefetchSymbols(identifiers);
}

export function resolveReferences(
  ctx: TypeContext,
  knownNames: ReadonlySet<string>,
  exportedIdsByFile: Map<string, string[]>,
): ReferenceResult {
  const acc: Accum = {
    refs: new Map(),
    moduleRoots: new Set(),
    testModuleRoots: new Set(),
    identifierFiles: new Map(),
  };
  const methodsByClass = indexClassMethods(ctx.nodeToId);
  for (const { unit, source } of ctx.files) {
    prefetchIdentifiers(ctx, source);
    walkFile(
      source,
      {
        file: unit.file,
        inTest: isTestFile(unit.file),
        ctx,
        knownNames,
        exportsByFile: exportedIdsByFile,
        methodsByClass,
      },
      acc,
    );
  }
  const sorted = (s: Set<string>): string[] => [...s].sort((a, b) => a.localeCompare(b));
  return {
    referencesById: freeze(acc.refs),
    moduleScopeRoots: sorted(acc.moduleRoots),
    testModuleScopeRoots: sorted(acc.testModuleRoots),
    identifierFiles: freeze(acc.identifierFiles),
  };
}
