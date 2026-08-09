/**
 * @packageDocumentation
 * @demlik/tea/retry-backoff — exponential backoff with jitter + cap, and the
 * retry-attempt state every fallible `interpret` handler folds over.
 *
 * This is a "pure state + ops" module in the same mold as
 * `@demlik/tea/work-queue`: a state type plus pure transition functions,
 * storage- and host-agnostic, that a consumer wires into their own reducer /
 * interpret. Nothing here reads the clock or the RNG on its own behalf —
 * randomness is *injected* (`rng`) and time is *computed by the caller* from
 * the millisecond delays this module returns. That keeps every function
 * deterministic and unit-testable, and keeps the substrate's purity invariants
 * intact when the result is threaded through `update` (invariant 2) and the
 * delay is realized as a `Cmd` the runtime performs (invariant 3).
 *
 * Typical wiring:
 *
 *   // in `update`, on a failure Msg:
 *   const retry = recordFailure(state.retry, msg.error);
 *   if (!shouldRetry(retry, policy)) return [toGaveUp(state), []];
 *   const delayMs = nextDelayMs(retry, policy);              // pure: rng injected at call site
 *   return [{ ...state, retry }, [{ type: "ScheduleRetry", delayMs, into: TimerFiredRetry }]];
 *
 * and the same wiring under a wall-clock outage budget, where the failure Msg
 * carries the instant it was observed:
 *
 *   // policy: { baseMs: 250, factor: 2, capMs: 4_000, maxElapsedMs: 1_050_000, jitter: "full" }
 *   const retry = recordFailure(state.retry, msg.error, msg.at);
 *   if (!shouldRetry(retry, policy, msg.at)) return [toGaveUp(state, retryElapsedMs(retry, msg.at)), []];
 *
 * The reducer stays pure: `nextDelayMs` is called with the runtime's RNG only
 * at the emit boundary (or the caller defers the whole delay computation to the
 * `interpret` handler and passes `rng` there). Either way the substrate never
 * sees `Math.random()` inside a transition body.
 *
 * NOT a substrate primitive: it depends on nothing from `../index`. It is a
 * leaf utility consumers reach via the `@demlik/tea/retry-backoff` subpath.
 *
 * ── THE BOUND MAY BE A DURATION, NOT ONLY A COUNT ──────────────────────────
 * `maxAttempts` was the module's only terminal bound, and a count is the wrong
 * bound whenever this ladder nests inside somebody else's ladder. A downstream
 * consumer proved it in production: 4 restarts over a 250ms→4s ladder is ~3.75s
 * of backoff, which nested under a client's own ~2.5s ladder came to roughly
 * SIXTEEN SECONDS of total patience — against a peer that waits ~17.5 MINUTES
 * before it gives up on the other side. A routine deploy outran the budget and
 * killed 170 runs in 7 days that the peer would have resumed from a checkpoint.
 *
 * The failure a count cannot express is that the QUESTION is temporal. "How
 * long do we tolerate an unreachable peer" has an answer in seconds, usually
 * derived from the peer's own give-up window; what a count of attempts costs in
 * seconds depends on how long each attempt takes, which is the carrier's
 * business and not the policy's. So a policy may now declare `maxElapsedMs` —
 * a wall-clock outage budget measured from the FIRST failure of the streak —
 * instead of, or in addition to, `maxAttempts`. When both are declared, retry
 * continues only while EVERY declared bound still permits it.
 *
 * TIME IS AN INPUT, NOT AN AMBIENT READ (invariant 2). The streak's origin is
 * supplied by the caller to `recordFailure`, and `shouldRetry` is told `nowMs`;
 * this module still never reads a clock, exactly as it never reads the RNG.
 * The types make the wiring the only wiring that compiles: a duration-bounded
 * policy only satisfies the `shouldRetry` overload that demands a
 * {@link TimedRetryState} *and* a `nowMs`, so "declared an outage budget, never
 * fed it a clock" is a type error rather than a bound that quietly never fires.
 *
 * A policy with NO bound at all is likewise unrepresentable by accident — the
 * {@link RetryBudget} union has no "neither" arm; forever-retry must be spelled
 * `unbounded: true` ({@link UnboundedRetryPolicy}).
 *
 * Strengthens invariant 2 (transitions are pure — the clock enters as an
 * argument, never as a `Date.now()` inside the fold) and invariant 5
 * (composition is by reduction — the new bound is an additive arm on the policy
 * union and an optional argument on the verbs, so every existing count-bounded
 * call site keeps compiling untouched).
 */

