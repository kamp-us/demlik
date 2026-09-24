import { Node, type SourceFile } from "ts-morph";
import { isTestFile } from "./functions.js";
import { toRelative } from "./project.js";

export type ReferenceResult = {
  referencesById: Map<string, string[]>;
  moduleScopeRoots: string[];
  testModuleScopeRoots: string[];
  identifierFiles: Map<string, string[]>;
};

const MODULE_SCOPE = "<module-scope>";

function inModuleSpecifierClause(node: Node): boolean {
  let current: Node | undefined = node;
  while (current) {
    if (Node.isImportDeclaration(current) || Node.isExportDeclaration(current)) return true;
    if (Node.isStatement(current)) return false;
    current = current.getParent();
  }
  return false;
}

function isDeclarationName(node: Node): boolean {
  const parent = node.getParent();
  if (parent === undefined) return false;
  return Node.hasName(parent) && parent.getNameNode() === node;
}

function isCalleePosition(node: Node): boolean {
  const parent = node.getParent();
  if (parent === undefined) return false;
  if (Node.isCallExpression(parent)) return parent.getExpression() === node;
  if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === node) {
    const grand = parent.getParent();
    return grand !== undefined && Node.isCallExpression(grand) && grand.getExpression() === parent;
  }
  return false;
}

function ownerId(node: Node, nodeToId: Map<Node, string>): string {
  let current: Node | undefined = node.getParent();
  while (current) {
    const id = nodeToId.get(current);
    if (id !== undefined) return id;
    current = current.getParent();
  }
  return MODULE_SCOPE;
}

function idOfDeclaration(decl: Node, nodeToId: Map<Node, string>): string | null {
  const direct = nodeToId.get(decl);
  if (direct !== undefined) return direct;
  if (
    Node.isVariableDeclaration(decl) ||
    Node.isPropertyAssignment(decl) ||
    Node.isPropertyDeclaration(decl)
  ) {
    const initializer = decl.getInitializer();
    if (initializer !== undefined) return nodeToId.get(initializer) ?? null;
  }
  return null;
}

