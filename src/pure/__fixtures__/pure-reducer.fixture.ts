/**
 * False-positive control for `reducer-purity.test.ts` (#228). PURE: every cell
 * reads ids/timestamps that arrived AS Msg payload (frozen, pure to read), and
 * the one `new Date("…")` constructs a known instant deterministically. The
 * guard MUST flag NOTHING here — this is the zero-false-positives proof.
 */

import type { Reducer } from "../core";

type State = { readonly id: string; readonly at: number };

type Msg =
  | { readonly type: "spawned"; readonly id: string; readonly at: number }
  | { readonly type: "reset" };

export const pureUpdate: Reducer<State, Msg, never> = {
  // ids/timestamps from Msg payload are pure to read — permitted, not flagged.
  spawned: (s, m) => [{ ...s, id: m.id, at: m.at }, []],
  // a constant Date is deterministic — the zero-arg `new Date()` is the only
  // banned construction form, so this must not register.
  reset: (s) => [{ ...s, at: new Date("2026-01-01T00:00:00Z").getTime() }, []],
};
