import type { TypeContext } from "../checker/context.js";
import * as ts from "../engine/tsgo.js";
import type { DiscoveredFunction } from "../extract/functions.js";
import type { DeclarationKind, UseSite } from "../schema.js";
import type { DiscoveredDeclaration } from "./discover.js";

export type DeclarationUses = {
  // One entry per joined declaration, `[]` when nothing uses it. A declaration absent here has no
  // node in tsgo's tree, so its uses are unknown.
  usesById: Map<string, UseSite[]>;
  // The same, for every exported function node the edge pass joined. Kept apart from `usesById`,
  // which is what a declaration node's `uses` field reports.
  functionUsesById: Map<string, UseSite[]>;
  unjoined: string[];
};

type TopLevel = { node: ts.Node; kind: DeclarationKind; name: string };

function isConstList(list: ts.VariableDeclarationList): boolean {
  return (list.flags & ts.NodeFlags.BlockScoped) === ts.NodeFlags.Const;
}

function constantsOf(ctx: TypeContext, statement: ts.VariableStatement): TopLevel[] {
  if (!isConstList(statement.declarationList)) return [];
  const out: TopLevel[] = [];
  for (const declaration of statement.declarationList.declarations) {
    const init = declaration.initializer;
    if (!ts.isIdentifier(declaration.name)) continue;
    if (init !== undefined && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) continue;
    out.push({ node: declaration, kind: "constant", name: ctx.text(declaration.name) });
  }
  return out;
}

function single(ctx: TypeContext, statement: ts.Node, kind: DeclarationKind): TopLevel[] {
  const name = (statement as { name?: ts.Node }).name;
  return [{ node: statement, kind, name: name === undefined ? "default" : ctx.text(name) }];
}

function topLevelOf(ctx: TypeContext, statement: ts.Node): TopLevel[] {
  if (ts.isVariableStatement(statement)) return constantsOf(ctx, statement);
  if (ts.isTypeAliasDeclaration(statement)) return single(ctx, statement, "type-alias");
  if (ts.isInterfaceDeclaration(statement)) return single(ctx, statement, "interface");
  if (ts.isEnumDeclaration(statement)) return single(ctx, statement, "enum");
  if (ts.isClassDeclaration(statement)) return single(ctx, statement, "class");
  return [];
}

// The declaration nodes of tsgo's tree, keyed by the id oxc's discovery gave each: kind, name and
// that pair's ordinal in source order, read the same way on both sides.
function joinDeclarations(
  ctx: TypeContext,
  declarations: readonly DiscoveredDeclaration[],
): Map<ts.Node, string> {
  const wanted = new Map<string, Map<string, string>>();
  for (const d of declarations) {
    const byKey = wanted.get(d.file) ?? new Map<string, string>();
    byKey.set(d.joinKey, d.id);
    wanted.set(d.file, byKey);
  }
  const nodeToId = new Map<ts.Node, string>();
  for (const { unit, source } of ctx.files) {
    const byKey = wanted.get(unit.file);
    if (byKey === undefined) continue;
    const seen = new Map<string, number>();
    for (const top of source.statements.flatMap((s) => topLevelOf(ctx, s))) {
      const key = `${top.kind}:${top.name}`;
      const ordinal = seen.get(key) ?? 0;
      seen.set(key, ordinal + 1);
      const id = byKey.get(`${key}#${ordinal}`);
      if (id !== undefined) nodeToId.set(top.node, id);
    }
  }
  return nodeToId;
}

function importedLocalNames(ctx: TypeContext, source: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const statement of source.statements) {
    if (ts.isImportEqualsDeclaration(statement)) names.push(ctx.text(statement.name));
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    if (clause?.name !== undefined) names.push(ctx.text(clause.name));
    const bindings = clause?.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) names.push(ctx.text(bindings.name));
    else for (const element of bindings.elements) names.push(ctx.text(element.name));
  }
  return names;
}

