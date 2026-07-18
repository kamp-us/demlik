// ---------------------------------------------------------------------------
// msgTypeKeys — read the Msg discriminant set at runtime from a machine's
// Reducer record or Transitions table.
//
// TS Msg unions only exist at the type level; the discriminant strings are
// erased at runtime. The reducer record / transitions table is the load-
// bearing artifact that DOES carry the discriminants at runtime — its keys
// (for Reducer) or any one cell's inner keys (for Transitions) are exactly
// the set we need to build an `arbMsg` table without hand-listing them.
//
// Standalone helper: hand it a machine and it returns the Msg variants the
// reducer/transitions record carries at runtime. `arbMsg` does NOT call it —
// `MsgArbitraryTable<M>` enforces table coverage at compile time (adding a
// variant without an arbitrary fails to compile, not at runtime). This helper
// is for callers that want the discriminant set explicitly at runtime — e.g.
// a test asserting a table covers every variant.
// ---------------------------------------------------------------------------

import {
  type Cmd,
  msgKeysOf,
  type Reducer,
  type Transitions,
  type UpdateForm,
} from "../../index";

/**
 * Extract the Msg discriminant set at runtime from a machine. Useful for
 * asserting that a user-supplied `MsgArbitraryTable<M>` covers every variant
 * the reducer can handle.
 *
 * Takes the MACHINE (not the bare `update` record) so the reducer-vs-
 * transitions branch honors the authoritative `__form` tag via `msgKeysOf` —
 * the same classification production `run` uses (#275).
 *
 * - **Reducer form** — keys of the top-level record ARE the Msg variants.
 * - **Transitions form** — keys of any single state's inner record. Every
 *   state's inner record must cover every Msg variant (mapped-type
 *   discipline), so reading the first state's keys is equivalent to reading
 *   the union.
 *
 * @example
 *   import { auditBackgroundMachine } from "./reducer";
 *   msgTypeKeys(auditBackgroundMachine);
 *   // → ["start_audit", "stop_audit", "window_created", ...]
 */
export function msgTypeKeys<
  S,
  M extends { type: string },
  C extends Cmd,
>(machine: {
  update:
    | Reducer<S, M, C>
    | ([S] extends [{ type: string }] ? Transitions<S, M, C> : never);
  __form?: UpdateForm;
}): readonly string[] {
  return msgKeysOf(machine);
}
