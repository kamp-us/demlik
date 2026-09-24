// ---------------------------------------------------------------------------
// fromInterval — universal `setInterval`-shaped Sub factory.
//
// The recurring shape at every runner that wraps a periodic timer is the
// same five lines: `setInterval` the dispatch, return a `clearInterval`
// cleanup. The factory absorbs both halves of the lifecycle (subscribe +
// cleanup); the caller keeps the intent — which Sub type, which Msg to
// dispatch.
//
// Timing data (`intervalMs`) lives in the Sub's `deps`, not in the closure.
// The engine derives the Sub's id from its deps, so a `deps` that returns
// `{ intervalMs: 30_000 }` in one state and `{ intervalMs: 60_000 }` later is
// a new id: the engine stops the old interval and starts one at the new
// period. An unchanged deps value leaves the running interval alone.
//
// Strengthens invariant 9 (named, small surface) and invariant 2 (the Sub
// carries the data; the lifecycle is in the factory; the reducer never
// sees the timer).
// ---------------------------------------------------------------------------

import type { Sub } from "../index";
import type { SubscribeHandler } from "./types";

type IntervalSubData = { readonly intervalMs: number };

export function fromInterval<S extends Sub<string, IntervalSubData>, M>(
  msgFn: (sub: S) => M,
): SubscribeHandler<S, M, unknown> {
  return (sub, _ctx, dispatch) => {
    const handle = setInterval(() => {
      dispatch(msgFn(sub));
    }, sub.deps.intervalMs);
    return () => {
      clearInterval(handle);
    };
  };
}
