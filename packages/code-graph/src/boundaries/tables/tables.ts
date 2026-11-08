import { bindingCounts, codeChildren, isNameSlot } from "../../syntax/bindings.js";
import { field, nodeField, type SyntaxFile, type SyntaxNode } from "../../syntax/file.js";
import { moduleExportName } from "../../syntax/imports.js";
import { type ExportEntry, exportEntriesOf } from "./exports.js";
import { TABLE_KINDS, type TableKind, type TableRules } from "./schema.js";
import { SYNTAX_UNFOLLOWED, type SyntaxUnfollowed } from "./unfollowed.js";

// The table constructor each drizzle dialect exports, by the module that exports it.
const TABLE_CONSTRUCTORS: Readonly<Record<string, string>> = {
  "drizzle-orm/pg-core": "pgTable",
  "drizzle-orm/sqlite-core": "sqliteTable",
  "drizzle-orm/mysql-core": "mysqlTable",
};

// The members of a query builder that change a table's rows: `db.insert(users)`, `db.update(users)`,
// `db.delete(users)` take the table as their first argument.
const WRITE_METHODS: ReadonlySet<string> = new Set(["insert", "update", "delete"]);

// What a run reads of `tableOwnership`, once: the kinds as a set, so a judgment asks it and never
// the rules file.
export type Tables = { readonly kinds: ReadonlySet<TableKind> };

export function readTables(rules: TableRules): Tables {
  return { kinds: new Set(rules.tableOwnership) };
}

// What a view reads: every fact, whichever kinds the rules file lists, since the view judges none.
export const ALL_TABLES: Tables = { kinds: new Set(TABLE_KINDS) };

// A table a file reaches by name: the module it imported the name from, as the import wrote it, and
// the names to walk from that module's exports to reach it. The first is the name the import takes
// (a default import takes `default`; a namespace import takes none), then each static member the
// file selects: `orders` for `{ orders }` and for `t.orders`, `ns` and `orders` for `t.ns.orders`.
// Where the walk ends is `follow.ts`'s: the file reads the path and never the modules behind it.
export type ImportedTable = { readonly source: string; readonly path: readonly string[] };

// What a file's syntax tree says about tables, read where the file is loaded and only for a kind
// the rules file lists:
//  - `writes`: the tables it passes to an insert, update or delete, in source order.
//  - `references`: every table it names at run time, a write included, in source order. A name is a
//    reference where the file reads it, not where it spells it as a member, a key, an export or a type.
//  - `constructors`: the drizzle constructors it calls, by name.
//  - `declared`: the names it exports bound to a table: `export const orders = pgTable(…)`, or a
//    schema's `export const plan = billing.table(…)`. Only a feature's tables file is read for them,
//    where a member call named `table` can be nothing else.
//  - `exports`: its export table, for following a table through a re-export.
//  - `unfollowed`: the kinds of write it makes that no import traces, which its syntax alone shows.
export type TableFacts = {
  readonly writes: readonly ImportedTable[];
  readonly references: readonly ImportedTable[];
  readonly constructors: readonly string[];
  readonly declared: readonly string[];
  readonly exports: readonly ExportEntry[];
  readonly unfollowed: readonly SyntaxUnfollowed[];
};

const NO_FACTS: TableFacts = {
  writes: [],
  references: [],
  constructors: [],
  declared: [],
  exports: [],
  unfollowed: [],
};

// A name an import binds: a named import (`{ users }`, `{ users as u }`, `{ default as u }`), a
// default import (the name `default`), or a namespace (`* as t`). A type-only import is erased.
type Import =
  | { readonly kind: "named"; readonly source: string; readonly name: string }
  | { readonly kind: "namespace"; readonly source: string };

function runtimeImports(syntax: SyntaxFile): Map<string, Import> {
  const imports = new Map<string, Import>();
  for (const statement of syntax.program.body) {
    if (statement.type !== "ImportDeclaration" || field(statement, "importKind") === "type") {
      continue;
    }
    const source = String(statement.source.value);
    for (const specifier of statement.specifiers) {
      if (field(specifier, "importKind") === "type") continue;
      const local = specifier.local.name;
      if (specifier.type === "ImportNamespaceSpecifier") {
        imports.set(local, { kind: "namespace", source });
      } else if (specifier.type === "ImportDefaultSpecifier") {
        imports.set(local, { kind: "named", source, name: "default" });
      } else if (specifier.type === "ImportSpecifier") {
        const name = moduleExportName(specifier.imported);
        if (name !== null) imports.set(local, { kind: "named", source, name });
      }
    }
  }
  return imports;
}

