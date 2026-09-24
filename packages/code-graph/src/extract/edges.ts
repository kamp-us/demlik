import {
  Node,
  type SourceFile,
  SyntaxKind,
  type VariableDeclaration,
  VariableDeclarationKind,
} from "ts-morph";
import type { CallerSite, CallSite, ImportEdge } from "../schema.js";
import { computeChainDepths } from "./chain-depth.js";
import type { CrossRuntimeResolver } from "./cross-runtime.js";
import { toRelative } from "./project.js";

export type EdgeResult = {
  callsById: Map<string, CallSite[]>;
  calledById: Map<string, CallerSite[]>;
  chainDepthById: Map<string, number>;
  importsByFile: Map<string, string[]>;
  importedByFile: Map<string, string[]>;
  importEdgesByFile: Map<string, ImportEdge[]>;
};

export function distinctExternalCallers(id: string, calledBy: CallerSite[]): number {
  const distinct = new Set<string>();
  for (const c of calledBy) {
    if (c.callerId !== id) distinct.add(c.callerId);
  }
  return distinct.size;
}

export function selfRecursiveCallCount(id: string, calledBy: CallerSite[]): number {
  let n = 0;
  for (const c of calledBy) {
    if (c.callerId === id) n++;
  }
  return n;
}

function bindingIdentifiers(nameNode: Node, into: Set<string>): void {
  if (Node.isIdentifier(nameNode)) {
    into.add(nameNode.getText());
    return;
  }
  for (const element of nameNode.getDescendantsOfKind(SyntaxKind.BindingElement)) {
    const inner = element.getNameNode();
    if (Node.isIdentifier(inner)) into.add(inner.getText());
  }
}

function addImportBindings(sourceFile: SourceFile, into: Set<string>): void {
  for (const declaration of sourceFile.getImportDeclarations()) {
    if (declaration.isTypeOnly()) continue;
    const defaultImport = declaration.getDefaultImport();
    if (defaultImport !== undefined) into.add(defaultImport.getText());
    const namespaceImport = declaration.getNamespaceImport();
    if (namespaceImport !== undefined) into.add(namespaceImport.getText());
    for (const named of declaration.getNamedImports()) {
      if (named.isTypeOnly()) continue;
      into.add((named.getAliasNode() ?? named.getNameNode()).getText());
    }
  }
}

function isLiteralValue(node: Node): boolean {
  if (Node.isPrefixUnaryExpression(node)) {
    const operand = node.getOperand();
    return Node.isNumericLiteral(operand);
  }
  if (Node.isAsExpression(node)) return isLiteralValue(node.getExpression());
  return (
    Node.isNumericLiteral(node) ||
    Node.isStringLiteral(node) ||
    Node.isNoSubstitutionTemplateLiteral(node) ||
    Node.isTrueLiteral(node) ||
    Node.isFalseLiteral(node)
  );
}

function isLiteralConst(declaration: VariableDeclaration): boolean {
  const initializer = declaration.getInitializer();
  return initializer !== undefined && isLiteralValue(initializer);
}

export function literalConstantNames(sourceFiles: readonly SourceFile[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const sourceFile of sourceFiles) {
    for (const statement of sourceFile.getVariableStatements()) {
      if (statement.getDeclarationKind() !== VariableDeclarationKind.Const) continue;
      for (const declaration of statement.getDeclarations()) {
        if (isLiteralConst(declaration)) bindingIdentifiers(declaration.getNameNode(), names);
      }
    }
  }
  return names;
}

function addTopLevelConsts(sourceFile: SourceFile, into: Set<string>): void {
  for (const statement of sourceFile.getVariableStatements()) {
    if (statement.getDeclarationKind() !== VariableDeclarationKind.Const) continue;
    for (const declaration of statement.getDeclarations()) {
      bindingIdentifiers(declaration.getNameNode(), into);
    }
  }
}

function moduleConstantNames(
  sourceFile: SourceFile,
  literalConstants: ReadonlySet<string>,
): ReadonlySet<string> {
  const bound = new Set<string>();
  addImportBindings(sourceFile, bound);
  addTopLevelConsts(sourceFile, bound);
  const names = new Set<string>();
  for (const name of bound) if (literalConstants.has(name)) names.add(name);
  return names;
}

