// ---------------------------------------------------------------------------
// fromTimeout — universal `setTimeout`-shaped Sub factory.
//
// Same lifecycle shape as `fromInterval` minus the recurrence: the
// scheduled callback fires once, the cleanup is `clearTimeout`. For the
// common case — fire one Msg after a delay — the engine's built-in `timer`
// Sub (`{ type: "timer", deps: (s) => cond ? { ms, msg } : null }`) needs no
// runner at all; reach for this factory when the Msg is built from the Sub
// rather than carried in its deps. Two observable consequences worth pinning:
//
//   1. The timer fires once per start. It does NOT re-arm while the Sub
//      stays on with the same deps — the engine leaves an unchanged Sub
//      running, and the handle is exhausted. A changed deps value (a new
//      `delayMs`, or any other field) is a new id, so the engine stops this
//      runner and starts a fresh one: that is how to re-arm.
//
//   2. Cleanup before the timer fires cancels the pending dispatch. This
//      is the "cancel on state exit" pattern: gate the Sub's `deps` on the
//      state where the timeout should be armed. When the state leaves it,
//      `deps` goes null, the engine stops the Sub, and the factory's
//      cleanup fires before the timer does.
// ---------------------------------------------------------------------------

import type { Sub } from "../index";
import type { SubscribeHandler } from "./types";

type TimeoutSubData = { readonly delayMs: number };

export function fromTimeout<S extends Sub<string, TimeoutSubData>, M>(
  msgFn: (sub: S) => M,
): SubscribeHandler<S, M, unknown> {
  return (sub, _ctx, dispatch) => {
    const handle = setTimeout(() => {
      dispatch(msgFn(sub));
    }, sub.deps.delayMs);
    return () => {
      clearTimeout(handle);
    };
  };
}
