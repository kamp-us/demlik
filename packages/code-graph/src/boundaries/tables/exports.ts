import { patternNames } from "../../syntax/bindings.js";
import { field, nodeField, type SyntaxFile, type SyntaxNode } from "../../syntax/file.js";
import { moduleExportName } from "../../syntax/imports.js";

// One row of a module's export table, in the forms ECMA-262 files every export under
// (ParseModule, 16.2.1.7.1, https://tc39.es/ecma262/#sec-parsemodule):
//  - `local`: the module defines `name`: `export const name = …`, `export { name }`, `export default`.
//  - `indirect`: `name` is `from`, a name another module exports: `export { from as name } from`.
//  - `namespace`: `name` is the whole of another module: `export * as name from`.
//  - `star`: every name the other module exports, bar `default`: `export * from`.
//  - `assignment`: `export = value`, TypeScript's, which leaves no named export to follow.
// `source` is the specifier as the file wrote it, which the file's import edges resolve.
export type ExportEntry =
  | { readonly kind: "local"; readonly name: string }
  | {
      readonly kind: "indirect";
      readonly name: string;
      readonly source: string;
      readonly from: string;
    }
  | { readonly kind: "namespace"; readonly name: string; readonly source: string }
  | { readonly kind: "star"; readonly source: string }
  | { readonly kind: "assignment" };

// What an import binds under its local name, so an export list can re-export it. `from` is the name
// it takes from the module, `null` for the whole namespace.
type Bound = { readonly source: string; readonly from: string | null; readonly typeOnly: boolean };

function boundImports(syntax: SyntaxFile): Map<string, Bound> {
  const bound = new Map<string, Bound>();
  for (const statement of syntax.program.body) {
    if (statement.type !== "ImportDeclaration") continue;
    const source = String(statement.source.value);
    const declaredType = field(statement, "importKind") === "type";
    for (const specifier of statement.specifiers) {
      const typeOnly = declaredType || field(specifier, "importKind") === "type";
      const local = specifier.local.name;
      if (specifier.type === "ImportNamespaceSpecifier") {
        bound.set(local, { source, from: null, typeOnly });
      } else if (specifier.type === "ImportDefaultSpecifier") {
        bound.set(local, { source, from: "default", typeOnly });
      } else if (specifier.type === "ImportSpecifier") {
        const from = moduleExportName(specifier.imported);
        if (from !== null) bound.set(local, { source, from, typeOnly });
      }
    }
  }
  return bound;
}

const local = (name: string): ExportEntry => ({ kind: "local", name });

// `export const a = 1, { b } = c`, `export function f`, `export class C`, `export enum E`: the names
// the declaration defines. `export import a = require("m")` is the whole of `m`, as `export * as a`.
function declaredEntries(declaration: SyntaxNode): ExportEntry[] {
  if (declaration.type === "VariableDeclaration") {
    const declarators = field(declaration, "declarations") as SyntaxNode[];
    return declarators.flatMap((d) => patternNames(nodeField(d, "id")).map(local));
  }
  const name = moduleExportName(nodeField(declaration, "id"));
  if (name === null) return [];
  const reference = nodeField(declaration, "moduleReference");
  if (
    declaration.type === "TSImportEqualsDeclaration" &&
    reference?.type === "TSExternalModuleReference"
  ) {
    const source = nodeField(reference, "expression");
    if (source !== null) {
      return [{ kind: "namespace", name, source: String(field(source, "value")) }];
    }
  }
  return [local(name)];
}

// One specifier of `export { … }`. With a `source` it is the module's own name; without, it names a
// local binding, and a binding the file imported is rewritten to the form it would have had it been
// re-exported straight from the module it came from (ParseModule): `import { t } from "m"; export
// { t }` is `export { t } from "m"`, and `import * as t from "m"; export { t }` is `export * as t
// from "m"`. A type-only specifier, or the export of a type-only import, is erased.
function specifierEntries(
  specifier: SyntaxNode,
  source: string | null,
  imports: ReadonlyMap<string, Bound>,
): ExportEntry[] {
  if (field(specifier, "exportKind") === "type") return [];
  const named = moduleExportName(nodeField(specifier, "local"));
  const name = moduleExportName(nodeField(specifier, "exported"));
  if (named === null || name === null) return [];
  if (source !== null) return [{ kind: "indirect", name, source, from: named }];
  const imported = imports.get(named);
  if (imported === undefined) return [local(name)];
  if (imported.typeOnly) return [];
  if (imported.from === null) return [{ kind: "namespace", name, source: imported.source }];
  return [{ kind: "indirect", name, source: imported.source, from: imported.from }];
}

type Reader = (statement: SyntaxNode, imports: ReadonlyMap<string, Bound>) => ExportEntry[];

function sourceOf(statement: SyntaxNode): string | null {
  const source = nodeField(statement, "source");
  return source === null ? null : String(field(source, "value"));
}

// `export { … }`, `export { … } from`, `export <declaration>`.
const named: Reader = (statement, imports) => {
  if (field(statement, "exportKind") === "type") return [];
  const declaration = nodeField(statement, "declaration");
  if (declaration !== null) return declaredEntries(declaration);
  const source = sourceOf(statement);
  const specifiers = field(statement, "specifiers") as SyntaxNode[];
  return specifiers.flatMap((specifier) => specifierEntries(specifier, source, imports));
};

// `export * from "m"` and `export * as name from "m"`.
const all: Reader = (statement) => {
  const source = sourceOf(statement);
  if (source === null || field(statement, "exportKind") === "type") return [];
  const exported = moduleExportName(nodeField(statement, "exported"));
  return [
    exported === null ? { kind: "star", source } : { kind: "namespace", name: exported, source },
  ];
};

// The statements of a module that export, by node type: one row each.
const READERS: ReadonlyMap<string, Reader> = new Map([
  ["ExportNamedDeclaration", named],
  ["ExportAllDeclaration", all],
  ["ExportDefaultDeclaration", () => [local("default")]],
  ["TSExportAssignment", () => [{ kind: "assignment" }]],
]);

// A file's export table, in source order. Read from the top-level statements, which is where a
// module exports; a type-only export is dropped here, as a type-only import is wherever imports are
// read, since it leaves nothing at run time.
export function exportEntriesOf(syntax: SyntaxFile): ExportEntry[] {
  const imports = boundImports(syntax);
  return syntax.program.body.flatMap(
    (statement) => READERS.get(statement.type)?.(statement, imports) ?? [],
  );
}
