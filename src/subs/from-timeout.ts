// ---------------------------------------------------------------------------
// fromTimeout — universal `setTimeout`-shaped Sub factory.
//
// Same lifecycle shape as `fromInterval` minus the recurrence: the
// scheduled callback fires once, the cleanup is `clearTimeout`. Two
// observable consequences worth pinning explicitly:
//
//   1. The Sub stays in the desired set until the caller removes it from
//      `subscriptions(state)`. The substrate's reconcile pass does NOT
//      auto-remove a Sub on cleanup — the timer fires, the callback
//      dispatches its Msg, and if the Sub is still present on the next
//      transition's desired set, the factory will... NOT re-fire. The
//      timer handle is captured per-subscribe call; after it fires, the
//      handle is exhausted. Adding the same Sub a second time (via a new
//      id) is the only way to re-arm.
//
//   2. Cleanup before the timer fires cancels the pending dispatch. This
//      is the "cancel on state exit" pattern: model the timeout as a Sub
//      whose `subscriptions(state)` returns it only in the state where the
//      timeout should be armed. When the state changes, the substrate's
//      reconcile drops the Sub and the factory's cleanup fires before the
//      timer does.
//
// Like `fromInterval`, the delay lives on the Sub (`delayMs`) — same id
// means same scheduled timeout; changing the delay requires a new id.
// ---------------------------------------------------------------------------

import type { Sub } from "../index";
import type { SubscribeHandler } from "./types";

type TimeoutSubData = { delayMs: number };

export function fromTimeout<S extends Sub & TimeoutSubData, M>(
  msgFn: (sub: S) => M,
): SubscribeHandler<S, M, unknown> {
  return (sub, _ctx, dispatch) => {
    const handle = setTimeout(() => {
      dispatch(msgFn(sub));
    }, sub.delayMs);
    return () => {
      clearTimeout(handle);
    };
  };
}
