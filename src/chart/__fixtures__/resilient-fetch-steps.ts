// ═══════════════════════════════════════════════════════════════════════════
// THE MESSAGE SEQUENCE both `resilient-fetch` equivalence suites drive.
//
// Shared because there are now TWO ports of `examples/resilient-fetch.ts` — the
// flat `defineReducerChart` form and the grid `defineChart` form — and an
// equivalence claim about "the ports" is only as strong as its WEAKER sequence.
// One list, driven twice, means neither port can be proven against an easier
// walk than the other.
//
// The sequence is built to REACH the forks, not merely to run. `attempt()`
// composes four modules and picks one of five next states; the fork nobody had
// reached was the rate-limit one, because the circuit breaker trips on the
// failure ladder FIRST and `canPass` then short-circuits before `tryConsume` is
// ever called. So the bucket is drained EARLY — while the breaker is still
// closed and the retry counter still fresh — and only then does the failure
// ladder run.
// ═══════════════════════════════════════════════════════════════════════════
import { subId } from "../../pure/core";

export type AnyMsg = { readonly type: string; readonly [k: string]: unknown };
export type Step = readonly [label: string, msg: AnyMsg];

export const T0 = 1_000_000;
export const U = "https://api.example/thing";

// The bucket is `initBucket(10, 5, 0)`: 10 tokens, refilling 5/sec. Firing 1ms
// apart accrues 0.005 tokens per step, so a run of 14 empties it with room to
// spare and then keeps asking — which is the only way to reach BOTH rate-limit
// arms (`shouldRetry` true → `waiting_retry`, then false → `failed`).
const DRAIN = 14;

/** One walk from a FRESH `init` on both machines. */
export type Walk = { readonly name: string; readonly steps: readonly Step[] };

