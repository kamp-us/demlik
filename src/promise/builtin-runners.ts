/**
 * The Promise engine's built-in sub runners (#270 R1.1). A machine declares a
 * built-in Sub by type alone — `{ type: "timer", deps: (s) => ({ ms, msg }) }`
 * — and `run` starts it with the runner here unless `subscribe` names one of
 * the same type, which replaces it (#270 R2.1).
 */

import type { BuiltinSubType, Dispose, TimerSub } from "../pure/core";

/**
 * `timer`: dispatch `deps.msg` once, `deps.ms` after the Sub starts. The engine
 * restarts it when `ms` or `msg` changes and clears it when the Sub stops.
 */
function timer<M>(
  sub: TimerSub<M>,
  _ctx: unknown,
  dispatch: (msg: M) => void,
): Dispose {
  const handle = setTimeout(() => dispatch(sub.deps.msg), sub.deps.ms);
  return () => clearTimeout(handle);
}

/** Every built-in runner, keyed by the Sub type it runs. */
export const builtinRunners = { timer } as const satisfies Record<
  BuiltinSubType,
  unknown
>;