function referencedId(node: Node, nodeToId: Map<Node, string>): string | null {
  const symbol = node.getSymbol();
  if (symbol === undefined) return null;
  const aliased = symbol.getAliasedSymbol();
  for (const cand of aliased ? [aliased] : [symbol]) {
    for (const decl of cand.getDeclarations()) {
      const id = idOfDeclaration(decl, nodeToId);
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
  call: Node,
  exportsByFile: Map<string, string[]>,
  rootAbsolute: string,
): string[] {
  if (!Node.isCallExpression(call)) return [];
  const literal = call.getArguments()[0];
  if (literal === undefined || !Node.isStringLiteral(literal)) return [];
  const target = literal.getSymbol()?.getDeclarations()?.[0]?.getSourceFile();
  if (target === undefined) return [];
  return exportsByFile.get(toRelative(rootAbsolute, target.getFilePath())) ?? [];
}

type FileContext = {
  file: string;
  inTest: boolean;
  nodeToId: Map<Node, string>;
  knownNames: ReadonlySet<string>;
  exportsByFile: Map<string, string[]>;
  methodsByClass: Map<Node, string[]>;
  rootAbsolute: string;
};

function indexClassMethods(nodeToId: Map<Node, string>): Map<Node, string[]> {
  const index = new Map<Node, string[]>();
  for (const [node, id] of nodeToId) {
    const parent = node.getParent();
    if (parent === undefined) continue;
    if (!Node.isClassDeclaration(parent) && !Node.isClassExpression(parent)) continue;
    index.set(parent, [...(index.get(parent) ?? []), id]);
  }
  return index;
}

function classMethodRoots(node: Node, ctx: FileContext, acc: Accum): void {
  const symbol = node.getSymbol();
  if (symbol === undefined) return;
  const aliased = symbol.getAliasedSymbol();
  for (const cand of aliased ? [aliased] : [symbol]) {
    for (const decl of cand.getDeclarations()) {
      for (const id of ctx.methodsByClass.get(decl) ?? []) {
        addEdge(acc, MODULE_SCOPE, id, ctx.inTest);
      }
    }
  }
}

function visitIdentifier(node: Node, ctx: FileContext, acc: Accum): void {
  const name = node.getText();
  if (ownerId(node, ctx.nodeToId) === MODULE_SCOPE) classMethodRoots(node, ctx, acc);

  if (!ctx.knownNames.has(name)) return;
  const files = acc.identifierFiles.get(name);
  if (files === undefined) acc.identifierFiles.set(name, new Set([ctx.file]));
  else files.add(ctx.file);

  if (inModuleSpecifierClause(node) || isDeclarationName(node)) return;
  const owner = ownerId(node, ctx.nodeToId);
  if (owner !== MODULE_SCOPE && isCalleePosition(node)) return;
  const target = referencedId(node, ctx.nodeToId);
  if (target !== null) addEdge(acc, owner, target, ctx.inTest);
}

function visitCallArguments(call: Node, ctx: FileContext, acc: Accum): void {
  if (!Node.isCallExpression(call)) return;
  const owner = ownerId(call, ctx.nodeToId);
  for (const arg of call.getArguments()) {
    const direct = ctx.nodeToId.get(arg);
    if (direct !== undefined) {
      addEdge(acc, owner, direct, ctx.inTest);
      continue;
    }
    arg.forEachDescendant((d) => {
      const id = ctx.nodeToId.get(d);
      if (id !== undefined) addEdge(acc, owner, id, ctx.inTest);
    });
  }
}

function visitDynamicImport(node: Node, ctx: FileContext, acc: Accum): void {
  const owner = ownerId(node, ctx.nodeToId);
  for (const target of dynamicImportTargets(node, ctx.exportsByFile, ctx.rootAbsolute)) {
    addEdge(acc, owner, target, ctx.inTest);
  }
}

function isDynamicImport(node: Node): boolean {
  return Node.isCallExpression(node) && node.getExpression().getText() === "import";
}

function visitLiteralMember(node: Node, ctx: FileContext, acc: Accum): void {
  const id = ctx.nodeToId.get(node);
  if (id === undefined) return;
  const parent = node.getParent();
  if (parent === undefined) return;
  const grand = parent.getParent();
  const isMember =
    Node.isObjectLiteralExpression(parent) ||
    (Node.isPropertyAssignment(parent) &&
      grand !== undefined &&
      Node.isObjectLiteralExpression(grand));
  if (!isMember) return;
  addEdge(acc, ownerId(node, ctx.nodeToId), id, ctx.inTest);
}

function walkFile(sourceFile: SourceFile, ctx: FileContext, acc: Accum): void {
  sourceFile.forEachDescendant((node) => {
    if (isDynamicImport(node)) visitDynamicImport(node, ctx, acc);
    else if (Node.isCallExpression(node)) visitCallArguments(node, ctx, acc);
    else if (Node.isIdentifier(node)) visitIdentifier(node, ctx, acc);
    else visitLiteralMember(node, ctx, acc);
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

export function resolveReferences(
  rootAbsolute: string,
  sourceFiles: SourceFile[],
  nodeToId: Map<Node, string>,
  knownNames: ReadonlySet<string>,
  exportedIdsByFile: Map<string, string[]>,
): ReferenceResult {
  const acc: Accum = {
    refs: new Map(),
    moduleRoots: new Set(),
    testModuleRoots: new Set(),
    identifierFiles: new Map(),
  };
  const methodsByClass = indexClassMethods(nodeToId);
  for (const sf of sourceFiles) {
    const file = toRelative(rootAbsolute, sf.getFilePath());
    walkFile(
      sf,
      {
        file,
        inTest: isTestFile(file),
        nodeToId,
        knownNames,
        exportsByFile: exportedIdsByFile,
        methodsByClass,
        rootAbsolute,
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
