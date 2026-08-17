// The end-to-end proof: the compiled table drops into the REAL `defineMachine`
// with no cast, no annotation, and no adapter.
import type { Cmd, Machine, Sub } from "../pure/core";
import { defineMachine } from "../runtime-types";
import { type Assert, type Eq } from "./graph";
import { type LaneCmd, type LaneMsgIn, type LaneState, region } from "./lane";

type NS = "ISSUE_42";
type M = LaneMsgIn<NS>;

export const laneMachine = defineMachine<
  LaneState,
  M,
  LaneCmd,
  Sub<never>,
  Record<never, never>
>({
  init: (loaded) => [loaded ?? { type: "queued", retries: 0, maxRetries: 2 }, []],
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
