import path from "node:path";
import { ownerOf } from "../extract/cross-runtime.js";
import type { DiscoveredFunction } from "../extract/functions.js";
import { toRelative } from "../extract/project.js";
import {
  type BindingCatalog,
  type DataBindingDecl,
  loadBindingCatalog,
} from "../extract/wrangler-config.js";
import type { DataEdge, DataReport } from "../schema.js";
import { field, nodeField, type SyntaxFile, type SyntaxNode } from "../syntax/file.js";
import { accessOf } from "./access.js";

type Bindings = ReadonlyMap<string, DataBindingDecl>;
type Site = { decl: DataBindingDecl; method: string | null; sql: string | null; line: number };

// `env`, `this.env`, `c.env`: the receiver a Workers binding is read off.
function isEnvReceiver(node: SyntaxNode): boolean {
  if (node.type === "Identifier") return field(node, "name") === "env";
  if (node.type !== "MemberExpression" || field(node, "computed") === true) return false;
  const property = nodeField(node, "property");
  return property?.type === "Identifier" && field(property, "name") === "env";
}

// The static name a member or property key spells: `.DB`, `["DB"]`, `{ DB }`.
function keyName(holder: SyntaxNode, key: SyntaxNode | null): string | null {
  if (key === null) return null;
  if (field(holder, "computed") !== true) {
    return key.type === "Identifier" ? String(field(key, "name")) : null;
  }
  const value = key.type === "Literal" ? field(key, "value") : null;
  return typeof value === "string" ? value : null;
}

function memberName(member: SyntaxNode): string | null {
  return keyName(member, nodeField(member, "property"));
}

function envBinding(node: SyntaxNode, bindings: Bindings): DataBindingDecl | null {
  if (node.type !== "MemberExpression") return null;
  const object = nodeField(node, "object");
  const name = memberName(node);
  if (object === null || name === null || !isEnvReceiver(object)) return null;
  return bindings.get(name) ?? null;
}

function localName(value: SyntaxNode | null): string | null {
  const target = value?.type === "AssignmentPattern" ? nodeField(value, "left") : value;
  return target?.type === "Identifier" ? String(field(target, "name")) : null;
}

type Aliases = Map<string, DataBindingDecl>;

// `const { DB, KV: kv } = env`.
function declareDestructured(pattern: SyntaxNode, bindings: Bindings, aliases: Aliases): void {
  for (const property of field(pattern, "properties") as SyntaxNode[]) {
    if (property.type !== "Property") continue;
    const key = keyName(property, nodeField(property, "key"));
    const decl = key === null ? undefined : bindings.get(key);
    const local = localName(nodeField(property, "value"));
    if (decl !== undefined && local !== null) aliases.set(local, decl);
  }
}

// One level of aliasing: `const db = env.DB`, or a destructure off `env`.
function declareAliases(node: SyntaxNode, bindings: Bindings, aliases: Aliases): void {
  if (node.type !== "VariableDeclarator") return;
  const id = nodeField(node, "id");
  const init = nodeField(node, "init");
  if (id === null || init === null) return;
  if (id.type === "ObjectPattern" && isEnvReceiver(init)) {
    declareDestructured(id, bindings, aliases);
    return;
  }
  const decl = id.type === "Identifier" ? envBinding(init, bindings) : null;
  if (decl !== null) aliases.set(String(field(id, "name")), decl);
}

function isAliasInitializer(node: SyntaxNode, parent: SyntaxNode | undefined): boolean {
  return (
    parent?.type === "VariableDeclarator" &&
    nodeField(parent, "init") === node &&
    nodeField(parent, "id")?.type === "Identifier"
  );
}

// Where an alias identifier is a use of the binding: a member read off it, or an argument.
function isAliasUse(node: SyntaxNode, parent: SyntaxNode | undefined): boolean {
  if (parent === undefined) return false;
  if (parent.type === "MemberExpression") return nodeField(parent, "object") === node;
  if (parent.type !== "CallExpression" && parent.type !== "NewExpression") return false;
  return (field(parent, "arguments") as SyntaxNode[]).includes(node);
}

function referencedBinding(
  syntax: SyntaxFile,
  node: SyntaxNode,
  bindings: Bindings,
  aliases: ReadonlyMap<string, DataBindingDecl>,
): DataBindingDecl | null {
  const parent = syntax.parentOf(node);
  if (node.type === "MemberExpression") {
    const decl = envBinding(node, bindings);
    return decl === null || isAliasInitializer(node, parent) ? null : decl;
  }
  if (node.type !== "Identifier") return null;
  const decl = aliases.get(String(field(node, "name")));
  return decl !== undefined && isAliasUse(node, parent) ? decl : null;
}

