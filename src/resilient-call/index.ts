/**
 * @demlik/tea/resilient-call — the ROOT composition: a single resilience knob
 * that bundles cache → circuit-breaker → rate-limit → exponential-backoff retry
 * (with a deadline-driven retry timer) around any fallible `(input) => Promise`
 * port.
 *
 * This is `examples/resilient-fetch.ts`'s hand-wired `attempt()` generalized:
 *
 *   - It is **keyed**. The example tracked one URL at a time; this tracks N
 *     concurrent logical calls, each under a string `key`. The cache, the
 *     waiting-retry bookkeeping, and the retry timers are all per-key, while the
 *     circuit breaker and token bucket are shared (one downstream target, one
 *     breaker / one bucket — the example's implicit single-target assumption
 *     made explicit).
 *   - It is **config-driven**, not hand-wired. You hand `createResilientCall`
 *     a `ResilientConfig` and get back the uniform knob contract every L2
 *     composition exposes: `init()`, the four verbs (`attempt` / `succeed` /
 *     `fail` / `onTimer`), `subs(state)`, and `handlers(ports)`.
 *   - Every brick is **optional**. Omit `cache` and the cache gate disappears
 *     (`get` is never consulted); omit `circuit` and every call passes the
 *     breaker; omit `rateLimit` and the bucket never throttles; omit `retry`
 *     and a failure is terminal (no backoff, no timer); omit `deadline` and no
 *     overall wall-clock cap is armed. "Omit a brick → omit its gate" is the
 *     whole config story — there are no other modes.
 *
 * Four later compositions (`llm-call`, `paginated-walk`, `authed-call`,
 * `reconciler`) inherit THIS slice + verb shape, so the contract here is
 * load-bearing: the slice is a flat record of brick states, every verb returns
 * `readonly [State, Cmd[]]`, time is always an `at` / `now` parameter, and the
 * RNG used for jitter is injected on the config (never read inside a verb).
 *
 * ## The two non-negotiables (canon)
 *
 *   - **Durable** — the slice is a plain-data Model field (brick states are all
 *     JSON-serializable), so it survives DO eviction / reload.
 *   - **Replayable** — every transition is a verb returning new state + Cmds;
 *     `replay` reconstructs it exactly. Nothing here closes over time or RNG.
 *
 * ## Where the clock / RNG live
 *
 * Inside the verbs: nowhere. Time arrives as `at` on `attempt` / `onTimer` and
 * is carried on the result / timer Msgs the consumer dispatches. Jitter RNG is
 * injected once at `createResilientCall(config, rng)` and threaded into
 * `nextDelayMs` at the verb boundary — deterministic in tests, `Math.random`
 * by default. The ONLY clock read is `Date.now()` inside the `handlers` port
 * (the effect boundary), exactly as `resilient-fetch.ts` stamps its result Msgs.
 *
 * ## Typical wiring
 *
 *   const rc = createResilientCall<string, Result>({
 *     cache: { ttlMs: 60_000 },
 *     circuit: { threshold: 5, cooldownMs: 30_000 },
 *     rateLimit: { capacity: 10, refillPerSec: 5 },
 *     retry: defaultRetryPolicy,
 *     deadline: { ms: 5_000 },
 *   });
 *
 *   // in the machine:
 *   init: () => [{ resilience: rc.init() }, []],
 *   update: {
 *     fetch:   (s, m) => lift(s, rc.attempt(s.resilience, m.key, m.input, m.at)),
 *     call_ok: (s, m) => lift(s, rc.succeed(s.resilience, m.key, m)),
 *     call_err:(s, m) => lift(s, rc.fail(s.resilience, m.key, m)),
 *     retry_due:(s, m) => lift(s, rc.onTimer(s.resilience, m)),
 *   },
 *   subscriptions: (s) => rc.subs(s.resilience),
 *   subscribe: { deadline: subscribeDeadline },
 *   interpret: rc.handlers({ run: ctx.call }),
 */

