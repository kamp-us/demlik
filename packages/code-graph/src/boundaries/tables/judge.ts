import type { ImportEdge } from "../../schema.js";
import { inScope, type Place, type ScopeZoning } from "../rules.js";
import type { BoundaryViolation } from "../violation.js";
import type { Follow } from "./follow.js";
import type { ImportedTable, TableFacts, Tables } from "./tables.js";
import { type NotFollowed, UNFOLLOWED_KINDS, type UnfollowedKind } from "./unfollowed.js";

// The facts of one file the table kinds read. `file` is scope-relative.
export type TabledFile = {
  readonly file: string;
  readonly importEdges: readonly ImportEdge[];
  readonly tableFacts: TableFacts;
};

// What a judgment of one scope asks: the scope, the kinds that run, its zoning, and `follow`, which
// says whose a table is.
export type TableContext = {
  readonly scope: string;
  readonly tables: Tables;
  readonly zoning: ScopeZoning;
  readonly follow: Follow;
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

// A table another feature owns, and the feature that owns it.
export type OwnedTable = { readonly owner: string; readonly table: string };

// The tables among `named` that a feature other than the file's own declares, one per name the facts
// record, in source order. The table is the one the name comes to once every re-export is followed:
// its identity is the name its owner's tables file exports it under. The one place that says whose a
// table is for the gate, the view and the census alike.
export function ownedOutside(
  ctx: TableContext,
  file: TabledFile,
  place: Place,
  named: readonly ImportedTable[],
): OwnedTable[] {
  const own = place.kind === "feature" ? place.feature : null;
  return named.flatMap((imported) => {
    const followed = ctx.follow(file.file, imported);
    if (followed.kind !== "table" || followed.owner === own) return [];
    return [{ owner: followed.owner, table: followed.table }];
  });
}

// The tables a file passes to a write that a feature other than the file's own declares.
export function outsideWrites(ctx: TableContext, file: TabledFile, place: Place): OwnedTable[] {
  return ownedOutside(ctx, file, place, file.tableFacts.writes);
}

// B23: a table written by a file outside the feature that declares it. One per file per table name,
// the first in source order, however many re-exports the name passed through.
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

// The kinds of write a file makes that the run cannot attribute to a table: the ones its syntax
// shows, and one for each write whose table the follower stops short of. In the order of
// `UNFOLLOWED`, once each. A scope that is not judged has no owner to attribute a write to.
function unfollowedKinds(ctx: TableContext, file: TabledFile): UnfollowedKind[] {
  if (!judgesTables(ctx.zoning)) return [];
  const found = new Set<UnfollowedKind>(file.tableFacts.unfollowed);
  for (const write of file.tableFacts.writes) {
    const followed = ctx.follow(file.file, write);
    if (followed.kind === "unfollowed") found.add(followed.why);
  }
  return UNFOLLOWED_KINDS.filter((kind) => found.has(kind));
}

// What a file leaves unfollowed, as the rows a census and a view list, the file as the repo names it.
export function notFollowedOf(ctx: TableContext, file: TabledFile): NotFollowed[] {
  return unfollowedKinds(ctx, file).map((kind) => ({ file: inScope(ctx.scope, file.file), kind }));
}