// Only an identifier spelled like a declaration, or like a name an import binds (`X as Y` makes
// `Y` one), can resolve to a top-level declaration; every other identifier skips the checker.
function candidateIdentifiers(
  ctx: TypeContext,
  source: ts.SourceFile,
  declaredNames: ReadonlySet<string>,
): ts.Identifier[] {
  const names = new Set([...declaredNames, ...importedLocalNames(ctx, source)]);
  const out: ts.Identifier[] = [];
  const visit = (node: ts.Node): undefined => {
    if (ts.isIdentifier(node) && names.has(ctx.text(node))) out.push(node);
    node.forEachChild(visit);
    return undefined;
  };
  source.forEachChild(visit);
  return out;
}

function resolvedSymbol(ctx: TypeContext, identifier: ts.Identifier): ts.TsSymbol | undefined {
  const parent = identifier.parent;
  const symbol =
    parent !== undefined && ts.isShorthandPropertyAssignment(parent) && parent.name === identifier
      ? ctx.shorthandValueSymbol(parent)
      : ctx.symbolOf(identifier);
  if (symbol === undefined) return undefined;
  return ctx.aliasedSymbol(symbol) ?? symbol;
}

// The tracked node id a checker declaration names: a declaration node, or an exported function
// node. `export default () => …` declares the default export through the assignment that holds
// the arrow, so its expression is the function node.
type TargetOf = (declaration: ts.Node) => string | undefined;

function targetResolver(
  ctx: TypeContext,
  nodeToId: ReadonlyMap<ts.Node, string>,
  functionIds: ReadonlySet<string>,
): TargetOf {
  const functionIdOf = (declaration: ts.Node): string | null =>
    ts.isExportAssignment(declaration)
      ? (ctx.nodeToId.get(declaration.expression) ?? null)
      : ctx.idOfDeclaration(declaration);
  return (declaration) => {
    const id = nodeToId.get(declaration);
    if (id !== undefined) return id;
    const fn = functionIdOf(declaration);
    return fn !== null && functionIds.has(fn) ? fn : undefined;
  };
}

function usedDeclarations(
  ctx: TypeContext,
  identifier: ts.Identifier,
  targetOf: TargetOf,
): string[] {
  const symbol = resolvedSymbol(ctx, identifier);
  if (symbol === undefined) return [];
  const ids: string[] = [];
  for (const declaration of ctx.declarationsOf(symbol)) {
    const id = targetOf(declaration);
    if (id === undefined) continue;
    if ((declaration as { name?: ts.Node }).name === identifier) continue;
    ids.push(id);
  }
  return ids;
}

function sortedSites(sites: Map<string, UseSite>): UseSite[] {
  return [...sites.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

// SPEC §8 C6: every identifier of a loaded file the type checker resolves, through any chain of
// import and export aliases, to a top-level declaration, or to one of `exportedFunctions`. One
// site per symbol per line.
export function resolveDeclarationUses(
  ctx: TypeContext,
  declarations: readonly DiscoveredDeclaration[],
  exportedFunctions: readonly DiscoveredFunction[] = [],
): DeclarationUses {
  const nodeToId = joinDeclarations(ctx, declarations);
  const joinedFunctions = new Set(ctx.nodeToId.values());
  const functionIds = new Set(
    exportedFunctions.filter((f) => joinedFunctions.has(f.id)).map((f) => f.id),
  );
  const sites = new Map<string, Map<string, UseSite>>();
  for (const id of [...nodeToId.values(), ...functionIds]) sites.set(id, new Map());
  const targetOf = targetResolver(ctx, nodeToId, functionIds);
  const names = new Set([...declarations, ...exportedFunctions].map((d) => d.name));
  for (const { unit, source } of ctx.files) {
    const identifiers = candidateIdentifiers(ctx, source, names);
    ctx.prefetchSymbols(identifiers);
    for (const identifier of identifiers) {
      for (const id of usedDeclarations(ctx, identifier, targetOf)) {
        const line = ctx.startLine(identifier);
        sites.get(id)?.set(`${unit.file}:${line}`, { file: unit.file, line });
      }
    }
  }
  const usesById = new Map<string, UseSite[]>();
  const functionUsesById = new Map<string, UseSite[]>();
  for (const [id, byKey] of sites) {
    (functionIds.has(id) ? functionUsesById : usesById).set(id, sortedSites(byKey));
  }
  const unjoined = declarations.filter((d) => !usesById.has(d.id)).map((d) => d.id);
  return { usesById, functionUsesById, unjoined };
}