/**
 * Jitter strategy applied to the computed backoff delay.
 *
 * Names follow the AWS "Exponential Backoff And Jitter" taxonomy (Brooker,
 * 2015), the same vocabulary used by the AWS SDKs and most retry libraries:
 *
 *   - `"none"`  — no jitter; the delay is the raw capped exponential `d`.
 *                 Deterministic, but synchronizes retries across clients
 *                 (thundering herd). Use only when callers are already
 *                 de-correlated by other means.
 *   - `"full"`  — uniform random in `[0, d]`. Maximum spread; best herd
 *                 avoidance, highest variance in latency.
 *   - `"equal"` — `d/2 + random(0, d/2)`, i.e. uniform in `[d/2, d]`. Half the
 *                 delay is fixed, half is jittered: keeps a latency floor while
 *                 still de-correlating clients. A common default.
 */
export type Jitter = "none" | "full" | "equal";

declare const RngBrand: unique symbol;

/**
 * A source of uniform randomness in `[0, 1)` — the `Math.random` contract.
 *
 * Nominally branded so the `[0, 1)` range is enforced at *construction*, not
 * by a comment. A raw `() => number` does NOT satisfy `Rng`: a stray `() => 5`
 * or `() => -1` is rejected by the type before it can ever feed the jitter
 * math and breach the `0 <= delay <= capMs` postcondition. The only way to
 * mint an `Rng` is {@link asRng} (or the {@link defaultRng} const), so the
 * range obligation lives at the boundary where randomness enters the module —
 * "parse, don't validate" applied to a function value.
 */
export type Rng = (() => number) & { readonly [RngBrand]: true };

/**
 * Brand a `[0, 1)` generator as an {@link Rng}. The single entry point for
 * randomness into this module: callers (production wiring and tests alike)
 * pass their raw generator through here, which optionally asserts the contract
 * and tags the value. The probe is a cheap guard against the most common
 * misuse (returning a non-unit value); it does not — and cannot — prove
 * uniformity.
 *
 * PURE with respect to the module: it neither reads the clock nor calls the
 * generator on the module's behalf unless `probe` is set. The probe is opt-in
 * (default off) so wrapping a hot generator stays allocation- and call-free.
 *
 * @throws RangeError if `probe` is enabled and a sampled value is outside `[0, 1)`.
 */
export function asRng(fn: () => number, probe = false): Rng {
  if (probe) {
    const sample = fn();
    if (!(sample >= 0 && sample < 1)) {
      throw new RangeError(
        `asRng: generator returned ${sample}, outside the [0, 1) contract`,
      );
    }
  }
  return fn as Rng;
}

/**
 * The production default: `Math.random`, branded. Used wherever an `Rng` is
 * required but the caller omits one — at the effect boundary, never inside a
 * reducer.
 */
export const defaultRng: Rng = Math.random as Rng;

/**
 * The shape of the delay ladder, with no terminal bound attached — `baseMs`,
 * `factor`, `capMs`, `jitter`. Split out from the policy because the curve and
 * the bound answer different questions: the curve is "how fast do we come
 * back", the bound is "when do we stop". `backoffDelay` needs only the curve.
 */
export interface BackoffCurve {
  /** Delay for attempt 0, in milliseconds, before any jitter or cap. */
  readonly baseMs: number;
  /** Geometric growth factor. `2` doubles the delay each attempt. */
  readonly factor: number;
  /** Hard ceiling, in milliseconds. The capped exponential never exceeds this. */
  readonly capMs: number;
  /** Jitter strategy applied to the capped exponential delay. */
  readonly jitter: Jitter;
}

/**
 * Bound by ATTEMPT COUNT — the original bound, and the right one when each
 * attempt costs about the same and the caller is the outermost ladder.
 *
 * `maxElapsedMs: never` is what keeps this arm honest: a count-bounded policy
 * is *declared* to have no outage budget, so it satisfies the clock-free
 * `shouldRetry` overload. Add `maxElapsedMs` and it becomes a
 * {@link DurationRetryPolicy}, which no longer does.
 */
