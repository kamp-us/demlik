import { ownerOf } from "../extract/cross-runtime.js";
import type { DiscoveredFunction } from "../extract/functions.js";
import { type SourceUnit, toRelative } from "../extract/project.js";
import {
  type BindingCatalog,
  type DataBindingDecl,
  loadBindingCatalog,
} from "../extract/wrangler-config.js";
import type { DataEdge, DataReport, DataSite, UnattributedDataSite } from "../schema.js";
import { field, nodeField, type SyntaxFile, type SyntaxNode } from "../syntax/file.js";
import { accessOf } from "./access.js";

type Bindings = ReadonlyMap<string, DataBindingDecl>;
type Site = {
  decl: DataBindingDecl;
  method: string | null;
  sql: string | null;
  line: number;
  column: number;
};

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

const FUNCTION_LIKE = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
  "FunctionDeclaration",
]);

function isFunctionLike(node: SyntaxNode): boolean {
  return FUNCTION_LIKE.has(node.type);
}

// Every local a binding pattern introduces: `db`, `db = x`, `...db`, `{ db }`, `[db]`, and a
// TypeScript parameter property's `private db`.
function patternNames(pattern: SyntaxNode | null): string[] {
  if (pattern === null) return [];
  switch (pattern.type) {
    case "Identifier":
      return [String(field(pattern, "name"))];
    case "AssignmentPattern":
      return patternNames(nodeField(pattern, "left"));
    case "RestElement":
      return patternNames(nodeField(pattern, "argument"));
    case "TSParameterProperty":
      return patternNames(nodeField(pattern, "parameter"));
    case "Property":
      return patternNames(nodeField(pattern, "value"));
    case "ObjectPattern":
      return (field(pattern, "properties") as SyntaxNode[]).flatMap(patternNames);
    case "ArrayPattern":
      return (field(pattern, "elements") as (SyntaxNode | null)[]).flatMap(patternNames);
    default:
      return [];
  }
}

// A function-like node or a class static block: each owns every `var` below it.
function isVarScope(node: SyntaxNode): boolean {
  return isFunctionLike(node) || node.type === "StaticBlock";
}

function declaratorNames(declaration: SyntaxNode): string[] {
  return (field(declaration, "declarations") as SyntaxNode[]).flatMap((d) =>
    patternNames(nodeField(d, "id")),
  );
}

// Every `var` a scope owns: the ones below `root`, short of a nested var scope.
function varNames(syntax: SyntaxFile, root: SyntaxNode): string[] {
  const names: string[] = [];
  const visit = (node: SyntaxNode): void => {
    if (node.type === "VariableDeclaration" && field(node, "kind") === "var") {
      names.push(...declaratorNames(node));
    }
    for (const child of syntax.children(node)) if (!isVarScope(child)) visit(child);
  };
  visit(root);
  return names;
}

// The lexical names a statement list declares, looking through `export`: `let`/`const`/`using`,
// and the class and function declarations it holds, which module code (always strict) scopes to
// the block.
function lexicalNames(statements: readonly SyntaxNode[]): string[] {
  return statements.flatMap((statement) => {
    const node = statement.type.startsWith("Export")
      ? (nodeField(statement, "declaration") ?? statement)
      : statement;
    if (node.type === "VariableDeclaration") {
      return field(node, "kind") === "var" ? [] : declaratorNames(node);
    }
    if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") {
      return patternNames(nodeField(node, "id"));
    }
    return [];
  });
}

function statementsOf(node: SyntaxNode): SyntaxNode[] {
  return field(node, "body") as SyntaxNode[];
}

// A `for` head's `let`/`const`, scoped to the loop.
function headNames(head: SyntaxNode | null): string[] {
  return head === null ? [] : lexicalNames([head]);
}

// A function's own names: its parameters, a named expression's name, and its body's `var`s and
// top-level lexical declarations. The body block is the function's scope, not a second one.
function functionNames(syntax: SyntaxFile, fn: SyntaxNode): string[] {
  const names = (field(fn, "params") as SyntaxNode[]).flatMap(patternNames);
  if (fn.type === "FunctionExpression") names.push(...patternNames(nodeField(fn, "id")));
  const body = nodeField(fn, "body");
  if (body?.type !== "BlockStatement") return names;
  return [...names, ...lexicalNames(statementsOf(body)), ...varNames(syntax, body)];
}