import {
  get as cacheGet,
  set as cacheSet,
  initCache,
  type TtlCache,
} from "../cache";
import {
  type CircuitState,
  canPass,
  initCircuit,
  onFailure,
  onSuccess,
} from "../circuit-breaker";
import {
  type DeadlineExceeded,
  type DeadlineSub,
  deadlineSub,
  subscribeDeadline,
} from "../deadline";
import { type Cmd, tryInterpret } from "../index";
import { initBucket, type TokenBucket, tryConsume } from "../rate-limit";
import {
  initRetry,
  nextDelayMs,
  type RetryPolicy,
  type RetryState,
  recordFailure,
  shouldRetry,
} from "../retry-backoff";

// ===========================================================================
// Config — the knob. Every brick optional; omit a brick → omit its gate.
// ===========================================================================

/** Circuit-breaker knob — only the two numbers a consumer ever tunes. */
export interface CircuitConfig {
  /** Consecutive failures that trip the breaker open. */
  readonly threshold: number;
  /** How long the breaker stays open before admitting a probe, in ms. */
  readonly cooldownMs: number;
  /**
   * Probes admitted in `half_open` before fast-failing the rest of the round.
   * Defaults to 1 (a single probe decides recovery) — matches the circuit-
   * breaker module's `defaultCircuitPolicy`.
   */
  readonly halfOpenMaxProbes?: number;
}

/** Token-bucket rate-limit knob. */
export interface RateLimitConfig {
  /** Burst size — the bucket starts full at `capacity`. */
  readonly capacity: number;
  /** Steady-state refill rate, tokens per second. */
  readonly refillPerSec: number;
}

/** Per-entry TTL cache knob. */
export interface CacheConfig {
  /** How long a cached success stays fresh, in ms. */
  readonly ttlMs: number;
}

/** Overall wall-clock deadline knob — an absolute cap per in-flight call. */
export interface DeadlineConfig {
  /** Budget from the moment a call starts, in ms. */
  readonly ms: number;
}

/**
 * The resilience knob. EVERY field is optional: omit a brick and its gate is
 * skipped entirely (the slice still carries a default brick state so the shape
 * stays uniform across configs, but the gate is never consulted). An empty
 * config `{}` is a valid pass-through — a bare effect with no resilience at all.
 */
export interface ResilientConfig {
  readonly retry?: RetryPolicy;
  readonly circuit?: CircuitConfig;
  readonly rateLimit?: RateLimitConfig;
  readonly cache?: CacheConfig;
  readonly deadline?: DeadlineConfig;
}

// ===========================================================================
// Slice — the Model field this knob owns. A flat record of brick states.
// ===========================================================================

/**
 * Per-key call phase. `key` indexes a logical call; several can be in flight at
 * once (the generalization of the example's single `url`). Discriminated on
 * `phase` so each phase carries only its own data (pattern 11):
 *
 *   - `idle`          — never attempted, or fully settled and forgotten.
 *   - `running`       — the effect Cmd is out; awaiting `succeed` / `fail`.
 *                       Carries `deadlineAtMs` (absolute cap, `0` if no deadline
 *                       brick) and the last `input` so a retry can re-issue it.
 *   - `waiting_retry` — a transient failure backed off; the retry timer is armed
 *                       for `retryAtMs`. Carries `input` for the re-attempt.
 *   - `circuit_open`  — the breaker fast-failed this attempt. Terminal for this
 *                       call until the consumer re-attempts after cooldown.
 *   - `succeeded`     — settled OK. `result` is the value the port produced.
 *   - `failed`        — settled Err (out of retries, or no retry brick). `error`
 *                       carries the last failure.
 */
export type CallPhase<I, R> =
  | { readonly phase: "idle" }
  | {
      readonly phase: "running";
      readonly input: I;
      readonly deadlineAtMs: number;
    }
  | {
      readonly phase: "waiting_retry";
      readonly input: I;
      readonly retryAtMs: number;
      readonly deadlineAtMs: number;
    }
  | { readonly phase: "circuit_open" }
  | { readonly phase: "succeeded"; readonly result: R }
  | { readonly phase: "failed"; readonly error: unknown };