function literalText(node: SyntaxNode | undefined): string | null {
  if (node?.type === "Literal") {
    const value = field(node, "value");
    return typeof value === "string" ? value : null;
  }
  if (node?.type !== "TemplateLiteral") return null;
  const head = (field(node, "quasis") as SyntaxNode[])[0];
  const cooked = head === undefined ? null : (field(head, "value") as { cooked?: unknown }).cooked;
  return typeof cooked === "string" ? cooked : null;
}

function firstArgumentText(syntax: SyntaxFile, member: SyntaxNode): string | null {
  const call = syntax.parentOf(member);
  if (call?.type !== "CallExpression" || nodeField(call, "callee") !== member) return null;
  return literalText((field(call, "arguments") as SyntaxNode[])[0]);
}

function siteAt(syntax: SyntaxFile, ref: SyntaxNode, decl: DataBindingDecl): Site {
  const parent = syntax.parentOf(ref);
  const member =
    parent?.type === "MemberExpression" && nodeField(parent, "object") === ref ? parent : null;
  return {
    decl,
    method: member === null ? null : memberName(member),
    sql: member === null ? null : firstArgumentText(syntax, member),
    line: syntax.startLine(ref),
  };
}

// The sites inside one function, stopping at every nested function that owns its own.
function sitesOf(fn: DiscoveredFunction, owned: ReadonlySet<SyntaxNode>, bindings: Bindings) {
  const { syntax } = fn.unit;
  const aliases: Aliases = new Map();
  const sites: Site[] = [];
  const visit = (node: SyntaxNode): void => {
    declareAliases(node, bindings, aliases);
    const decl = referencedBinding(syntax, node, bindings, aliases);
    if (decl !== null) sites.push(siteAt(syntax, node, decl));
    for (const child of syntax.children(node)) if (!owned.has(child)) visit(child);
  };
  for (const child of syntax.children(fn.node)) if (!owned.has(child)) visit(child);
  return sites;
}

function compareEdges(a: DataEdge, b: DataEdge): number {
  return (
    a.functionId.localeCompare(b.functionId) ||
    a.line - b.line ||
    a.binding.localeCompare(b.binding) ||
    (a.method ?? "").localeCompare(b.method ?? "") ||
    a.access.localeCompare(b.access)
  );
}

function distinct(edges: readonly DataEdge[]): DataEdge[] {
  const seen = new Map<string, DataEdge>();
  for (const e of edges) seen.set(JSON.stringify([e.functionId, e.line, e.binding, e.method]), e);
  return [...seen.values()].sort(compareEdges);
}

export type DataScanInput = {
  functions: readonly DiscoveredFunction[];
  catalog: BindingCatalog;
  rootAbsolute: string;
  repoRoot: string;
};

export function scanDataEdges(input: DataScanInput): DataEdge[] {
  const { functions, catalog, rootAbsolute, repoRoot } = input;
  const owned = new Set(functions.map((f) => f.node));
  const edges: DataEdge[] = [];
  for (const fn of functions) {
    const owner = ownerOf(
      catalog.manifests,
      toRelative(repoRoot, path.join(rootAbsolute, fn.file)),
    );
    if (owner === null || owner.dataBindings.length === 0) continue;
    const bindings: Bindings = new Map(owner.dataBindings.map((d) => [d.binding, d]));
    for (const { decl, method, sql, line } of sitesOf(fn, owned, bindings)) {
      edges.push({
        functionId: fn.id,
        line,
        ownerService: owner.service,
        binding: decl.binding,
        bindingKind: decl.kind,
        method,
        access: accessOf(decl.kind, method, sql),
      });
    }
  }
  return distinct(edges);
}

export function loadDataReport(
  functions: readonly DiscoveredFunction[],
  rootAbsolute: string,
  repoRoot: string,
): DataReport {
  const catalog = loadBindingCatalog(repoRoot);
  return {
    configFiles: catalog.manifests.map((m) => m.configFile).sort((a, b) => a.localeCompare(b)),
    unparsedConfigs: catalog.unparsedConfigs,
    edges: scanDataEdges({ functions, catalog, rootAbsolute, repoRoot }),
  };
}