function isFunctionBody(syntax: SyntaxFile, block: SyntaxNode): boolean {
  const parent = syntax.parentOf(block);
  return parent !== undefined && isFunctionLike(parent) && nodeField(parent, "body") === block;
}

// The names a scope-opening node declares, or null when the node opens no scope. The split is
// ECMAScript's, as eslint-scope models it: the module, a function and a class static block own
// their parameters and every `var` below them; a block, a `for` head, a `switch` and a `catch`
// own only the `let`/`const`/class/function declarations directly inside them.
function scopeDeclarations(syntax: SyntaxFile, node: SyntaxNode): string[] | null {
  switch (node.type) {
    case "Program":
    case "StaticBlock":
      return [...lexicalNames(statementsOf(node)), ...varNames(syntax, node)];
    case "ArrowFunctionExpression":
    case "FunctionExpression":
    case "FunctionDeclaration":
      return functionNames(syntax, node);
    case "BlockStatement":
      return isFunctionBody(syntax, node) ? null : lexicalNames(statementsOf(node));
    case "ForStatement":
      return headNames(nodeField(node, "init"));
    case "ForInStatement":
    case "ForOfStatement":
      return headNames(nodeField(node, "left"));
    case "SwitchStatement":
      return lexicalNames(
        (field(node, "cases") as SyntaxNode[]).flatMap(
          (c) => field(c, "consequent") as SyntaxNode[],
        ),
      );
    case "CatchClause":
      return patternNames(nodeField(node, "param"));
    default:
      return null;
  }
}

// One lexical alias scope per scope-opening node. A name the scope declares starts out shadowing
// any outer alias of that name, and becomes an alias only where its own declaration reads a
// binding; a name it does not declare resolves through the enclosing scopes.
class AliasScope {
  private readonly own = new Map<string, DataBindingDecl | null>();

  private constructor(private readonly parent: AliasScope | null) {}

  static root(): AliasScope {
    return new AliasScope(null);
  }

  child(names: readonly string[]): AliasScope {
    const scope = new AliasScope(this);
    for (const name of names) scope.own.set(name, null);
    return scope;
  }

  // Binds in the scope that declares the name, so a `var` inside a block lands on its function.
  bind(name: string, decl: DataBindingDecl): void {
    this.declaring(name).own.set(name, decl);
  }

  resolve(name: string): DataBindingDecl | null {
    return this.declaring(name).own.get(name) ?? null;
  }

  private declaring(name: string): AliasScope {
    for (let scope: AliasScope | null = this; scope !== null; scope = scope.parent) {
      if (scope.own.has(name)) return scope;
    }
    return this;
  }
}

// `const { DB, KV: kv } = env`.
function declareDestructured(pattern: SyntaxNode, bindings: Bindings, aliases: AliasScope): void {
  for (const property of field(pattern, "properties") as SyntaxNode[]) {
    if (property.type !== "Property") continue;
    const key = keyName(property, nodeField(property, "key"));
    const decl = key === null ? undefined : bindings.get(key);
    const local = localName(nodeField(property, "value"));
    if (decl !== undefined && local !== null) aliases.bind(local, decl);
  }
}

// One level of aliasing: `const db = env.DB`, or a destructure off `env`.
function declareAliases(node: SyntaxNode, bindings: Bindings, aliases: AliasScope): void {
  if (node.type !== "VariableDeclarator") return;
  const id = nodeField(node, "id");
  const init = nodeField(node, "init");
  if (id === null || init === null) return;
  if (id.type === "ObjectPattern" && isEnvReceiver(init)) {
    declareDestructured(id, bindings, aliases);
    return;
  }
  const decl = id.type === "Identifier" ? envBinding(init, bindings) : null;
  if (decl !== null) aliases.bind(String(field(id, "name")), decl);
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
  aliases: AliasScope,
): DataBindingDecl | null {
  const parent = syntax.parentOf(node);
  if (node.type === "MemberExpression") {
    const decl = envBinding(node, bindings);
    return decl === null || isAliasInitializer(node, parent) ? null : decl;
  }
  if (node.type !== "Identifier") return null;
  const decl = aliases.resolve(String(field(node, "name")));
  return decl !== null && isAliasUse(node, parent) ? decl : null;
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
    column: syntax.startColumn(ref),
  };
}