/**
 * The slice. `circuit` / `bucket` are SHARED across keys (one downstream target
 * → one breaker, one bucket). `retry` and `cache` are PER KEY (each logical call
 * has its own backoff count + cached result), as is the per-call `CallPhase`.
 * Every field is plain data → the whole slice serializes into a `Store<S>`.
 *
 * `retry` / `cache` keep a default brick value even when the corresponding
 * config brick is omitted, so the slice shape is identical regardless of which
 * bricks the consumer enabled — the verbs simply never consult the unused brick.
 */
export interface ResilientState<I, R> {
  readonly circuit: CircuitState;
  readonly bucket: TokenBucket;
  readonly retry: Readonly<Record<string, RetryState>>;
  readonly cache: TtlCache<R>;
  readonly calls: Readonly<Record<string, CallPhase<I, R>>>;
}

// ===========================================================================
// Cmds + Msgs the knob speaks. Generic over the port input `I`.
// ===========================================================================

/**
 * The one effect this knob emits: "run the port for `key` with `input`". The
 * consumer's `handlers(ports)` interprets it; it carries no closure — `input`
 * is plain data (invariant 3).
 */
export type RunCmd<I> = Cmd<"resilient_run"> & {
  readonly key: string;
  readonly input: I;
};

/** Settle Msgs the `handlers` port dispatches back. `at` is stamped at the boundary. */
export type SucceedMsg<R> = {
  readonly type: "resilient_ok";
  readonly key: string;
  readonly result: R;
  readonly at: number;
};
export type FailMsg = {
  readonly type: "resilient_err";
  readonly key: string;
  readonly error: unknown;
  readonly at: number;
};

/** The retry / deadline timer Msg — `DeadlineExceeded`, keyed by the call `key`. */
export type ResilientTimerMsg = DeadlineExceeded;

/**
 * The plain-data error a deadline-failed call settles with. A `{_tag, ...}`
 * sentinel — NEVER a `new Error(...)` — so the slice stays JSON-serializable
 * (Error objects round-trip to `{}` and carry a stack trace, both of which break
 * the slice's durability invariant). `id` / `atMs` echo the timer that fired so
 * a consumer can attribute the failure to its deadline.
 */
export type DeadlineExceededError = {
  readonly _tag: "deadline_exceeded";
  readonly id: string;
  readonly atMs: number;
};

/** Ports the consumer supplies to `handlers`. */
export interface ResilientPorts<I, R> {
  /** The fallible work this knob wraps. Throws on failure → routed to `fail`. */
  readonly run: (input: I, key: string) => Promise<R>;
}

// ===========================================================================
// Internal brick-policy derivation — config → the L1 policy shapes.
// ===========================================================================

// A circuit policy is only built when the brick is configured; absence is
// represented as `null` so the gate can short-circuit to "always pass".
function circuitPolicy(config: ResilientConfig) {
  if (config.circuit === undefined) return null;
  return {
    failureThreshold: config.circuit.threshold,
    cooldownMs: config.circuit.cooldownMs,
    halfOpenMaxProbes: config.circuit.halfOpenMaxProbes ?? 1,
  };
}

// Sub-id families. Each call's retry timer is a deadline keyed by `key`, so a
// machine running many concurrent calls reconciles each independently.
function retryTimerId(key: string): string {
  return `resilient:retry:${key}`;
}
function deadlineTimerId(key: string): string {
  return `resilient:deadline:${key}`;
}

// ===========================================================================
// The knob factory.
// ===========================================================================

/**
 * Build a resilient-call knob from `config`. `rng` is injected for retry
 * jitter — pass a fixed `() => 0.5` in tests to pin backoff; defaults to
 * `Math.random` (read at the verb boundary, never inside a brick op). It is
 * curried onto the factory rather than threaded through every verb so callers
 * spell the determinism choice once.
 *
 * Returns the uniform L2 knob contract. `I` is the port input type, `R` the
 * port result type.
 */
