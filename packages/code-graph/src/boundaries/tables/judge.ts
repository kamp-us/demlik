import type { ImportEdge } from "../../schema.js";
import { inScope, type Place, placeOf, type ScopeZoning } from "../rules.js";
import type { BoundaryViolation } from "../violation.js";
import type { TableFacts, Tables } from "./tables.js";

// The facts of one file the table kinds read. `file` is scope-relative.
export type TabledFile = {
  readonly file: string;
  readonly importEdges: readonly ImportEdge[];
  readonly tableFacts: TableFacts;
};

export type TableContext = {
  readonly scope: string;
  readonly tables: Tables;
  readonly zoning: ScopeZoning;
};

// A scope laid out per feature is judged. The port layout has no `tables` zone, so it has no owner
// to name, and a scope with no features is a library, whose fixtures call table constructors.
export function judgesTables(zoning: ScopeZoning): boolean {
  return zoning.layout === "per-feature" && zoning.features.size > 0;
}

// B22: a table constructor called in a file that is not a feature's own table declaration.
function declarations(ctx: TableContext, file: TabledFile, place: Place): BoundaryViolation[] {
  if (!ctx.tables.kinds.has("table-declared-outside-tables")) return [];
  if (place.kind === "feature" && place.zone.rule.declaresTables) return [];
  return file.tableFacts.constructors.map((name) => ({
    kind: "table-declared-outside-tables",
    from: inScope(ctx.scope, file.file),
    to: null,
    specifier: name,
    typeOnly: false,
  }));
}

// The feature whose table declaration an imported table lands in, or null for an import that lands
// anywhere else or resolves to no file the scope loads. The one place that says whose a table is:
// B23 and the owners view both ask it.
export function ownerOf(ctx: TableContext, file: TabledFile, source: string): string | null {
  const target = file.importEdges.find((e) => e.specifier === source && e.target !== null)?.target;
  if (target === undefined || target === null) return null;
  const owner = placeOf(target, ctx.zoning);
  return owner.kind === "feature" && owner.zone.rule.declaresTables ? owner.feature : null;
}

// A table another feature owns, and the feature that owns it.
export type OwnedTable = { readonly owner: string; readonly table: string };

// The tables a file passes to a write that a feature other than the file's own declares, one per
// write the facts record, in source order.
export function outsideWrites(ctx: TableContext, file: TabledFile, place: Place): OwnedTable[] {
  const own = place.kind === "feature" ? place.feature : null;
  return file.tableFacts.writes.flatMap(({ source, table }) => {
    const owner = ownerOf(ctx, file, source);
    return owner === null || owner === own ? [] : [{ owner, table }];
  });
}

// B23: a table written by a file outside the feature that declares it. One per file per table name,
// the first in source order.
function writes(ctx: TableContext, file: TabledFile, place: Place): BoundaryViolation[] {
  if (!ctx.tables.kinds.has("table-written-outside-owner")) return [];
  const found = new Map<string, BoundaryViolation>();
  for (const { owner, table } of outsideWrites(ctx, file, place)) {
    if (found.has(table)) continue;
    found.set(table, {
      kind: "table-written-outside-owner",
      from: inScope(ctx.scope, file.file),
      to: null,
      specifier: table,
      typeOnly: false,
      owner,
    });
  }
  return [...found.values()];
}

// B22 and B23 for one file of a scope: the kinds `tableOwnership` lists, and nothing for one it does
// not.
export function judgeTables(
  ctx: TableContext,
  file: TabledFile,
  place: Place,
): BoundaryViolation[] {
  if (!judgesTables(ctx.zoning)) return [];
  return [...declarations(ctx, file, place), ...writes(ctx, file, place)];
}
