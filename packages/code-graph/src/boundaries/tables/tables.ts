import { bindingCounts, codeChildren } from "../../syntax/bindings.js";
import { field, nodeField, type SyntaxFile, type SyntaxNode } from "../../syntax/file.js";
import { moduleExportName } from "../../syntax/imports.js";
import type { TableKind, TableRules } from "./schema.js";

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

// A table a file passes to a write: the module it imported the table from, as the import wrote it,
// and the table's name in that module, whatever the file calls it.
export type TableWrite = { readonly source: string; readonly table: string };

// What a file's syntax tree says about tables, read where the file is loaded and only for a kind
// the rules file lists: the tables it writes, and the drizzle constructors it calls, by name.
export type TableFacts = {
  readonly writes: readonly TableWrite[];
  readonly constructors: readonly string[];
};

const NO_FACTS: TableFacts = { writes: [], constructors: [] };

// A name an import binds: a named import (`{ users }`, `{ users as u }`), or a namespace
// (`* as t`). A default import names nothing a table could be told by, and a type-only import is
// erased.
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

// The module and name an expression reads from an import: a named import's binding, or a member of a
// namespace import (`t.orders`).
function importedName(
  node: SyntaxNode,
  imports: ReadonlyMap<string, Import>,
): { readonly source: string; readonly name: string } | null {
  if (node.type === "Identifier") {
    const bound = imports.get(String(field(node, "name")));
    return bound?.kind === "named" ? { source: bound.source, name: bound.name } : null;
  }
  const member = staticMember(node);
  if (member === null || member.object.type !== "Identifier") return null;
  const bound = imports.get(String(field(member.object, "name")));
  return bound?.kind === "namespace" ? { source: bound.source, name: member.name } : null;
}

type Found = { readonly writes: Map<string, TableWrite>; readonly constructors: Set<string> };

// A call of `<anything>.insert|update|delete(<imported table>, …)`, an optional call included.
function recordWrite(call: SyntaxNode, imports: ReadonlyMap<string, Import>, found: Found): void {
  const callee = nodeField(call, "callee");
  const method = callee === null ? null : staticMember(callee);
  if (method === null || !WRITE_METHODS.has(method.name)) return;
  const first = (field(call, "arguments") as readonly SyntaxNode[])[0];
  const table = first === undefined ? null : importedName(first, imports);
  if (table === null) return;
  found.writes.set(`${table.source}\0${table.name}`, { source: table.source, table: table.name });
}

// A call of the constructor a drizzle module exports, bound by an import of that module.
function recordConstructor(
  call: SyntaxNode,
  imports: ReadonlyMap<string, Import>,
  found: Found,
): void {
  const callee = nodeField(call, "callee");
  const called = callee === null ? null : importedName(callee, imports);
  if (called !== null && TABLE_CONSTRUCTORS[called.source] === called.name) {
    found.constructors.add(called.name);
  }
}

function visit(
  syntax: SyntaxFile,
  node: SyntaxNode,
  found: Found,
  imports: ReadonlyMap<string, Import>,
): void {
  if (node.type === "CallExpression") {
    recordWrite(node, imports, found);
    recordConstructor(node, imports, found);
  }
  for (const child of codeChildren(syntax, node)) visit(syntax, child, found, imports);
}

// The facts of one file, none for a rules file that lists no table kind. Which kind judges which
// fact is `judge.ts`'s: a kind that is not listed never reads its own.
export function tableFactsOf(tables: Tables, syntax: SyntaxFile): TableFacts {
  if (tables.kinds.size === 0) return NO_FACTS;
  const imports = runtimeImports(syntax);
  if (imports.size === 0) return NO_FACTS;
  const found: Found = { writes: new Map(), constructors: new Set() };
  visit(syntax, syntax.program, found, boundOnce(syntax, imports));
  return { writes: [...found.writes.values()], constructors: [...found.constructors] };
}