export function createResilientCall<I, R>(
  config: ResilientConfig,
  rng: () => number = Math.random,
) {
  const cPolicy = circuitPolicy(config);

  /** The starting slice. Bricks not in `config` still get a default value. */
  function init(): ResilientState<I, R> {
    return {
      circuit: initCircuit(),
      // The bucket carries a default value even without the rateLimit brick so
      // the slice shape is uniform, but the rate-limit GATE is skipped entirely
      // when the brick is absent (see `gate`) — the bucket is simply never
      // consulted. A `0/0` placeholder bucket would be touched by `tryConsume`;
      // a `1-cap` default is harmless because the gate never calls it.
      bucket: config.rateLimit
        ? initBucket(
            config.rateLimit.capacity,
            config.rateLimit.refillPerSec,
            0,
          )
        : initBucket(1, 1, 0),
      retry: {},
      cache: initCache<R>(),
      calls: {},
    };
  }

  /** Read this key's retry state, defaulting to a fresh one. */
  function retryOf(s: ResilientState<I, R>, key: string): RetryState {
    return s.retry[key] ?? initRetry();
  }

  /** Compute the absolute deadline for a call starting at `at` (0 = no cap). */
  function deadlineAt(at: number): number {
    return config.deadline ? at + config.deadline.ms : 0;
  }

  /**
   * The shared decision: cache → rate-limit → circuit gate, then either emit
   * the effect or schedule a retry. `deadlineAtMs` is threaded so a re-attempt
   * (from `onTimer`) keeps the ORIGINAL overall deadline rather than restarting
   * it. PURE — `at` is the only clock; `rng` is the injected jitter source.
   *
   * Used by both `attempt` (fresh call) and `onTimer` (retry timer fired) so
   * the gate logic lives in exactly one place — the example's shared `attempt`
   * helper, lifted to a keyed knob.
   *
   * ## Why rate-limit is gated BEFORE the circuit probe
   *
   * The circuit-breaker's `canPass` is not a passive read: in `half_open` it
   * *consumes* a probe slot (advancing `probes`), and the consumed slot is only
   * released when a probe RESOLVES via `onSuccess` / `onFailure`. So a probe
   * slot may only be taken when this attempt is actually going to reach the
   * backend (i.e. emit the `resilient_run` Cmd). The rate-limit gate can reject
   * an attempt and return a backoff WITHOUT any Cmd — no backend call, so no
   * settle Msg ever comes back. If the circuit probe were consumed first, that
   * rate-limited attempt would burn the half-open probe budget on a call that
   * never happened, wedging the breaker `half_open` at its probe cap forever
   * (nothing moves it out of `half_open` but a resolved probe). Running the
   * rate-limit gate first means the circuit probe is consumed ONLY on the path
   * that emits the effect.
   */
  function gate(
    s: ResilientState<I, R>,
    key: string,
    input: I,
    at: number,
    deadlineAtMs: number,
  ): readonly [ResilientState<I, R>, readonly RunCmd<I>[]] {
    // 1) Serve from cache if fresh — no effect at all. Skipped when no cache brick.
    if (config.cache !== undefined) {
      const cached = cacheGet(s.cache, key, at);
      if (cached !== undefined) {
        return [setCall(s, key, { phase: "succeeded", result: cached }), []];
      }
    }

    // 2) Rate-limit gate FIRST — it may reject with no Cmd, so it must run
    // before any circuit probe is consumed (see header note). Skipped entirely
    // when no rateLimit brick — the bucket is never consulted, so the default
    // placeholder bucket stays untouched.
    let bucket = s.bucket;
    if (config.rateLimit !== undefined) {
      const [next, hasToken] = tryConsume(bucket, at);
      bucket = next;
      if (!hasToken) {
        // Rate-limited: treat as a transient failure and back off via retry.
        // The circuit is untouched — no probe is spent on a call that never ran.
        return backoff(
          { ...s, bucket },
          key,
          input,
          "rate_limited",
          at,
          deadlineAtMs,
        );
      }
    }

    // 3) Circuit-breaker gate. `null` policy → no breaker → always pass. Reached
    // only once a token is secured, so a half-open probe is consumed exclusively
    // on the path that emits the effect below.
    let circuit = s.circuit;
    if (cPolicy !== null) {
      const [next, ok] = canPass(circuit, cPolicy, at);
      circuit = next;
      if (!ok) {
        return [
          { ...setCall(s, key, { phase: "circuit_open" }), bucket, circuit },
          [],
        ];
      }
    }

    // 4) All gates passed — emit the effect as data.
    return [
      {
        ...setCall(s, key, { phase: "running", input, deadlineAtMs }),
        circuit,
        bucket,
      },
      [{ type: "resilient_run", key, input }],
    ];
  }

  /**
   * Back off after a transient failure: record it, and if `retry` permits
   * another attempt, enter `waiting_retry` with the retry timer armed; else
   * settle `failed`. When no `retry` brick is configured the call fails on the
   * first failure (no backoff, no timer). PURE.
   */
  function backoff(
    s: ResilientState<I, R>,
    key: string,
    input: I,
    error: unknown,
    at: number,
    deadlineAtMs: number,
  ): readonly [ResilientState<I, R>, readonly RunCmd<I>[]] {
    if (config.retry === undefined) {
      return [setCall(s, key, { phase: "failed", error }), []];
    }
    const retry = recordFailure(retryOf(s, key), error);
    const withRetry = { ...s, retry: { ...s.retry, [key]: retry } };
    if (!shouldRetry(retry, config.retry)) {
      return [setCall(withRetry, key, { phase: "failed", error }), []];
    }
    const retryAtMs = at + nextDelayMs(retry, config.retry, rng);
    return [
      setCall(withRetry, key, {
        phase: "waiting_retry",
        input,
        retryAtMs,
        deadlineAtMs,
      }),
      [],
    ];
  }

  // Set the phase for one key, leaving every other field untouched.
  function setCall(
    s: ResilientState<I, R>,
    key: string,
    phase: CallPhase<I, R>,
  ): ResilientState<I, R> {
    return { ...s, calls: { ...s.calls, [key]: phase } };
  }

  // === Verb: attempt =======================================================

  /**
   * Start (or restart) the call for `key` with `input` at time `at`. Runs the
   * cache → circuit → rate-limit gate and either emits the `resilient_run`
   * effect, schedules a retry, fast-fails (circuit open), or serves the cache.
   * PURE.
   */
  function attempt(
    s: ResilientState<I, R>,
    key: string,
    input: I,
    at: number,
  ): readonly [ResilientState<I, R>, readonly RunCmd<I>[]] {
    return gate(s, key, input, at, deadlineAt(at));
  }

  // === Verb: succeed =======================================================

  /**
   * Record a success for `key`: close the breaker, fill the cache (if a cache
   * brick exists), reset this key's retry count, and settle `succeeded`. PURE —
   * `msg.at` is the cache write clock.
   */
  function succeed(
    s: ResilientState<I, R>,
    key: string,
    msg: SucceedMsg<R>,
  ): readonly [ResilientState<I, R>, readonly RunCmd<I>[]] {
    const circuit =
      cPolicy !== null ? onSuccess(s.circuit, cPolicy) : s.circuit;
    const cache =
      config.cache !== undefined
        ? cacheSet(s.cache, key, msg.result, msg.at, config.cache.ttlMs)
        : s.cache;
    // Drop this key's retry counter — a success ends the retry run.
    const { [key]: _dropped, ...retry } = s.retry;
    return [
      {
        ...setCall(s, key, { phase: "succeeded", result: msg.result }),
        circuit,
        cache,
        retry,
      },
      [],
    ];
  }

  // === Verb: fail ==========================================================

  /**
   * Record a failure for `key`: trip the breaker (it may open), then back off —
   * schedule a retry if `retry` permits, else settle `failed`. PURE — `msg.at`
   * stamps the breaker trip + the retry delay base. Re-issues from the call's
   * remembered `input` and preserves the original overall `deadlineAtMs`.
   */
  function fail(
    s: ResilientState<I, R>,
    key: string,
    msg: FailMsg,
  ): readonly [ResilientState<I, R>, readonly RunCmd<I>[]] {
    const circuit =
      cPolicy !== null ? onFailure(s.circuit, cPolicy, msg.at) : s.circuit;
    const withCircuit = { ...s, circuit };
    const call = s.calls[key];
    const input = call?.phase === "running" ? call.input : undefined;
    const deadlineAtMs =
      call?.phase === "running" ? call.deadlineAtMs : deadlineAt(msg.at);
    // No remembered input (e.g. a stray fail for a key not running) → just
    // settle failed after tripping the breaker; nothing to re-issue.
    if (input === undefined) {
      return [
        setCall(withCircuit, key, { phase: "failed", error: msg.error }),
        [],
      ];
    }
    return backoff(withCircuit, key, input, msg.error, msg.at, deadlineAtMs);
  }

  // === Verb: settleFailed ==================================================

  /**
   * Settle `key` to terminal `failed` with `error` WITHOUT touching the circuit
   * breaker or this key's retry counter. PURE.
   *
   * This is the verb for a failure that is NOT a downstream-health signal: the
   * call must end now, but the breaker must not trip and the backoff run must
   * not advance. `fail` is the opposite — it records the failure against the
   * breaker (it may open) and feeds the retry policy (it may back off). Use
   * `settleFailed` when the *reason* the call cannot proceed has nothing to do
   * with downstream health:
   *
   *   - `authed-call` settles a 401 it cannot fix (e.g. the refresh budget is
   *     spent): a bad token is the caller's problem, not the backend's —
   *     tripping the breaker on it would punish a healthy target, and backing
   *     off would just retry a request that will 401 again.
   *   - `paginated-walk` settles a terminal walk error (e.g. a malformed page
   *     the consumer rejects) that should stop the walk without poisoning the
   *     shared breaker the next page fetch passes through.
   *
   * Because it leaves `circuit` and `retry[key]` untouched, the breaker keeps
   * its health view of the actual backend and a later `attempt` for this key
   * starts a fresh retry run. Both sibling knobs previously hand-rolled this by
   * splicing `calls` directly; this verb gives them one named, tested entry
   * point so the slice's settle invariants live in exactly one place.
   */
  function settleFailed(
    s: ResilientState<I, R>,
    key: string,
    error: unknown,
  ): readonly [ResilientState<I, R>, readonly RunCmd<I>[]] {
    return [setCall(s, key, { phase: "failed", error }), []];
  }

  // === Verb: onTimer =======================================================

  /**
   * A timer fired for some key. Two kinds, disambiguated by the Sub id:
   *
   *   - retry timer    → re-run the gate for that key's remembered input,
   *                      re-checking the circuit + bucket at THIS time.
   *   - deadline timer → the overall budget elapsed → settle `failed` with a
   *                      deadline error, no matter the current phase.
   *
   * A timer for a key no longer `waiting_retry` (retry) / no longer in flight
   * (deadline) is a no-op — the reconcile pass races the result; the verb must
   * tolerate a stale fire. PURE.
   */
  function onTimer(
    s: ResilientState<I, R>,
    msg: ResilientTimerMsg,
  ): readonly [ResilientState<I, R>, readonly RunCmd<I>[]] {
    for (const [key, call] of Object.entries(s.calls)) {
      if (msg.id === retryTimerId(key)) {
        if (call.phase !== "waiting_retry") return [s, []];
        return gate(s, key, call.input, msg.atMs, call.deadlineAtMs);
      }
      if (msg.id === deadlineTimerId(key)) {
        // Deadline only fires for a still-active call. A settled call has no
        // armed deadline Sub, but tolerate a stale fire defensively.
        if (call.phase !== "running" && call.phase !== "waiting_retry")
          return [s, []];
        // Plain-data sentinel, NOT a `new Error(...)`: an Error object is not
        // JSON-serializable (it round-trips to `{}`) and captures a stack trace,
        // both of which break the slice's durability invariant once it is
        // persisted into a `Store<S>` and reloaded. A `{_tag, ...}` record keeps
        // the slice round-trip-equal under JSON.parse(JSON.stringify(...)).
        return [
          setCall(s, key, {
            phase: "failed",
            error: {
              _tag: "deadline_exceeded",
              id: msg.id,
              atMs: msg.atMs,
            } satisfies DeadlineExceededError,
          }),
          [],
        ];
      }
    }
    return [s, []];
  }

  // === Subs ================================================================

  /**
   * Pre-wired subscriptions: a retry timer for every `waiting_retry` call, and
   * (when the `deadline` brick is configured) an overall deadline timer for
   * every still-active call. Both are `DeadlineSub`s reconciled by id, so a
   * phase change cancels the matching timer automatically — no manual
   * `clearTimeout`. Wire `subscribe: { deadline: subscribeDeadline }`.
   */
  function subs(s: ResilientState<I, R>): readonly DeadlineSub[] {
    const out: DeadlineSub[] = [];
    for (const [key, call] of Object.entries(s.calls)) {
      if (call.phase === "waiting_retry") {
        out.push(deadlineSub(retryTimerId(key), call.retryAtMs));
      }
      if (
        config.deadline !== undefined &&
        (call.phase === "running" || call.phase === "waiting_retry") &&
        call.deadlineAtMs > 0
      ) {
        out.push(deadlineSub(deadlineTimerId(key), call.deadlineAtMs));
      }
    }
    return out;
  }

  // === Handlers ============================================================

  /**
   * Pre-wired interpret handler for `resilient_run`. Wraps the consumer's
   * `run` port via `tryInterpret` (Railway): success → `resilient_ok`, failure
   * → `resilient_err`, each stamped with `Date.now()` at the effect boundary —
   * the ONE permitted clock read (interpret is impure; the reducer never reads
   * the clock). Assign to the machine's `interpret`:
   *
   *   interpret: rc.handlers({ run: (input, key) => ctx.callBackend(input) })
   */
  function handlers(ports: ResilientPorts<I, R>) {
    return {
      resilient_run: tryInterpret<
        RunCmd<I>,
        R,
        SucceedMsg<R> | FailMsg,
        unknown
      >(
        (cmd) => ports.run(cmd.input, cmd.key),
        (result, cmd): SucceedMsg<R> => ({
          type: "resilient_ok",
          key: cmd.key,
          result,
          at: Date.now(),
        }),
        (error, cmd): FailMsg => ({
          type: "resilient_err",
          key: cmd.key,
          error,
          at: Date.now(),
        }),
      ),
    };
  }

  return {
    init,
    attempt,
    succeed,
    fail,
    settleFailed,
    onTimer,
    subs,
    handlers,
  };
}

/**
 * Lift a knob result `[slice, cmds]` into a host `[State, cmds]` where the
 * slice lives at `state.resilience`. A convenience for the common single-slice
 * host; consumers with a differently-named field spread by hand. Pure — a thin
 * record rebuild, no clock / RNG.
 */
export function liftResilience<
  S extends { resilience: ResilientState<I, R> },
  I,
  R,
  C extends Cmd,
>(
  state: S,
  [slice, cmds]: readonly [ResilientState<I, R>, readonly C[]],
): readonly [S, readonly C[]] {
  return [{ ...state, resilience: slice }, cmds];
}

/**
 * Re-export the deadline Sub primitives so consumers (and tests) wire one
 * import: `subscribeDeadline` is the `subscribe` cell, `deadlineSub` builds the
 * Sub literal this knob's `subs` emits.
 */
export { subscribeDeadline, deadlineSub };
export type { DeadlineSub, DeadlineExceeded };