export interface CountBound {
  /**
   * Maximum number of attempts. `shouldRetry` allows attempts `0 .. maxAttempts-1`,
   * so `maxAttempts: 3` means "try once, then retry at most twice" (attempts 0, 1, 2).
   */
  readonly maxAttempts: number;
  readonly maxElapsedMs?: never;
  readonly unbounded?: never;
}

/**
 * Bound by WALL-CLOCK OUTAGE DURATION, optionally also by count.
 *
 * `maxElapsedMs` is measured from the FIRST failure of the current streak
 * ({@link TimedRetryState.firstFailureAtMs}), not from the last attempt: the
 * question it answers is "how long has the far side been unreachable", which is
 * the question a nesting caller's own patience is denominated in. Derive it
 * from the peer's give-up window rather than restating a guess — two sides
 * holding different answers to one ordered fact is the defect this bound
 * exists to prevent.
 *
 * `maxAttempts` stays available here, and when both are present retry continues
 * only while BOTH still permit it (see {@link shouldRetry}). Adding a count to a
 * duration budget is a belt-and-braces guard against a pathologically fast
 * failure loop, not a substitute for the duration.
 */
export interface DurationBound {
  /**
   * Outage budget in wall-clock milliseconds. `shouldRetry` permits another
   * attempt while `nowMs - firstFailureAtMs < maxElapsedMs`, however many
   * attempts that takes.
   */
  readonly maxElapsedMs: number;
  /** Optional secondary count bound; omitted means "no count bound". */
  readonly maxAttempts?: number;
  readonly unbounded?: never;
}

/**
 * No bound at all — retry forever. Deliberately verbose and deliberately the
 * only way to say it: {@link RetryBudget} has no "neither bound declared" arm,
 * so an infinite retry loop is something a policy author must write down, never
 * something a forgotten field produces.
 */
export interface Unbounded {
  readonly unbounded: true;
  readonly maxAttempts?: never;
  readonly maxElapsedMs?: never;
}

/**
 * The terminal bound a policy declares: a count, a duration (optionally with a
 * count), or an explicit opt-in to neither. Exactly one arm applies, and there
 * is no arm for "I forgot".
 */
export type RetryBudget = CountBound | DurationBound | Unbounded;

/**
 * A retry policy is pure configuration — the knobs of the backoff curve plus
 * the bound that ends the retrying. It carries no mutable state; `RetryState`
 * does. One policy is shared across all the attempts of one logical operation
 * (often a module-scope const).
 *
 * `RetryPolicy` is the COUNT-bounded shape, unchanged since the module's first
 * release: every existing `{ baseMs, factor, capMs, maxAttempts, jitter }`
 * literal still satisfies it, `policy.maxAttempts` is still a `number` (not
 * `number | undefined`), and `shouldRetry(state, policy)` still takes no clock.
 * Reach for {@link DurationRetryPolicy} when the bound should be temporal, or
 * {@link AnyRetryPolicy} when writing code generic over the bound.
 */
export type RetryPolicy = BackoffCurve & CountBound;

/** A curve bounded by wall-clock outage duration (and optionally by count). */
export type DurationRetryPolicy = BackoffCurve & DurationBound;

/** A curve with the explicit opt-in to unbounded retry. */
export type UnboundedRetryPolicy = BackoffCurve & Unbounded;

/**
 * Any well-formed policy. The parameter type for code that must work whatever
 * bound the caller declared — `shouldRetry`'s implementation, wrappers, and
 * consumers that take a policy from configuration.
 */
export type AnyRetryPolicy = BackoffCurve & RetryBudget;

/**
 * Sensible defaults: 100ms base, doubling, capped at 30s, up to 5 attempts,
 * full jitter (the herd-avoidance default). Tuned for network calls; override
 * per call site rather than mutating this shared const.
 */
export const defaultRetryPolicy: RetryPolicy = {
  baseMs: 100,
  factor: 2,
  capMs: 30_000,
  maxAttempts: 5,
  jitter: "full",
};