// The imports whose name the file binds nowhere else. A name bound twice (a parameter, a local, a
// second import) may stand for either, which a syntax tree cannot say, so the file keeps neither:
// per file, and failing open, as the impure globals do.
function boundOnce(syntax: SyntaxFile, imports: ReadonlyMap<string, Import>): Map<string, Import> {
  const counts = bindingCounts(syntax);
  return new Map([...imports].filter(([local]) => counts.get(local) === 1));
}

// `a.b` with a name for `b`, not a computed one.
function staticMember(
  node: SyntaxNode,
): { readonly object: SyntaxNode; readonly name: string } | null {
  if (node.type !== "MemberExpression" || field(node, "computed") === true) return null;
  const object = nodeField(node, "object");
  const property = nodeField(node, "property");
  if (object === null || property?.type !== "Identifier") return null;
  return { object, name: String(field(property, "name")) };
}

// The nodes that only wrap the expression they hold: parentheses and TypeScript's assertions.
const WRAPPERS: ReadonlySet<string> = new Set([
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
]);

function unwrap(node: SyntaxNode): SyntaxNode {
  const inner = WRAPPERS.has(node.type) ? nodeField(node, "expression") : null;
  return inner === null ? node : unwrap(inner);
}

// The module and names an expression reads from an import: the import's own name, then each static
// member selected from it (`t.orders`, `ns.t`, `b.ns.t`). A namespace taken whole names no table.
function importedPath(
  node: SyntaxNode,
  imports: ReadonlyMap<string, Import>,
): ImportedTable | null {
  const members: string[] = [];
  let current = unwrap(node);
  for (let member = staticMember(current); member !== null; member = staticMember(current)) {
    members.unshift(member.name);
    current = unwrap(member.object);
  }
  if (current.type !== "Identifier") return null;
  const bound = imports.get(String(field(current, "name")));
  if (bound === undefined) return null;
  const path = bound.kind === "named" ? [bound.name, ...members] : members;
  return path.length === 0 ? null : { source: bound.source, path };
}

type Found = {
  readonly writes: Map<string, ImportedTable>;
  readonly references: Map<string, ImportedTable>;
  readonly constructors: Set<string>;
  readonly declared: Set<string>;
  readonly unfollowed: Set<SyntaxUnfollowed>;
};

// A table once per module and path, at the place it first appeared.
function remember(into: Map<string, ImportedTable>, table: ImportedTable): void {
  into.set(`${table.source}\0${table.path.join("\0")}`, table);
}

// What can never be a table, as the first argument of a write: a literal, a template, an object, an
// array, a function, a class or an operator's result. `map.delete("key")` is one of these;
// `set.delete(key)` is not, and is counted, since syntax cannot tell it from a table held in a
// variable.
const NOT_A_TABLE: ReadonlySet<string> = new Set([
  "Literal",
  "TemplateLiteral",
  "ObjectExpression",
  "ArrayExpression",
  "ArrowFunctionExpression",
  "FunctionExpression",
  "ClassExpression",
  "UnaryExpression",
  "BinaryExpression",
  "UpdateExpression",
]);

// A call of `<anything>.insert|update|delete(<table>, …)`, an optional call included. The table is an
// import (a write) or it is not (an untraced write), unless it is nothing that could be one.
function recordWrite(call: SyntaxNode, imports: ReadonlyMap<string, Import>, found: Found): void {
  const callee = nodeField(call, "callee");
  const method = callee === null ? null : staticMember(callee);
  if (method === null || !WRITE_METHODS.has(method.name)) return;
  const first = (field(call, "arguments") as readonly SyntaxNode[])[0];
  if (first === undefined) return;
  const table = importedPath(first, imports);
  if (table !== null) remember(found.writes, table);
  else if (!NOT_A_TABLE.has(unwrap(first).type)) found.unfollowed.add("untraced-write");
}