function isValuePosition(identifier: Node): boolean {
  const parent = identifier.getParent();
  if (parent === undefined) return true;
  if (Node.isPropertyAssignment(parent)) return parent.getNameNode() !== identifier;
  if (Node.isPropertyAccessExpression(parent)) return parent.getNameNode() !== identifier;
  if (Node.isCallExpression(parent) || Node.isNewExpression(parent)) {
    return parent.getExpression() !== identifier;
  }
  if (Node.isBindingElement(parent) || Node.isImportSpecifier(parent)) return false;
  return true;
}

function constantArguments(callExpression: Node, moduleConstants: ReadonlySet<string>): string[] {
  if (!Node.isCallExpression(callExpression) || moduleConstants.size === 0) return [];
  const found = new Set<string>();
  for (const argument of callExpression.getArguments()) {
    const identifiers = Node.isIdentifier(argument)
      ? [argument]
      : argument.getDescendantsOfKind(SyntaxKind.Identifier);
    for (const identifier of identifiers) {
      const text = identifier.getText();
      if (moduleConstants.has(text) && isValuePosition(identifier)) found.add(text);
    }
  }
  return [...found].sort((a, b) => a.localeCompare(b));
}

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

function resolveCallee(callExpr: Node, nodeToId: Map<Node, string>): string {
  if (!Node.isCallExpression(callExpr)) return externalId("unknown");
  const expression = callExpr.getExpression();

  const symbol = expression.getSymbol();
  if (symbol) {
    const aliased = symbol.getAliasedSymbol();
    const candidates = aliased ? [aliased] : [symbol];
    for (const cand of candidates) {
      for (const decl of cand.getDeclarations()) {
        const id = enclosingId(decl, nodeToId);
        if (id !== null) return id;
      }
    }
  }

  return externalId(simpleCalleeName(expression));
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

function dedupCalls(sites: CallSite[]): CallSite[] {
  const merged = new Map<string, CallSite>();
  for (const s of sites) {
    const key = `${s.line} ${s.calleeId}`;
    const seen = merged.get(key);
    if (seen === undefined) {
      merged.set(key, s);
      continue;
    }
    seen.constArgs = [...new Set([...seen.constArgs, ...s.constArgs])].sort((a, b) =>
      a.localeCompare(b),
    );
  }
  return [...merged.values()].sort(
    (a, b) => a.line - b.line || a.calleeId.localeCompare(b.calleeId),
  );
}

function dedupCallers(sites: CallerSite[]): CallerSite[] {
  const seen = new Set<string>();
  const out: CallerSite[] = [];
  for (const s of sites) {
    const key = `${s.line} ${s.callerId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  out.sort((a, b) => a.line - b.line || a.callerId.localeCompare(b.callerId));
  return out;
}

function dedupSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function resolveCalls(
  rootAbsolute: string,
  sourceFiles: SourceFile[],
  nodeToId: Map<Node, string>,
  ids: string[],
  crossRuntime: CrossRuntimeResolver | null,
): Map<string, CallSite[]> {
  const callsById = new Map<string, CallSite[]>();
  for (const id of ids) callsById.set(id, []);

  const literalConstants = literalConstantNames(sourceFiles);
  const constantsByFile = new Map<SourceFile, ReadonlySet<string>>();
  const constantsOf = (sourceFile: SourceFile): ReadonlySet<string> => {
    const cached = constantsByFile.get(sourceFile);
    if (cached !== undefined) return cached;
    const names = moduleConstantNames(sourceFile, literalConstants);
    constantsByFile.set(sourceFile, names);
    return names;
  };

  for (const [node, id] of nodeToId) {
    const sourceFile = node.getSourceFile();
    const file = toRelative(rootAbsolute, sourceFile.getFilePath());
    const constants = constantsOf(sourceFile);
    const raw: CallSite[] = [];
    node.forEachDescendant((d, traversal) => {
      if (d !== node && nodeToId.has(d)) {
        traversal.skip();
        return;
      }
      if (!Node.isCallExpression(d)) return;
      const cross = crossRuntime?.resolve(d, id, file) ?? null;
      raw.push({
        calleeId: cross ?? resolveCallee(d, nodeToId),
        line: d.getStartLineNumber(),
        constArgs: constantArguments(d, constants),
      });
    });
    callsById.set(id, dedupCalls([...(callsById.get(id) ?? []), ...raw]));
  }
  return callsById;
}

function invertCallers(
  callsById: Map<string, CallSite[]>,
  ids: string[],
): Map<string, CallerSite[]> {
  const callerAccum = new Map<string, CallerSite[]>();
  for (const id of ids) callerAccum.set(id, []);
  for (const [callerId, sites] of callsById) {
    for (const s of sites) {
      callerAccum.get(s.calleeId)?.push({ callerId, line: s.line });
    }
  }
  const calledById = new Map<string, CallerSite[]>();
  for (const id of ids) calledById.set(id, dedupCallers(callerAccum.get(id) ?? []));
  return calledById;
}

function classifyImportLiteral(literal: Node): { kind: ImportEdge["kind"]; typeOnly: boolean } {
  let node: Node | undefined = literal.getParent();
  while (node) {
    if (Node.isImportDeclaration(node)) return { kind: "static", typeOnly: node.isTypeOnly() };
    if (Node.isExportDeclaration(node)) return { kind: "export-from", typeOnly: node.isTypeOnly() };
    if (
      Node.isCallExpression(node) &&
      node.getExpression().getKind() === SyntaxKind.ImportKeyword
    ) {
      return { kind: "dynamic", typeOnly: false };
    }
    node = node.getParent();
  }
  return { kind: "static", typeOnly: false };
}

function dedupImportEdges(edges: ImportEdge[]): ImportEdge[] {
  const seen = new Set<string>();
  const out: ImportEdge[] = [];
  for (const e of edges) {
    const key = `${e.specifier} ${e.kind} ${e.typeOnly}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  out.sort(
    (a, b) =>
      a.specifier.localeCompare(b.specifier) ||
      a.kind.localeCompare(b.kind) ||
      Number(a.typeOnly) - Number(b.typeOnly),
  );
  return out;
}

function resolveImports(
  rootAbsolute: string,
  sourceFiles: SourceFile[],
): {
  importsByFile: Map<string, string[]>;
  importedByFile: Map<string, string[]>;
  importEdgesByFile: Map<string, ImportEdge[]>;
} {
  const importsByFile = new Map<string, string[]>();
  const importEdgesByFile = new Map<string, ImportEdge[]>();
  const fileSet = new Set(sourceFiles.map((sf) => toRelative(rootAbsolute, sf.getFilePath())));
  const importedAccum = new Map<string, string[]>();
  for (const f of fileSet) importedAccum.set(f, []);

  for (const sf of sourceFiles) {
    const file = toRelative(rootAbsolute, sf.getFilePath());
    const edges: ImportEdge[] = [];
    for (const literal of sf.getImportStringLiterals()) {
      const specifier = literal.getLiteralValue();
      const { kind, typeOnly } = classifyImportLiteral(literal);
      const decl = literal.getSymbol()?.getDeclarations()?.[0]?.getSourceFile();
      const targetRel = decl ? toRelative(rootAbsolute, decl.getFilePath()) : null;
      const target = targetRel !== null && fileSet.has(targetRel) ? targetRel : null;
      edges.push({ specifier, kind, typeOnly, target });
      if (target !== null) importedAccum.get(target)?.push(file);
    }
    importsByFile.set(file, dedupSorted(edges.map((e) => e.specifier)));
    importEdgesByFile.set(file, dedupImportEdges(edges));
  }

  const importedByFile = new Map<string, string[]>();
  for (const f of fileSet) importedByFile.set(f, dedupSorted(importedAccum.get(f) ?? []));
  return { importsByFile, importedByFile, importEdgesByFile };
}

export function resolveEdges(
  rootAbsolute: string,
  sourceFiles: SourceFile[],
  nodeToId: Map<Node, string>,
  ids: string[],
  crossRuntime: CrossRuntimeResolver | null = null,
): EdgeResult {
  const callsById = resolveCalls(rootAbsolute, sourceFiles, nodeToId, ids, crossRuntime);
  const calledById = invertCallers(callsById, ids);
  const { importsByFile, importedByFile, importEdgesByFile } = resolveImports(
    rootAbsolute,
    sourceFiles,
  );
  const chainDepthById = computeChainDepths(ids, callsById);
  return {
    callsById,
    calledById,
    chainDepthById,
    importsByFile,
    importedByFile,
    importEdgesByFile,
  };
}
