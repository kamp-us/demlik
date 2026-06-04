/**
 * @demlik/tea/rate-limit — two rate limiters as pure state + ops.
 *
 * Same shape as `@demlik/tea/work-queue`'s `ops.ts`: a state type plus pure
 * transition functions. Host-agnostic by construction — no `Date.now()`, no
 * timers, no I/O. The caller injects the clock (`nowMs`) and wires the result
 * into its own reducer / interpret. This keeps the limiters inside TEA's
 * invariant 2 (transitions are pure: same inputs → same outputs, no `Date.now`)
 * so a consumer can fold them through `update` and exercise them with `replay`
 * / the pbt fold without a fake clock.
 *
 * Every op returns a NEW state value and never mutates its input (invariant 1 —
 * state is a value, not a place). The `tryConsume` / `record` ops return a
 * `[next, ok]` tuple so the caller branches on the decision while threading the
 * advanced state forward; `refill` / `remaining` are read-shaped helpers.
 *
 * Two complementary algorithms, picked by the cost the caller wants to pay:
 *
 *   - **Token bucket** — O(1) state (four numbers), smooths bursts against a
 *     steady refill rate. Allows a burst up to `capacity`, then throttles to
 *     `refillPerSec`. Cheapest; the default choice.
 *   - **Sliding window log** — O(limit) state (one timestamp per in-window
 *     hit), exact "no more than `limit` events per `windowMs`". Pay the memory
 *     for precise window edges when a token bucket's continuous refill would
 *     let through too many at a boundary.
 *
 * NOT exported from the package root — reached via the `@demlik/tea/rate-limit`
 * subpath, same one-shape-per-package rule as `work-queue` and `do`.
 */

// ===========================================================================
// Token bucket
// ===========================================================================

/**
 * A token bucket: `tokens` of `capacity` available now, replenished at
 * `refillPerSec` tokens per second. `lastRefillMs` is the clock reading at
 * which `tokens` was last computed — `refill` advances it. All four fields are
 * plain numbers so the whole bucket is trivially JSON-serializable into a
 * consumer's `Store<S>`.
 */
export interface TokenBucket {
  readonly tokens: number;
  readonly capacity: number;
  readonly refillPerSec: number;
  readonly lastRefillMs: number;
}

/**
 * Create a full bucket. Starts at `capacity` tokens (the conventional "a fresh
 * limiter lets the first burst through" behavior) and stamps `lastRefillMs`
 * with the caller's clock so the first `refill` measures elapsed time from
 * boot, not from epoch 0.
 */
export function initBucket(
  capacity: number,
  refillPerSec: number,
  nowMs: number,
): TokenBucket {
  return {
    tokens: capacity,
    capacity,
    refillPerSec,
    lastRefillMs: nowMs,
  };
}

/**
 * Add the tokens accrued since `lastRefillMs`, clamped to `capacity`, and
 * advance `lastRefillMs` to `nowMs`. PURE — returns a new bucket; the input is
 * untouched.
 *
 * A `nowMs` at or before `lastRefillMs` (clock not advanced, or skewed
 * backwards) adds a non-positive amount; `Math.max(0, …)` floors the elapsed
 * term so a backwards clock can never *remove* tokens. `lastRefillMs` still
 * advances to `nowMs` so the bucket tracks the latest reading the caller
 * presented — the next forward step measures from there, not from a stale
 * future timestamp.
 */
export function refill(bucket: TokenBucket, nowMs: number): TokenBucket {
  const elapsedSec = Math.max(0, nowMs - bucket.lastRefillMs) / 1000;
  const replenished = bucket.tokens + elapsedSec * bucket.refillPerSec;
  return {
    ...bucket,
    tokens: Math.min(bucket.capacity, replenished),
    lastRefillMs: nowMs,
  };
}

/**
 * Refill against `nowMs`, then attempt to take `n` tokens (default 1).
 *
 * On success returns `[next, true]` with `n` subtracted; on failure returns
 * `[refilled, false]` — the refilled bucket (so the caller keeps the advanced
 * clock + accrued tokens) with no tokens spent. Branch on the boolean, thread
 * the bucket forward regardless:
 *
 *   const [b1, ok] = tryConsume(bucket, nowMs);
 *   return ok ? [{ ...state, bucket: b1 }, [doWork]] : [{ ...state, bucket: b1 }, []];
 *
 * PURE — input bucket is never mutated.
 */
export function tryConsume(
  bucket: TokenBucket,
  nowMs: number,
  n = 1,
): readonly [TokenBucket, boolean] {
  const refilled = refill(bucket, nowMs);
  if (refilled.tokens >= n) {
    return [{ ...refilled, tokens: refilled.tokens - n }, true];
  }
  return [refilled, false];
}

// ===========================================================================
// Sliding window log
// ===========================================================================

/**
 * A sliding-window log: the timestamps of every hit still inside the trailing
 * `windowMs`, capped at `limit` events per window. `hits` is `readonly` and
 * kept oldest-first (pruning slices the stale prefix off the front, recording
 * appends to the back), so the array is its own sorted index. Exact at the
 * window edge — unlike a token bucket's continuous refill, a hit leaves the
 * count the instant it ages past `windowMs`.
 */
export interface SlidingWindow {
  readonly hits: readonly number[];
  readonly windowMs: number;
  readonly limit: number;
}

/** Create an empty window. No hits recorded yet. */
export function initWindow(windowMs: number, limit: number): SlidingWindow {
  return { hits: [], windowMs, limit };
}

/**
 * Prune hits older than `nowMs - windowMs`, then record `nowMs` if there is
 * room. Returns `[next, true]` with the hit appended when `hits.length < limit`
 * after pruning, else `[pruned, false]` — the pruned window (capacity recovers
 * as old hits age out) with nothing appended.
 *
 * The cutoff is half-open: a hit exactly `windowMs` old is pruned (`<= cutoff`
 * drops it), so a hit recorded at `t` no longer counts at `t + windowMs`. That
 * makes the window's capacity fully recover `windowMs` after the last hit, the
 * behavior tests pin.
 *
 * PURE — input window is never mutated; `hits` is rebuilt by `filter` +
 * spread.
 */
export function record(
  window: SlidingWindow,
  nowMs: number,
): readonly [SlidingWindow, boolean] {
  const cutoff = nowMs - window.windowMs;
  const pruned = window.hits.filter((t) => t > cutoff);
  if (pruned.length < window.limit) {
    return [{ ...window, hits: [...pruned, nowMs] }, true];
  }
  return [{ ...window, hits: pruned }, false];
}

/**
 * How many more hits `record` would accept at `nowMs` without blocking —
 * `limit` minus the live (post-prune) hit count, floored at 0. Read-only: it
 * prunes a local copy to answer but returns no new window. Use it to render a
 * "N requests remaining" affordance without committing a hit.
 */
export function remaining(window: SlidingWindow, nowMs: number): number {
  const cutoff = nowMs - window.windowMs;
  const live = window.hits.filter((t) => t > cutoff).length;
  return Math.max(0, window.limit - live);
}
