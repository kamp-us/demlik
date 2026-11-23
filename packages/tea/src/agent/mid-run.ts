/**
 * @demlik/tea/agent — which runs a restored Model re-enters through `agent_boot`.
 *
 * NOT part of the public `./agent` barrel: `defineAgent` reads it to choose
 * between `agent_start` and `agent_boot`, `@demlik/tea/do` reads it to choose
 * whether a cold wake dispatches `agent_boot`, and `createAgent` reads it to
 * decide whether a Model without its domain slice is seeded or refused. One
 * table answers all three, so no two of them can disagree about a run.
 */

import { type AgentState, type AgentStatus, status } from "./types";

/**
 * Per {@link AgentStatus} kind, whether a restored run is mid-flight: its
 * outstanding model call, compaction or tool calls are reissued by `agent_boot`.
 * `running` is in the table because a run lost during its model call or its
 * compaction restores as `running`, with those calls still owed. `satisfies`
 * makes a new status kind a compile error here.
 */
const MID_RUN = {
  idle: false,
  running: true,
  suspended: true,
  done: false,
  failed: false,
  cancelled: false,
} satisfies Record<AgentStatus<unknown>["kind"], boolean>;

/**
 * Whether a restored agent Model is mid-flight and `agent_boot` reissues its one
 * outstanding operation. Reads `status`, which already puts a failure annotation
 * ahead of the run phase and reads a `stale` run as `running`. An `agent_start`
 * for such a run would mint a new `runId` and a fresh conversation over the work
 * already done, which is a restart, and neither host ever restarts a run it
 * restored. PURE.
 */
export function isMidRun<
  Stage,
  P extends string,
  O extends Record<P, unknown>,
  R,
>(state: AgentState<Stage, P, O, R>): boolean {
  return MID_RUN[status(state).kind];
}
