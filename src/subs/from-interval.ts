// ---------------------------------------------------------------------------
// fromInterval — universal `setInterval`-shaped Sub factory.
//
// The recurring shape at every `subscribe[type]` cell that wraps a periodic
// timer is the same five lines: `setInterval` the dispatch, return a
// `clearInterval` cleanup. The factory absorbs both halves of the lifecycle
// (subscribe + cleanup); the caller keeps the intent — which Sub variant,
// which Msg to dispatch.
//
// Timing data (`intervalMs`) lives on the Sub itself, not in the closure.
// The substrate already reconciles Subs by id on every transition; carrying
// the period on the Sub means a `subscriptions(state)` function that
// returns `{ id, type, intervalMs: 30_000 }` in one state and the same id
// with `intervalMs: 60_000` later... will NOT re-wire the interval (the id
// is unchanged, the reconcile pass leaves it running). That's a tradeoff
// the substrate's reconcile contract pins, not this factory — if you want
// the interval to change, change the Sub's id too.
//
// Strengthens invariant 9 (named, small surface) and invariant 2 (the Sub
// carries the data; the lifecycle is in the factory; the reducer never
// sees the timer).
// ---------------------------------------------------------------------------

import type { Sub } from "../index";
import type { SubscribeHandler } from "./types";

type IntervalSubData = { intervalMs: number };

export function fromInterval<S extends Sub & IntervalSubData, M>(
  msgFn: (sub: S) => M,
): SubscribeHandler<S, M, unknown> {
  return (sub, _ctx, dispatch) => {
    const handle = setInterval(() => {
      dispatch(msgFn(sub));
    }, sub.intervalMs);
    return () => {
      clearInterval(handle);
    };
  };
}
