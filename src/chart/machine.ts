// The end-to-end proof: the compiled table drops into the REAL `defineMachine`
// with no cast, no annotation, and no adapter.
import type { Cmd, Machine, Sub } from "../pure/core";
import { defineMachine } from "../runtime-types";
import { initFrom } from "./compile";
import { type Assert, type Eq, type InitialState } from "./graph";
import {
  type LaneCmd,
  type LaneG,
  type LaneMsgIn,
  type LaneState,
  lane,
  region,
} from "./lane";

// ═══════════════════════════════════════════════════════════════════════════
// SUBS ARE OUT OF SCOPE — deliberately, not by omission.
//
// `subscriptions(state) => Sub[]` looks like a per-state list the graph could
// own, but a `Sub` is `{ id: SubId; type: string }` and the substrate
// reconciles on the ID, not on the state name. The id is a projection of the
// state's DATA (`subId(\`ws:${state.auditId}\`)`) — the exact thing the graph
// does not and should not know; the graph owns names and edges, and every
// payload projection off state data already lives in a hand-written part. So a
// config could at best declare "sub type `ws` is live in states X and Y", and
// the author would STILL hand-write the id/payload builder per state — the
// switch he was already writing, now split across two files, with the
// reconcile semantics (dep-keyed re-arm, `Dispose` ordering) hidden behind a
// declaration that no longer shows them. That is negative value: more
// machinery, the same hand-written code, and a live host resource whose
// lifecycle got less legible. `subscriptions` stays hand-written.
// ═══════════════════════════════════════════════════════════════════════════

type NS = "ISSUE_42";
type M = LaneMsgIn<NS>;

export const laneMachine = defineMachine<
  LaneState,
  M,
  LaneCmd,
  Sub<never>,
  Record<never, never>
>({
  // ← DERIVED. The author supplies the entry state's DATA; the state NAME and
  //   the `loaded ?? …` rehydrate branch come from the graph's `initial: true`.
  init: initFrom<LaneG, LaneState, LaneCmd>(lane, () => ({
    retries: 0,
    maxRetries: 2,
  })),
  // ← the compiled table, verbatim. No `as`, no `satisfies`.
  update: region("ISSUE_42"),
});

export type B1 = Assert<
  Eq<
    typeof laneMachine,
    Machine<LaneState, M, LaneCmd, Sub<never>, Record<never, never>>
  >
>;
export type B2 = Assert<Eq<LaneCmd, Cmd<never>>>;
// the entry state is a derivation off the graph, not a hand-written literal
export type B3 = Assert<Eq<InitialState<LaneG>, "queued">>;