/**
 * Compute the delay for a given 0-based `attempt` under `policy`.
 *
 * PURE. The exponential is `baseMs * factor ** attempt`, clamped to `capMs`,
 * then jittered. `rng` is injected so the result is deterministic in tests —
 * pass an `rng` returning a fixed value to pin the jitter; the production
 * default reads `Math.random` only when the caller omits it (at the effect
 * boundary, never inside a reducer).
 *
 * `rng` is an {@link Rng} — a `[0, 1)` generator branded at construction via
 * {@link asRng}, so a raw `() => 5` can't be passed here. The returned delay
 * is always in `[0, capMs]` regardless of jitter strategy:
 *   - `"none"`  → exactly the capped exponential `d`.
 *   - `"full"`  → `rng() * d`, uniform in `[0, d]`.
 *   - `"equal"` → `d/2 + rng() * d/2`, uniform in `[d/2, d]`.
 *
 * `attempt` is treated as `>= 0`; a negative attempt is clamped to 0 so a
 * caller's off-by-one never produces a fractional exponent or a delay below
 * `baseMs`. `capMs` is also the floor of the clamp, so a misconfigured
 * `capMs < baseMs` still yields a delay within `[0, capMs]`.
 */
export function backoffDelay(
  attempt: number,
  policy: BackoffCurve,
  rng: Rng = defaultRng,
): number {
  // Clamp the attempt to >= 0 so factor ** attempt is never a fractional /
  // negative exponent. The exponential can overflow to Infinity for large
  // attempts; Math.min with capMs collapses that back to the ceiling.
  const safeAttempt = attempt < 0 ? 0 : attempt;
  const exponential = policy.baseMs * policy.factor ** safeAttempt;
  // `factor ** attempt` overflows to Infinity for large attempts. With
  // `baseMs > 0` that's `Infinity`, which Math.min collapses back to `capMs`.
  // With `baseMs === 0` it's `0 * Infinity === NaN`; a zero base means zero
  // delay, so treat NaN as 0 (otherwise NaN poisons the comparison and breaks
  // the `0 <= delay <= capMs` postcondition).
  const d = Number.isNaN(exponential) ? 0 : Math.min(policy.capMs, exponential);

  switch (policy.jitter) {
    case "none":
      return d;
    case "full":
      // Uniform in [0, d]. Math.min re-pins the upper bound: at subnormal /
      // extreme-precision `d`, `rng() * d` can round one ULP above `d`, which
      // would breach the documented `delay <= capMs` postcondition. Clamping to
      // `d` (already <= capMs) makes the invariant hold by construction.
      return Math.min(d, rng() * d);
    case "equal":
      // Fixed half + jittered half → uniform in [d/2, d]. Same FP-rounding clamp
      // as "full": `d/2 + rng()*(d/2)` can round above `d` for subnormal `d`.
      return Math.min(d, d / 2 + rng() * (d / 2));
  }
}

/**
 * Per-operation retry state: how many attempts have failed so far, and the most
 * recent error. `lastError` is `unknown` because the failure can be anything a
 * boundary surfaces (an `Error`, a tagged result, a string) — this module never
 * inspects it, it only carries it forward for the consumer's reducer to read.
 */
export interface RetryState {
  /** Count of failures recorded so far. Also the 0-based index of the next attempt. */
  readonly attempt: number;
  /** The error from the most recent failure, if any. Carried, never interpreted. */
  readonly lastError?: unknown;
}

/**
 * A retry state that also knows WHEN its failure streak began — the origin a
 * duration bound is measured from. Minted by passing the observation instant to
 * {@link recordFailure}; there is no other way to obtain one, so a streak with
 * an outage budget but no origin is not a value that can be written down.
 *
 * The origin is the FIRST failure of the streak and is preserved across
 * subsequent failures. A success resets the streak the way it always did — by
 * returning to `initRetry()` — which drops the origin with it, so an operation
 * that fails occasionally never accumulates outage and pays nothing for a wide
 * `maxElapsedMs`; only an unbroken run of failures grows toward the bound.
 */
export interface TimedRetryState extends RetryState {
  /** When the streak's first failure was observed (caller's clock, epoch ms). */
  readonly firstFailureAtMs: number;
}

/** The starting state: zero attempts, no error yet, no streak. */
export function initRetry(): RetryState {
  return { attempt: 0 };
}

/**
 * Record a failed attempt. PURE — returns a *new* state with `attempt`
 * incremented and `lastError` set; the input `state` is never mutated.
 *
 * `atMs` is the instant the failure was OBSERVED, supplied by the caller (the
 * `interpret` handler owns the clock; this module never reads one — invariant
 * 2). Passing it starts the streak clock on the first failure and preserves the
 * original origin on every failure after it, yielding a {@link TimedRetryState}
 * that a duration-bounded policy can be evaluated against. Omit it and the
 * count-bounded behaviour is bit-for-bit what it always was.
 */
