import type { TellAnswer } from "../internal/engine/loop";
import { tellRun } from "../internal/engine/tell";
import type { Cmd, Machine, Sub } from "../pure/core";
import type { Runtime } from "../runtime-types";

export type { TellAnswer } from "../internal/engine/loop";

/**
 * Put `msg` on a run's line and return at once. The answer means queued, not
 * handled: the receiver's step has not run yet, and any result comes back later
 * as its own Msg. So two machines can tell each other from their Cmd handlers
 * and neither stops. `machine` is the machine `runtime` runs.
 *
 * The answer is `"queued"`, `"stopped"` for a run that is stopping or has
 * stopped, or `"no_cell"` when its current State has no cell for the Msg. Msgs
 * already in line have not folded yet, so a Msg that only a queued one makes
 * acceptable answers `"no_cell"`.
 *
 * A handle that did not come from `run` has no line to put a Msg on, so `tell`
 * throws, though the type accepts it. A spread of a real handle keeps its line;
 * a plain object built by hand does not.
 *
 * What happens after `"queued"` is the receiver's. Two `tell`s from one sender
 * fold in the order they were sent. A failed save or a handler's throw goes to
 * the receiver's `onError`, never back to the sender. A Msg whose cell is gone
 * by its turn is dropped without a word, and a `stop()` that gives up drops
 * what is still in line and counts it, per Msg type, in its
 * `DrainTimeoutNotice`.
 *
 * Two hand-written `await runtime.dispatch(...)` calls into each other, one from
 * each machine's Cmd handler, still stop both machines: `dispatch` waits, and
 * tea has no lock-up detector. Use `tell` there.
 *
 * ```ts
 * const answer = tell(parent, parentRun, { type: "child_result", id });
 * ```
 */
export function tell<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
  E extends { type: string } = never,
>(
  machine: Machine<S, M, C, U, Ctx>,
  runtime: Runtime<S, M, E>,
  msg: NoInfer<M>,
): TellAnswer {
  return tellRun<S, M>(machine, runtime, msg);
}
