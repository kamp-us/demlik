// ---------------------------------------------------------------------------
// msgTypeKeys — read the Msg discriminant set at runtime from a Reducer
// record or a Transitions table.
//
// TS Msg unions only exist at the type level; the discriminant strings are
// erased at runtime. The reducer record / transitions table is the load-
// bearing artifact that DOES carry the discriminants at runtime — its keys
// (for Reducer) or any one cell's inner keys (for Transitions) are exactly
// the set we need to build an `arbMsg` table without hand-listing them.
//
// Used by `arbMsg` to assert (in dev) that the user-supplied table covers
// every Msg variant the reducer claims to handle. Strict drift detection
// without runtime introspection of the type system.
// ---------------------------------------------------------------------------

import type { Cmd, Reducer, Transitions } from "../../index";

/**
 * Extract the Msg discriminant set at runtime from a Reducer record or a
 * Transitions table. Useful for asserting that a user-supplied
 * `MsgArbitraryTable<M>` covers every variant the reducer can handle.
 *
 * - **Reducer form** — keys of the top-level record ARE the Msg variants.
 * - **Transitions form** — keys of any single state's inner record. Every
 *   state's inner record must cover every Msg variant (mapped-type
 *   discipline), so reading the first state's keys is equivalent to reading
 *   the union.
 *
 * @example
 *   import { auditBackgroundMachine } from "./reducer";
 *   msgTypeKeys(auditBackgroundMachine.update);
 *   // → ["start_audit", "stop_audit", "window_created", ...]
 */
export function msgTypeKeys<S, M extends { type: string }, C extends Cmd>(
  update: Reducer<S, M, C> | ([S] extends [{ type: string }] ? Transitions<S, M, C> : never),
): readonly string[] {
  const keys = Object.keys(update as object);
  if (keys.length === 0) return [];
  // Reducer form: every top-level value is a function (the cell).
  // Transitions form: every top-level value is an object (the inner record).
  // `keys[0]` is present — the length guard above rules out the empty record.
  const firstValue = (update as Record<string, unknown>)[keys[0]!];
  if (typeof firstValue === "function") {
    return keys;
  }
  // Transitions form — read inner record.
  return Object.keys(firstValue as object);
}
