/**
 * How the @demlik/tea behavior modules compose INSIDE a machine.
 *
 * A resilient fetch: serve-from-cache → circuit-breaker gate → rate-limit gate
 * → fetch → on failure, exponential-backoff retry scheduled by a deadline Sub.
 *
 * The whole point of this file: each module shape has ONE home in a machine.
 *
 *   • Pure state+ops (circuit-breaker, rate-limit, retry-backoff, cache) live
 *     as FIELDS in the Model. You call their pure ops inside `update` to decide
 *     which Cmds to emit. They never run effects; they just transform state.
 *   • Sub factories (deadline) are declared by `subscriptions(state)` and run by
 *     `subscribe`. Reconcile-by-id starts/cancels them as state changes.
 *   • The real effect (the HTTP call) lives in `interpret`, via `tryInterpret`.
 *   • Time is DATA: every Msg that drives a time-dependent op carries `at`.
 *     The reducer never reads the clock — `interpret` stamps `Date.now()` when
 *     it turns a result back into a Msg. Reducers stay pure (invariant 2).
 */

import { type Cmd, defineMachine, run, tryInterpret } from "@demlik/tea";
import {
  type CircuitState,
  canPass,
  defaultCircuitPolicy,
  initCircuit,
  onFailure,
  onSuccess,
} from "@demlik/tea/circuit-breaker";
import { type TokenBucket, initBucket, tryConsume } from "@demlik/tea/rate-limit";
import {
  type RetryState,
  defaultRetryPolicy,
  initRetry,
  nextDelayMs,
  recordFailure,
  shouldRetry,
} from "@demlik/tea/retry-backoff";
import { type TtlCache, get as cacheGet, initCache, set as cacheSet } from "@demlik/tea/cache";
import { type DeadlineExceeded, type DeadlineSub, deadlineSub, subscribeDeadline } from "@demlik/tea/deadline";

// === Model: reliability modules composed as plain fields ===
type Phase = "idle" | "fetching" | "waiting_retry" | "circuit_open" | "succeeded" | "failed";

interface State {
  phase: Phase;
  url: string | null;
  body: string | null;
  error: string | null;
  retryAtMs: number;
  // Each behavior module's state is just a field. update() folds their pure ops.
  circuit: CircuitState;
  bucket: TokenBucket;
  retry: RetryState;
  cache: TtlCache<string>;
}

// === Msgs: note `at` rides on every time-driven Msg ===
type Msg =
  | { type: "fetch"; url: string; at: number }
  | { type: "fetch_ok"; url: string; body: string; at: number }
  | { type: "fetch_err"; url: string; error: string; at: number }
  | DeadlineExceeded; // { type: "deadline_exceeded"; id; atMs } — the retry timer fired

// === Cmd: the one effect, as data ===
type DoFetch = Cmd<"do_fetch"> & { url: string };

// === Sub + Ctx ===
type Sub = DeadlineSub;
interface Ctx {
  http: (url: string) => Promise<string>;
}

const CACHE_TTL_MS = 60_000;

