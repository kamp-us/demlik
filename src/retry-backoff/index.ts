/**
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
 * The reducer stays pure: `nextDelayMs` is called with the runtime's RNG only
 * at the emit boundary (or the caller defers the whole delay computation to the
 * `interpret` handler and passes `rng` there). Either way the substrate never
 * sees `Math.random()` inside a transition body.
 *
 * NOT a substrate primitive: it depends on nothing from `../index`. It is a
 * leaf utility consumers reach via the `@demlik/tea/retry-backoff` subpath.
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
 * A retry policy is pure configuration — the knobs of the backoff curve. It
 * carries no mutable state; `RetryState` does. One policy is shared across all
 * the attempts of one logical operation (often a module-scope const).
 */
export interface RetryPolicy {
  /** Delay for attempt 0, in milliseconds, before any jitter or cap. */
  readonly baseMs: number;
  /** Geometric growth factor. `2` doubles the delay each attempt. */
  readonly factor: number;
  /** Hard ceiling, in milliseconds. The capped exponential never exceeds this. */
  readonly capMs: number;
  /**
   * Maximum number of attempts. `shouldRetry` allows attempts `0 .. maxAttempts-1`,
   * so `maxAttempts: 3` means "try once, then retry at most twice" (attempts 0, 1, 2).
   */
  readonly maxAttempts: number;
  /** Jitter strategy applied to the capped exponential delay. */
  readonly jitter: Jitter;
}

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
  policy: RetryPolicy,
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

/** The starting state: zero attempts, no error yet. */
export function initRetry(): RetryState {
  return { attempt: 0 };
}

/**
 * Record a failed attempt. PURE — returns a *new* state with `attempt`
 * incremented and `lastError` set; the input `state` is never mutated.
 */
export function recordFailure(state: RetryState, error: unknown): RetryState {
  return { attempt: state.attempt + 1, lastError: error };
}

/**
 * Whether another attempt is permitted under `policy`. PURE.
 *
 * `attempt` is the number of failures recorded so far (= the index of the next
 * attempt). We may retry while that index is below `maxAttempts`, i.e. attempts
 * `0 .. maxAttempts-1` are allowed and the `maxAttempts`-th is refused.
 */
export function shouldRetry(state: RetryState, policy: RetryPolicy): boolean {
  return state.attempt < policy.maxAttempts;
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
  policy: RetryPolicy,
  rng: Rng = defaultRng,
): number {
  return backoffDelay(state.attempt, policy, rng);
}