// An `insert into`, `replace into`, `delete from` or `update … set` that starts a statement of a
// string, after any whitespace and SQL comments. Prose that mentions one does not start with it.
const RAW_SQL_WRITE =
  /(?:^|;)(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*(?:(?:insert|replace)\s+(?:or\s+\w+\s+)?into|delete\s+from|update\s+(?:or\s+\w+\s+)?\S+\s+set)\s/i;

type Quasi = { readonly value: { readonly cooked?: string | null; readonly raw: string } };

// The text of a string or a template, an `${expression}` standing as `?`; null for any other node.
function textOf(node: SyntaxNode): string | null {
  if (node.type === "Literal") {
    const value = field(node, "value");
    return typeof value === "string" ? value : null;
  }
  if (node.type !== "TemplateLiteral") return null;
  const quasis = field(node, "quasis") as readonly Quasi[];
  return quasis.map(({ value }) => value.cooked ?? value.raw).join("?");
}

function recordRawSql(node: SyntaxNode, found: Found): void {
  const text = textOf(node);
  if (text !== null && RAW_SQL_WRITE.test(text)) found.unfollowed.add("raw-sql");
}

// The name of the constructor a call invokes: one a drizzle module exports, bound by an import of
// that module.
function constructorOf(call: SyntaxNode, imports: ReadonlyMap<string, Import>): string | null {
  const callee = nodeField(call, "callee");
  const called = callee === null ? null : importedPath(callee, imports);
  if (called === null) return null;
  const [name, ...selected] = called.path;
  return selected.length === 0 && name !== undefined && TABLE_CONSTRUCTORS[called.source] === name
    ? name
    : null;
}

function recordConstructor(
  call: SyntaxNode,
  imports: ReadonlyMap<string, Import>,
  found: Found,
): void {
  const name = constructorOf(call, imports);
  if (name !== null) found.constructors.add(name);
}

// Whether a call builds a table: a drizzle constructor, or a schema's `<schema>.table(…)`, the form
// of a `pgSchema` object the file got from another module and so cannot name.
function buildsTable(call: SyntaxNode, imports: ReadonlyMap<string, Import>): boolean {
  if (constructorOf(call, imports) !== null) return true;
  const callee = nodeField(call, "callee");
  return callee !== null && staticMember(callee)?.name === "table";
}

// `export const <name> = <a call that builds a table>`.
function recordDeclared(
  syntax: SyntaxFile,
  declarator: SyntaxNode,
  imports: ReadonlyMap<string, Import>,
  found: Found,
): void {
  const id = nodeField(declarator, "id");
  const init = nodeField(declarator, "init");
  if (id?.type !== "Identifier" || init?.type !== "CallExpression") return;
  const statement = syntax.parentOf(declarator);
  const host = statement === undefined ? undefined : syntax.parentOf(statement);
  if (host?.type !== "ExportNamedDeclaration" || !buildsTable(init, imports)) return;
  found.declared.add(String(field(id, "name")));
}

// One pass over the tree. A name an import binds is read where it is not a slot that only names
// something (`a.b`'s `b`, an object key, an export list), and a namespace is read through its member,
// so a namespace taken whole (`...ns`, `use(ns)`) names no table.
function visit(
  syntax: SyntaxFile,
  node: SyntaxNode,
  found: Found,
  imports: ReadonlyMap<string, Import>,
): void {
  if (node.type === "ImportDeclaration" || isNameSlot(node, syntax.parentOf(node))) return;
  if (node.type === "CallExpression") {
    recordWrite(node, imports, found);
    recordConstructor(node, imports, found);
  }
  if (node.type === "VariableDeclarator") recordDeclared(syntax, node, imports, found);
  recordRawSql(node, found);
  const read = importedPath(node, imports);
  if (read !== null) {
    remember(found.references, read);
    return;
  }
  for (const child of codeChildren(syntax, node)) visit(syntax, child, found, imports);
}

// The facts of one file, none for a rules file that lists no table kind. Which kind judges which
// fact is `judge.ts`'s: a kind that is not listed never reads its own.
export function tableFactsOf(tables: Tables, syntax: SyntaxFile): TableFacts {
  if (tables.kinds.size === 0) return NO_FACTS;
  const imports = runtimeImports(syntax);
  const found: Found = {
    writes: new Map(),
    references: new Map(),
    constructors: new Set(),
    declared: new Set(),
    unfollowed: new Set(),
  };
  visit(syntax, syntax.program, found, imports.size === 0 ? imports : boundOnce(syntax, imports));
  return {
    writes: [...found.writes.values()],
    references: [...found.references.values()],
    constructors: [...found.constructors],
    declared: [...found.declared],
    exports: exportEntriesOf(syntax),
    unfollowed: SYNTAX_UNFOLLOWED.filter((kind) => found.unfollowed.has(kind)),
  };
}