// Shared "try to fetch now" decision — used by the initial `fetch` Msg AND by
// the retry timer (`deadline_exceeded`). This is where four modules compose in
// one pure function: cache read → circuit gate → rate-limit gate → emit effect.
function attempt(state: State, url: string, at: number): readonly [State, readonly DoFetch[]] {
  // 1) Serve from cache if still fresh — no effect at all.
  const cached = cacheGet(state.cache, url, at);
  if (cached !== undefined) {
    return [{ ...state, phase: "succeeded", url, body: cached, error: null }, []];
  }

  // 2) Circuit-breaker gate. canPass returns [nextCircuit, allowed] — pure.
  const [circuit, circuitOk] = canPass(state.circuit, defaultCircuitPolicy, at);
  if (!circuitOk) {
    return [{ ...state, circuit, phase: "circuit_open", url }, []];
  }

  // 3) Rate-limit gate. tryConsume returns [nextBucket, allowed] — pure.
  const [bucket, hasToken] = tryConsume(state.bucket, at);
  if (!hasToken) {
    // Rate-limited: treat as a transient failure and back off via retry-backoff.
    const retry = recordFailure(state.retry, "rate_limited");
    if (!shouldRetry(retry, defaultRetryPolicy)) {
      return [{ ...state, circuit, bucket, retry, phase: "failed", url, error: "rate limited; out of retries" }, []];
    }
    return [
      { ...state, circuit, bucket, retry, phase: "waiting_retry", url, retryAtMs: at + nextDelayMs(retry, defaultRetryPolicy) },
      [],
    ];
  }

  // 4) All gates passed — emit the effect as data.
  return [{ ...state, circuit, bucket, phase: "fetching", url, error: null }, [{ type: "do_fetch", url }]];
}

export const resilientFetch = defineMachine<State, Msg, DoFetch, Sub, Ctx>({
  init: (loaded) =>
    loaded !== null
      ? [loaded, []]
      : [
          {
            phase: "idle",
            url: null,
            body: null,
            error: null,
            retryAtMs: 0,
            circuit: initCircuit(),
            bucket: initBucket(10, 5, 0), // 10 tokens, refill 5/sec
            retry: initRetry(),
            cache: initCache<string>(),
          },
          [],
        ],

  update: {
    fetch: (s, m) => attempt(s, m.url, m.at),

    fetch_ok: (s, m) => [
      {
        ...s,
        circuit: onSuccess(s.circuit, defaultCircuitPolicy), // success closes the breaker
        cache: cacheSet(s.cache, m.url, m.body, m.at, CACHE_TTL_MS), // remember the response
        retry: initRetry(), // reset the retry counter
        phase: "succeeded",
        body: m.body,
        error: null,
      },
      [],
    ],

    fetch_err: (s, m) => {
      const circuit = onFailure(s.circuit, defaultCircuitPolicy, m.at); // may trip the breaker
      const retry = recordFailure(s.retry, m.error);
      if (!shouldRetry(retry, defaultRetryPolicy)) {
        return [{ ...s, circuit, retry, phase: "failed", error: m.error }, []];
      }
      // Schedule a retry: the deadline Sub (declared below) fires at retryAtMs.
      return [{ ...s, circuit, retry, phase: "waiting_retry", retryAtMs: m.at + nextDelayMs(retry, defaultRetryPolicy) }, []];
    },

    // The retry timer fired — re-attempt (re-gates the circuit + bucket at this time).
    deadline_exceeded: (s, m) =>
      s.phase === "waiting_retry" && s.url !== null ? attempt(s, s.url, m.atMs) : [s, []],
  },

  // A Sub is active ONLY while we're waiting to retry. When the phase changes,
  // reconcile-by-id cancels the timer automatically — no manual clearTimeout.
  subscriptions: (s) => (s.phase === "waiting_retry" ? [deadlineSub("retry", s.retryAtMs)] : []),
  subscribe: { deadline: subscribeDeadline },

  // The effect. tryInterpret routes Ok/Err to two Msgs — and stamps the time:
  // this is the ONE place a clock read is allowed (interpret is impure).
  interpret: {
    do_fetch: tryInterpret<DoFetch, string, Msg, Ctx>(
      (cmd, ctx) => ctx.http(cmd.url),
      (body, cmd) => ({ type: "fetch_ok", url: cmd.url, body, at: Date.now() }),
      (err, cmd) => ({ type: "fetch_err", url: cmd.url, error: String(err), at: Date.now() }),
    ),
  },
});

// === Wiring it up — the layers OUTSIDE the machine ===
export function startResilientFetch() {
  const runtime = run(resilientFetch, {
    ctx: { http: (url) => fetch(url).then((r) => r.text()) },
  });

  return runtime;
}