// A site and whoever holds it: the nearest discovered function around it, or null when only
// anonymous callbacks stand between the site and the module's top level.
type Held = { holder: DiscoveredFunction | null; site: Site };

// One preorder walk of a file. Entering a discovered function hands every site below it to that
// function; an anonymous callback stays with whoever holds it. Alias scope is a separate axis:
// every scope-opening node, a named function or not, opens a child of the scope around it.
function sitesOf(
  unit: SourceUnit,
  holders: ReadonlyMap<SyntaxNode, DiscoveredFunction>,
  bindings: Bindings,
): Held[] {
  const { syntax } = unit;
  const held: Held[] = [];
  const enter = (node: SyntaxNode, outer: DiscoveredFunction | null, around: AliasScope): void => {
    const holder = holders.get(node) ?? outer;
    const names = scopeDeclarations(syntax, node);
    const aliases = names === null ? around : around.child(names);
    declareAliases(node, bindings, aliases);
    const decl = referencedBinding(syntax, node, bindings, aliases);
    if (decl !== null) held.push({ holder, site: siteAt(syntax, node, decl) });
    for (const child of syntax.children(node)) enter(child, holder, aliases);
  };
  enter(syntax.program, null, AliasScope.root());
  return held;
}

function compareSites(a: DataSite, b: DataSite): number {
  return (
    a.line - b.line ||
    a.column - b.column ||
    a.binding.localeCompare(b.binding) ||
    (a.method ?? "").localeCompare(b.method ?? "") ||
    a.access.localeCompare(b.access)
  );
}

// The column is in the key, so two calls on one line — a read beside a write in one
// `batch([...])` — stay two rows.
function distinct<T extends DataSite>(rows: readonly T[], holder: (row: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const r of rows) {
    seen.set(JSON.stringify([holder(r), r.line, r.column, r.binding, r.method]), r);
  }
  return [...seen.values()].sort(
    (a, b) => holder(a).localeCompare(holder(b)) || compareSites(a, b),
  );
}

export type DataScan = Pick<DataReport, "edges" | "unattributed">;

export type DataScanInput = {
  units: readonly SourceUnit[];
  functions: readonly DiscoveredFunction[];
  catalog: BindingCatalog;
  repoRoot: string;
};

export function scanDataSites(input: DataScanInput): DataScan {
  const { units, functions, catalog, repoRoot } = input;
  const holders = new Map(functions.map((f) => [f.node, f]));
  const edges: DataEdge[] = [];
  const unattributed: UnattributedDataSite[] = [];
  for (const unit of units) {
    const owner = ownerOf(catalog.manifests, toRelative(repoRoot, unit.absolutePath));
    if (owner === null || owner.dataBindings.length === 0) continue;
    const bindings: Bindings = new Map(owner.dataBindings.map((d) => [d.binding, d]));
    for (const { holder, site } of sitesOf(unit, holders, bindings)) {
      const { decl, method, sql, line, column } = site;
      const row: DataSite = {
        line,
        column,
        ownerService: owner.service,
        binding: decl.binding,
        bindingKind: decl.kind,
        method,
        access: accessOf(decl.kind, method, sql),
      };
      if (holder === null) unattributed.push({ file: unit.file, ...row });
      else edges.push({ functionId: holder.id, ...row });
    }
  }
  return {
    edges: distinct(edges, (e) => e.functionId),
    unattributed: distinct(unattributed, (s) => s.file),
  };
}

export function loadDataReport(
  units: readonly SourceUnit[],
  functions: readonly DiscoveredFunction[],
  repoRoot: string,
): DataReport {
  const catalog = loadBindingCatalog(repoRoot);
  return {
    configFiles: catalog.manifests.map((m) => m.configFile).sort((a, b) => a.localeCompare(b)),
    unparsedConfigs: catalog.unparsedConfigs,
    ...scanDataSites({ units, functions, catalog, repoRoot }),
  };
}
