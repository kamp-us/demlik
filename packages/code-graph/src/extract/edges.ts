import type { TypeContext } from "../checker/context.js";
import * as ts from "../engine/tsgo.js";
import type { CallerSite, CallSite, ImportEdge } from "../schema.js";
import type { ImportGraph } from "../syntax/imports.js";
import { createFactoryResolver } from "./callee/factory.js";
import { resolveCallees } from "./callee/resolve.js";
import { computeChainDepths } from "./chain-depth.js";
import type { CrossRuntimeResolver } from "./cross-runtime.js";

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

function bindingIdentifiers(
  ctx: TypeContext,
  nameNode: ts.Node | undefined,
  into: Set<string>,
): void {
  if (nameNode === undefined) return;
  if (ts.isIdentifier(nameNode)) {
    into.add(ctx.text(nameNode));
    return;
  }
  const visit = (node: ts.Node): void => {
    const name = ts.isBindingElement(node) ? node.name : undefined;
    if (name !== undefined && ts.isIdentifier(name)) into.add(ctx.text(name));
    node.forEachChild(visit);
  };
  nameNode.forEachChild(visit);
}

function isTypeOnlyImport(declaration: ts.ImportDeclaration): boolean {
  return declaration.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword;
}

function addImportBindings(ctx: TypeContext, source: ts.SourceFile, into: Set<string>): void {
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || isTypeOnlyImport(statement)) continue;
    const clause = statement.importClause;
    if (clause === undefined) continue;
    if (clause.name !== undefined) into.add(ctx.text(clause.name));
    const bindings = clause.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) {
      into.add(ctx.text(bindings.name));
      continue;
    }
    for (const named of bindings.elements) {
      if (named.isTypeOnly) continue;
      into.add(ctx.text(named.name));
    }
  }
}

function isLiteralValue(node: ts.Node): boolean {
  if (ts.isPrefixUnaryExpression(node)) return ts.isNumericLiteral(node.operand);
  if (ts.isAsExpression(node)) return isLiteralValue(node.expression);
  return (
    ts.isNumericLiteral(node) ||
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword
  );
}

function isConstStatement(statement: ts.Node): statement is ts.VariableStatement {
  return (
    ts.isVariableStatement(statement) &&
    (statement.declarationList.flags & ts.NodeFlags.BlockScoped) === ts.NodeFlags.Const
  );
}

export function literalConstantNames(
  ctx: TypeContext,
  sources: readonly ts.SourceFile[],
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const source of sources) {
    for (const statement of source.statements) {
      if (!isConstStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        const initializer = declaration.initializer;
        if (initializer !== undefined && isLiteralValue(initializer)) {
          bindingIdentifiers(ctx, declaration.name, names);
        }
      }
    }
  }
  return names;
}

function addTopLevelConsts(ctx: TypeContext, source: ts.SourceFile, into: Set<string>): void {
  for (const statement of source.statements) {
    if (!isConstStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      bindingIdentifiers(ctx, declaration.name, into);
    }
  }
}

function moduleConstantNames(
  ctx: TypeContext,
  source: ts.SourceFile,
  literalConstants: ReadonlySet<string>,
): ReadonlySet<string> {
  const bound = new Set<string>();
  addImportBindings(ctx, source, bound);
  addTopLevelConsts(ctx, source, bound);
  const names = new Set<string>();
  for (const name of bound) if (literalConstants.has(name)) names.add(name);
  return names;
}

function isValuePosition(identifier: ts.Node): boolean {
  const parent = identifier.parent;
  if (parent === undefined) return true;
  if (ts.isPropertyAssignment(parent)) return parent.name !== identifier;
  if (ts.isPropertyAccessExpression(parent)) return parent.name !== identifier;
  if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
    return parent.expression !== identifier;
  }
  if (ts.isBindingElement(parent) || ts.isImportSpecifier(parent)) return false;
  return true;
}

function identifiersIn(node: ts.Node): ts.Node[] {
  if (ts.isIdentifier(node)) return [node];
  const out: ts.Node[] = [];
  const visit = (child: ts.Node): void => {
    if (ts.isIdentifier(child)) out.push(child);
    child.forEachChild(visit);
  };
  node.forEachChild(visit);
  return out;
}

function constantArguments(
  ctx: TypeContext,
  callExpression: ts.CallExpression,
  moduleConstants: ReadonlySet<string>,
): string[] {
  if (moduleConstants.size === 0) return [];
  const found = new Set<string>();
  for (const argument of callExpression.arguments) {
    for (const identifier of identifiersIn(argument)) {
      const text = ctx.text(identifier);
      if (moduleConstants.has(text) && isValuePosition(identifier)) found.add(text);
    }
  }
  return [...found].sort((a, b) => a.localeCompare(b));
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

// Every call expression of a discovered function's own body, nested discovered functions excluded:
// those charge their calls to themselves.
function ownCalls(root: ts.Node, nodeToId: ReadonlyMap<ts.Node, string>): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (nodeToId.has(node)) return;
    if (ts.isCallExpression(node)) out.push(node);
    node.forEachChild(visit);
  };
  root.forEachChild(visit);
  return out;
}

function resolveCalls(
  ctx: TypeContext,
  ids: readonly string[],
  crossRuntime: CrossRuntimeResolver | null,
): Map<string, CallSite[]> {
  const callsById = new Map<string, CallSite[]>();
  for (const id of ids) callsById.set(id, []);

  const factories = createFactoryResolver(ctx);
  const literalConstants = literalConstantNames(
    ctx,
    ctx.files.map((f) => f.source),
  );
  const constantsBySource = new Map<ts.SourceFile, ReadonlySet<string>>();
  const constantsOf = (source: ts.SourceFile): ReadonlySet<string> => {
    const cached = constantsBySource.get(source);
    if (cached !== undefined) return cached;
    const names = moduleConstantNames(ctx, source, literalConstants);
    constantsBySource.set(source, names);
    return names;
  };

  const callsByNode = new Map<ts.Node, ts.CallExpression[]>();
  for (const node of ctx.nodeToId.keys()) callsByNode.set(node, ownCalls(node, ctx.nodeToId));
  ctx.prefetchSymbols([...callsByNode.values()].flat().map((call) => call.expression));

  for (const [node, id] of ctx.nodeToId) {
    const source = node.getSourceFile();
    const file = ctx.relativePath(source);
    const constants = constantsOf(source);
    const raw: CallSite[] = [];
    for (const call of callsByNode.get(node) ?? []) {
      const cross = crossRuntime?.resolve(call, id, file) ?? null;
      const callees = cross === null ? resolveCallees(ctx, call, factories) : [cross];
      for (const callee of callees) {
        raw.push({
          ...callee,
          line: ctx.startLine(call),
          constArgs: constantArguments(ctx, call, constants),
        });
      }
    }
    callsById.set(id, dedupCalls([...(callsById.get(id) ?? []), ...raw]));
  }
  return callsById;
}

function invertCallers(
  callsById: Map<string, CallSite[]>,
  ids: readonly string[],
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

export function resolveEdges(
  ctx: TypeContext,
  imports: ImportGraph,
  ids: readonly string[],
  crossRuntime: CrossRuntimeResolver | null = null,
): EdgeResult {
  const callsById = resolveCalls(ctx, ids, crossRuntime);
  const calledById = invertCallers(callsById, ids);
  const chainDepthById = computeChainDepths([...ids], callsById);
  return {
    callsById,
    calledById,
    chainDepthById,
    importsByFile: imports.importsByFile,
    importedByFile: imports.importedByFile,
    importEdgesByFile: imports.importEdgesByFile,
  };
}