const main: readonly Step[] = [
  // a timer that fires before anything started — the phase-conditioned no-op
  [
    "deadline before start",
    { type: "deadline_exceeded", id: subId("retry"), atMs: T0 },
  ],
  ["fetch", { type: "fetch", url: U, at: T0 }],
  ["fetch_ok", { type: "fetch_ok", url: U, body: "hello", at: T0 + 50 }],
  // ── the rows a happy path skips: `succeeded` and `waiting_retry` are states
  // like any other, and each owes an answer to all three run events.
  [
    "succeeded -fetch_ok-> succeeded",
    { type: "fetch_ok", url: U, body: "hello", at: T0 + 60 },
  ],
  [
    "succeeded -fetch_err-> waiting_retry",
    { type: "fetch_err", url: U, error: "s-boom", at: T0 + 70 },
  ],
  [
    "waiting_retry -fetch_err-> waiting_retry",
    { type: "fetch_err", url: U, error: "w-boom", at: T0 + 80 },
  ],
  [
    "waiting_retry -fetch_ok-> succeeded",
    { type: "fetch_ok", url: U, body: "hello", at: T0 + 90 },
  ],
  // served from cache this time — no cmd at all
  ["fetch (cache hit)", { type: "fetch", url: U, at: T0 + 100 }],
  // a different url misses the cache and spends a token
  ["fetch other", { type: "fetch", url: `${U}/b`, at: T0 + 200 }],

  // ── THE RATE-LIMIT FORK, reached first and deliberately ──────────────────
  // The breaker is still closed here (no `fetch_err` has landed), so `canPass`
  // lets every one of these through to `tryConsume`. The bucket empties partway
  // in; from then on each step takes a rate-limit arm — `waiting_retry` while
  // `shouldRetry` still permits an attempt, then `failed` once the retry budget
  // is spent ("rate limited; out of retries").
  ...Array.from(
    { length: DRAIN - 1 },
    (_, i): Step => [
      `drain ${i + 1}`,
      { type: "fetch", url: `${U}/d${i}`, at: T0 + 300 + i },
    ],
  ),
  // the retry timer armed by a RATE-LIMITED wait, fired while still parked in
  // `waiting_retry`: re-enters `attempt` from `deadline_exceeded` with an empty
  // bucket, so the rate-limit fork is reached through the OTHER cell
  // (`retryNow`, one site) as well as through `attempt`'s six.
  [
    "deadline while rate-limited",
    { type: "deadline_exceeded", id: subId("retry"), atMs: T0 + 320 },
  ],
  [
    `drain ${DRAIN}`,
    { type: "fetch", url: `${U}/d${DRAIN - 1}`, at: T0 + 330 },
  ],
  // a success clears the rate-limit streak: `retry` back to `initRetry()`, the
  // breaker nudged closed, the body cached.
  [
    "fetch_ok clears the streak",
    { type: "fetch_ok", url: `${U}/d0`, body: "drained", at: T0 + 500 },
  ],

  // ── THE FAILURE LADDER, run to exhaustion ────────────────────────────────
  // 3.5s of quiet refills the bucket (5/sec, capacity 10) so these steps are
  // gated by the RETRY policy and the BREAKER, not by tokens — every one of them
  // draws from the RNG, which is what makes the two machines' agreement mean
  // "same number of draws, same order".
  ["fetch again", { type: "fetch", url: `${U}/c`, at: T0 + 4_000 }],
  [
    "fetch_err 1",
    { type: "fetch_err", url: `${U}/c`, error: "boom-1", at: T0 + 4_100 },
  ],
  [
    "deadline -> retry",
    { type: "deadline_exceeded", id: subId("retry"), atMs: T0 + 4_200 },
  ],
  [
    "fetch_err 2",
    { type: "fetch_err", url: `${U}/c`, error: "boom-2", at: T0 + 4_300 },
  ],
  [
    "deadline -> retry",
    { type: "deadline_exceeded", id: subId("retry"), atMs: T0 + 4_700 },
  ],
  [
    "fetch_err 3",
    { type: "fetch_err", url: `${U}/c`, error: "boom-3", at: T0 + 4_800 },
  ],
  [
    "deadline -> retry",
    { type: "deadline_exceeded", id: subId("retry"), atMs: T0 + 5_600 },
  ],
  [
    "fetch_err 4",
    { type: "fetch_err", url: `${U}/c`, error: "boom-4", at: T0 + 5_700 },
  ],
  [
    "deadline -> retry",
    { type: "deadline_exceeded", id: subId("retry"), atMs: T0 + 6_800 },
  ],
  [
    "fetch_err 5",
    { type: "fetch_err", url: `${U}/c`, error: "boom-5", at: T0 + 6_900 },
  ],
  [
    "fetch_err 6",
    { type: "fetch_err", url: `${U}/c`, error: "boom-6", at: T0 + 7_000 },
  ],
  [
    "fetch_err 7",
    { type: "fetch_err", url: `${U}/c`, error: "boom-7", at: T0 + 7_100 },
  ],

  // ── adversarial: does a spent machine still absorb traffic identically? ───
  [
    "deadline after failed",
    { type: "deadline_exceeded", id: subId("retry"), atMs: T0 + 8_000 },
  ],
  // the breaker is open by now, so this is the `circuit_open` arm of `attempt`
  [
    "fetch while breaker open",
    { type: "fetch", url: `${U}/e`, at: T0 + 8_100 },
  ],
  // …and `circuit_open` owes an answer to all three run events too. The
  // breaker's cooldown is 30s, so it is still open for every step below.
  [
    "circuit_open -fetch-> circuit_open",
    { type: "fetch", url: `${U}/e2`, at: T0 + 8_110 },
  ],
  [
    "circuit_open -fetch_err->",
    { type: "fetch_err", url: `${U}/e2`, error: "c-boom", at: T0 + 8_120 },
  ],
  [
    "fetch while breaker still open",
    { type: "fetch", url: `${U}/e3`, at: T0 + 8_130 },
  ],
  [
    "fetch_ok late",
    { type: "fetch_ok", url: `${U}/e`, body: "late", at: T0 + 8_200 },
  ],
  [
    "deadline after everything",
    { type: "deadline_exceeded", id: subId("retry"), atMs: T0 + 9_000 },
  ],
];

/**
 * `idle` is the one state a walk can only ask ONE question of: nothing targets
 * it, so once the first message lands it is never entered again. Its other two
 * rows therefore need their own walks from a fresh `init` — which is also the
 * only way `idle.fetch_err`'s retry arm is ever seen.
 */
export const walks: readonly Walk[] = [
  { name: "main", steps: main },
  {
    name: "idle -fetch_ok->",
    steps: [
      [
        "idle -fetch_ok-> succeeded",
        { type: "fetch_ok", url: U, body: "cold", at: T0 },
      ],
    ],
  },
  {
    name: "idle -fetch_err->",
    steps: [
      [
        "idle -fetch_err-> waiting_retry",
        { type: "fetch_err", url: U, error: "cold-boom", at: T0 },
      ],
    ],
  },
];

/** property-order-independent structural print */
export function stable(v: unknown): string {
  if (v === null || typeof v !== "object")
    return JSON.stringify(v) ?? "undefined";
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const rec = v as Record<string, unknown>;
  return `{${Object.keys(rec)
    .sort()
    .filter((k) => rec[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stable(rec[k])}`)
    .join(",")}}`;
}
