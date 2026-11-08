import type { Place } from "../rules.js";
import {
  judgesTables,
  type OwnedTable,
  outsideWrites,
  ownedOutside,
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

// Every way a file reaches a table another feature owns, once per owner and table, each with the
// strongest access it has. Its writes are B23's own function, and every table is named through the
// one follower, so the view and the gate cannot drift. A name an owner's tables file exports that is
// no table (an enum, a schema object) is the caller's to drop: only the owner's tables file says what
// it declares.
export function reachOf(ctx: TableContext, file: TabledFile, place: Place): TableReach[] {
  if (!judgesTables(ctx.zoning)) return [];
  const writes = outsideWrites(ctx, file, place);
  const written = new Set(writes.map(keyOf));
  const tablesFile = place.kind === "feature" && place.zone.rule.declaresTables;
  const reached = new Map<string, OwnedTable>();
  const named = ownedOutside(ctx, file, place, file.tableFacts.references);
  for (const table of [...writes, ...named]) reached.set(keyOf(table), table);
  return [...reached.values()].map((table) => {
    const holds: Record<Access, boolean> = {
      write: written.has(keyOf(table)),
      "foreign-key": tablesFile,
      read: true,
    };
    return { ...table, access: STRONGEST_FIRST.find((access) => holds[access]) ?? "read" };
  });
}
