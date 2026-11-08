import type { Place } from "../rules.js";
import {
  judgesTables,
  type OwnedTable,
  outsideWrites,
  ownerOf,
  type TableContext,
  type TabledFile,
} from "./judge.js";

// How a file reaches a table another feature owns: `write` (B23's fact: the table is passed to
// `insert`, `update` or `delete`), `foreign-key` (the file is itself a feature's tables file, the
// one place another feature's table is open to, #866) or `read` (named at run time and not written:
// a select, a join or a condition, which syntax alone does not tell apart).
export type Access = "write" | "foreign-key" | "read";

// The strongest way first: a file that does two things to one table is listed for the first.
const STRONGEST_FIRST = ["write", "foreign-key", "read"] as const satisfies readonly Access[];

export type TableReach = OwnedTable & { readonly access: Access };

const keyOf = ({ owner, table }: OwnedTable): string => `${owner}\0${table}`;

// The tables another feature owns that a file names at run time, whether or not they are written.
function referencedOutside(ctx: TableContext, file: TabledFile, place: Place): OwnedTable[] {
  const own = place.kind === "feature" ? place.feature : null;
  return file.tableFacts.references.flatMap(({ source, table }) => {
    const owner = ownerOf(ctx, file, source);
    return owner === null || owner === own ? [] : [{ owner, table }];
  });
}

// Every table of another feature's that a file reaches, once per owner and table, each with the
// strongest access it has. Its writes are B23's own function, so the view and the gate cannot drift.
// A name an owner's tables file exports that is no table (an enum, a schema object) is the caller's
// to drop: only the owner's tables file says what it declares.
export function reachOf(ctx: TableContext, file: TabledFile, place: Place): TableReach[] {
  if (!judgesTables(ctx.zoning)) return [];
  const writes = outsideWrites(ctx, file, place);
  const written = new Set(writes.map(keyOf));
  const tablesFile = place.kind === "feature" && place.zone.rule.declaresTables;
  const reached = new Map<string, OwnedTable>();
  for (const named of [...writes, ...referencedOutside(ctx, file, place)]) {
    reached.set(keyOf(named), named);
  }
  return [...reached.values()].map((named) => {
    const holds: Record<Access, boolean> = {
      write: written.has(keyOf(named)),
      "foreign-key": tablesFile,
      read: true,
    };
    return { ...named, access: STRONGEST_FIRST.find((access) => holds[access]) ?? "read" };
  });
}