export function recordFailure(
  state: TimedRetryState,
  error: unknown,
  atMs?: number,
): TimedRetryState;
export function recordFailure(
  state: RetryState,
  error: unknown,
  atMs: number,
): TimedRetryState;
export function recordFailure(state: RetryState, error: unknown): RetryState;
export function recordFailure(
  state: RetryState & { readonly firstFailureAtMs?: number },
  error: unknown,
  atMs?: number,
): RetryState | TimedRetryState {
  const attempt = state.attempt + 1;
  // The streak's origin is set once, by whichever failure started it.
  const firstFailureAtMs = state.firstFailureAtMs ?? atMs;
  return firstFailureAtMs === undefined
    ? { attempt, lastError: error }
    : { attempt, lastError: error, firstFailureAtMs };
}

/**
 * How long the current failure streak has lasted, in milliseconds. PURE.
 *
 * The honest number for a give-up log — a count of attempts says nothing about
 * how much patience it actually spent. Clamped at 0 so a caller's clock going
 * backwards (NTP step, a rehydrated state whose origin is from a different
 * host) reads as "no outage yet" rather than a negative duration.
 */
export function retryElapsedMs(state: TimedRetryState, nowMs: number): number {
  const elapsed = nowMs - state.firstFailureAtMs;
  return elapsed > 0 ? elapsed : 0;
}

/**
 * Whether another attempt is permitted under `policy`. PURE.
 *
 * Every bound the policy DECLARES must still permit the attempt; a bound it
 * does not declare is not consulted. Concretely:
 *
 *   - `maxAttempts` — `attempt` is the number of failures recorded so far (= the
 *     index of the next attempt); we may retry while that index is below
 *     `maxAttempts`, i.e. attempts `0 .. maxAttempts-1` are allowed and the
 *     `maxAttempts`-th is refused. Unchanged.
 *   - `maxElapsedMs` — we may retry while `nowMs - firstFailureAtMs` is below
 *     the budget, *however many attempts that takes*. A streak's first failure
 *     measures a zero-length outage and is therefore always retried, unless the
 *     budget is itself `0` (the "no patience" setting).
 *   - `unbounded: true` — always permitted.
 *
 * The overloads are the wiring contract. A count-bounded or explicitly
 * unbounded policy needs no clock, so the two-argument call every existing
 * caller already writes keeps type-checking. A policy carrying `maxElapsedMs`
 * matches only the second overload, which demands a {@link TimedRetryState} and
 * a `nowMs` — so declaring an outage budget and then never feeding it a clock
 * fails to compile instead of silently producing a bound that never fires.
 */
export function shouldRetry(
  state: RetryState,
  policy: BackoffCurve & (CountBound | Unbounded),
  nowMs?: number,
): boolean;
export function shouldRetry(
  state: TimedRetryState,
  policy: AnyRetryPolicy,
  nowMs: number,
): boolean;
export function shouldRetry(
  state: RetryState & { readonly firstFailureAtMs?: number },
  policy: AnyRetryPolicy,
  nowMs?: number,
): boolean {
  if (policy.maxAttempts !== undefined && state.attempt >= policy.maxAttempts) {
    return false;
  }
  if (policy.maxElapsedMs === undefined) return true;
  // Reachable only from JS callers or an `as`-cast: the overloads make the
  // origin and the clock mandatory whenever `maxElapsedMs` is declared. Fail to
  // the visibly-broken side — refuse the retry — rather than treating an
  // unmeasurable outage as "still inside the budget" and retrying forever.
  if (state.firstFailureAtMs === undefined || nowMs === undefined) return false;
  return nowMs - state.firstFailureAtMs < policy.maxElapsedMs;
}

/**
 * The delay to wait before the next attempt, given the current state. PURE.
 *
 * Bridges `RetryState` → `backoffDelay` by using `state.attempt` as the 0-based
 * attempt index, so the delay grows with each recorded failure. `rng` is
 * injected for determinism, same contract as `backoffDelay`.
 */
export function nextDelayMs(
  state: RetryState,
  policy: BackoffCurve,
  rng: Rng = defaultRng,
): number {
  return backoffDelay(state.attempt, policy, rng);
}
