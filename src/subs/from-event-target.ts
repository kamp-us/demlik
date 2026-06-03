// ---------------------------------------------------------------------------
// fromEventTarget — universal addEventListener/removeEventListener Sub
// factory over any `EventTarget` (DOM nodes, `window`, `document`,
// `BroadcastChannel`, `MessagePort`, `Worker`, `ServiceWorker`, etc.).
//
// Two non-obvious shape choices:
//
//   - `getTarget: () => EventTarget` is a thunk, not a direct value. The
//     factory MUST work in environments where the target is not available
//     at module-load time — service workers run before any `document`
//     exists; some targets are constructed lazily from `ctx`. Deferring
//     the lookup to subscribe time also means a state-driven swap of the
//     target requires only a new Sub.id; the factory pulls the current
//     target on subscribe.
//
//   - `msgFn` may return `null` — that emission is *dropped*. The event
//     fired, the factory called `msgFn`, but the caller decided "this
//     event is not interesting given current state." No dispatch is made;
//     the listener stays armed for the next event. This is the explicit
//     filter point at the Sub boundary — the alternative (filtering inside
//     the reducer via a noop cell) costs a transition + reconcile pass per
//     filtered event.
//
// Cleanup uses the SAME `getTarget()` instance captured at subscribe time
// so a target swap mid-Sub doesn't leak the listener on the old target.
// We close over the resolved target rather than calling `getTarget()`
// again at cleanup — the alternative (re-resolving) is the cause of
// silent listener leaks in long-lived runtimes.
// ---------------------------------------------------------------------------

import type { Sub } from "../index";
import type { MinimalEvent, MinimalEventTarget } from "./platform";
import type { SubscribeHandler } from "./types";

export function fromEventTarget<S extends Sub, M>(
  getTarget: () => MinimalEventTarget,
  eventName: string,
  msgFn: (event: MinimalEvent, sub: S) => M | null,
): SubscribeHandler<S, M, unknown> {
  return (sub, _ctx, dispatch) => {
    const target = getTarget();
    const listener = (event: MinimalEvent): void => {
      const msg = msgFn(event, sub);
      if (msg !== null) dispatch(msg);
    };
    target.addEventListener(eventName, listener);
    return () => {
      target.removeEventListener(eventName, listener);
    };
  };
}
