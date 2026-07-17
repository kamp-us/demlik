/**
 * @packageDocumentation
 * @demlik/tea/circuit-breaker — per-target failure tracking as pure state + ops.
 *
 * Same shape as `@demlik/tea/work-queue`'s `ops.ts`, `@demlik/tea/rate-limit`,
 * and `@demlik/tea/idempotency`: a state type plus pure transition functions.
 * Host-agnostic by construction — no `Date.now()`, no timers, no I/O. The
 * caller injects the clock (`nowMs`) and wires the result into its own reducer
 * / interpret. This keeps the breaker inside TEA's invariant 2 (transitions are
 * pure: same inputs → same outputs, no `Date.now`) so a consumer can fold it
 * through `update` and exercise it with `replay` / the pbt fold without a fake
 * clock.
 *
 * Every op returns a NEW state value and never mutates its input (invariant 1 —
 * state is a value, not a place). `canPass` returns a `[next, allowed]` tuple so
 * the caller branches on the decision while threading the advanced state forward
 * — same convention as `rate-limit`'s `tryConsume` / `record`. `onSuccess` /
 * `onFailure` are the outcome-recording transitions the caller folds in once the
 * guarded call resolves.
 *
 * ## The phase machine
 *
 * A circuit breaker guards a fallible downstream target (an HTTP backend, a DB,
 * a flaky tool call). Instead of hammering a target that is already failing, it
 * trips OPEN after enough failures and fast-fails subsequent calls for a
 * cooldown, then probes with a few trial calls before fully closing again.
 * Three phases, each carrying ONLY its own data so impossible states are
 * unrepresentable (pattern 11):
 *
 *   - **closed** — the healthy steady state. Calls pass through. Carries
 *     `failures`: the count of *consecutive* failures since the last success.
 *     A success resets it to 0; the `failureThreshold`-th failure trips the
 *     breaker OPEN. Only `closed` has a failure counter — `open` and
 *     `half_open` don't, because in those phases the count is irrelevant
 *     (the breaker has already tripped / is already probing).
 *
 *   - **open** — the tripped state. All calls fast-fail (no downstream load).
 *     Carries `openedAtMs`: the clock reading at which the breaker tripped.
 *     `canPass` compares `nowMs - openedAtMs` against `cooldownMs` to decide
 *     when to start probing. Only `open` carries a timestamp — neither other
 *     phase is timing anything.
 *
 *   - **half_open** — the probing state. A limited number of trial calls are
 *     allowed through to test whether the target has recovered. Carries
 *     `probes`: the count of probes admitted so far this probing round.
 *     `canPass` admits while `probes < halfOpenMaxProbes`, then fast-fails the
 *     rest (so a slow target can't be flooded by every queued caller at once).
 *     A probe success closes the breaker; a probe failure re-opens it (and
 *     resets the cooldown clock). Only `half_open` counts in-flight probes.
 *
 * ### Transition table
 *
 * Rows are the current phase; columns are the event. `→` denotes the next
 * phase; `self` means unchanged. `nowMs` is the injected clock.
 *
 * | from \ event | onSuccess      | onFailure                              | canPass (→ allowed?)                                                                 |
 * | ------------ | -------------- | -------------------------------------- | ------------------------------------------------------------------------------------ |
 * | closed       | closed(0)      | failures+1; trip → open(nowMs) at thr. | self → true (always)                                                                  |
 * | open         | self *(¹)*     | self                                   | elapsed ≥ cooldown → half_open(1), true; else self → false                            |
 * | half_open    | → closed(0)    | → open(nowMs) (probe failed)           | probes < max → half_open(probes+1), true; else self → false                          |
 *
 * *(¹)* `onSuccess` on `open` "shouldn't happen": no call was admitted while
 * open, so no success can be reported for one. We leave the state unchanged
 * rather than throw — the breaker is a coordination aid, not a correctness
 * gate, and a spurious success report (e.g. a late-arriving result from before
 * the trip) must not silently un-trip the breaker. `onFailure` on `open` is
 * likewise a no-op: the breaker is already tripped; the `open` clock is anchored
 * at the trip, not bumped by late failures.
 *
 * ### The probe-admission asymmetry
 *
 * Entering `half_open` happens inside `canPass`, not `onSuccess` / `onFailure`,
 * because the cooldown is a *time* condition and only `canPass` reads the clock
 * against `openedAtMs`. The first `canPass` after the cooldown elapses both
 * transitions the phase AND admits the probe (`[half_open(1), true]`) — one
 * caller drives the recovery attempt. Subsequent `canPass` calls in the same
 * round admit up to `halfOpenMaxProbes` total, then fast-fail until a probe
 * resolves and `onSuccess` / `onFailure` moves the phase out of `half_open`.
 *
 * This module is a textbook three-state machine — a clean `/machine-viz` demo.
 *
 * NOT exported from the package root — reached via the
 * `@demlik/tea/circuit-breaker` subpath, same one-shape-per-package rule as
 * `work-queue`, `rate-limit`, and `idempotency`.
 */

/**
 * Circuit-breaker policy — pure configuration, no mutable state. One policy is
 * shared across all the calls guarded by one logical breaker (often a
 * module-scope const). `CircuitState` carries the mutable counts; this carries
 * the thresholds those counts are compared against.
 */
export interface CircuitPolicy {
  /**
   * Consecutive failures in `closed` that trip the breaker `open`. The
   * `failureThreshold`-th failure is the one that trips — with a threshold of
   * 5, the breaker survives 4 failures and opens on the 5th.
   */
  readonly failureThreshold: number;
  /**
   * How long the breaker stays `open` before `canPass` starts admitting
   * probes, in milliseconds. Measured from `openedAtMs`; the cutoff is
   * half-open (`elapsed >= cooldownMs` admits), matching `rate-limit` /
   * `idempotency` window edges — a breaker opened at `t` first probes at
   * `t + cooldownMs`.
   */
  readonly cooldownMs: number;
  /**
   * How many probe calls `half_open` admits before fast-failing the rest of
   * the round. Caps the load on a recovering target — a single slow probe
   * can't be joined by every queued caller. The round ends when a probe
   * resolves: success closes the breaker, failure re-opens it.
   */
  readonly halfOpenMaxProbes: number;
}

/**
 * Sensible defaults: trip after 5 consecutive failures, cool down for 30s,
 * admit a single probe before deciding. Tuned for guarding a network backend;
 * override per call site rather than mutating this shared const.
 */
export const defaultCircuitPolicy: CircuitPolicy = {
  failureThreshold: 5,
  cooldownMs: 30_000,
  halfOpenMaxProbes: 1,
};

/**
 * The breaker's phase. A discriminated union on `phase` so each phase carries
 * ONLY its own data and impossible combinations are unrepresentable (pattern
 * 11): there is no state with both a failure count AND an open timestamp,
 * because such a state is meaningless. `phase` is the discriminant; every field
 * is `readonly` so the whole value is trivially JSON-serializable into a
 * consumer's `Store<S>` and safe to thread through a pure reducer.
 *
 *   - `closed`    carries `failures`   — consecutive failures since last success.
 *   - `open`      carries `openedAtMs` — clock reading when it tripped.
 *   - `half_open` carries `probes`     — probes admitted this round.
 */
export type CircuitState =
  | { readonly phase: "closed"; readonly failures: number }
  | { readonly phase: "open"; readonly openedAtMs: number }
  | { readonly phase: "half_open"; readonly probes: number };

/** The starting state: closed with zero recorded failures. */
export function initCircuit(): CircuitState {
  return { phase: "closed", failures: 0 };
}

/**
 * Record a successful guarded call. PURE — returns a new state; the input is
 * never mutated.
 *
 *   - `closed`    → reset `failures` to 0 (a success breaks the consecutive run).
 *   - `half_open` → the probe succeeded; the target has recovered → `closed`.
 *   - `open`      → unchanged. A success "shouldn't happen" while open (no call
 *                   was admitted to produce one); a late/spurious success must
 *                   not silently un-trip the breaker. See module header note ¹.
 */
export function onSuccess(
  state: CircuitState,
  _policy: CircuitPolicy,
): CircuitState {
  switch (state.phase) {
    case "closed":
      // Already closed at 0 → return the same shape (cheap; the consumer's
      // store only re-persists on a real change if it dedupes).
      return state.failures === 0 ? state : { phase: "closed", failures: 0 };
    case "half_open":
      return { phase: "closed", failures: 0 };
    case "open":
      return state;
  }
}

/**
 * Record a failed guarded call. PURE — returns a new state; the input is never
 * mutated. `nowMs` is the injected clock, stamped onto the `open` phase when the
 * breaker trips so `canPass` can measure the cooldown later.
 *
 *   - `closed`    → `failures + 1`; if that reaches `failureThreshold`, trip to
 *                   `open(nowMs)`. The threshold-th failure is the one that trips.
 *   - `half_open` → the probe failed; the target is still unhealthy →
 *                   `open(nowMs)`, restarting the cooldown clock so a fresh
 *                   cooldown elapses before the next probe round.
 *   - `open`      → unchanged. The breaker is already tripped; the `open` clock
 *                   is anchored at the original trip, not bumped by late
 *                   failures. See module header note ¹.
 */
export function onFailure(
  state: CircuitState,
  policy: CircuitPolicy,
  nowMs: number,
): CircuitState {
  switch (state.phase) {
    case "closed": {
      const failures = state.failures + 1;
      // `>=` not `===`: a threshold of 0 (or any already-exceeded count from a
      // policy change) trips immediately rather than over-counting forever.
      return failures >= policy.failureThreshold
        ? { phase: "open", openedAtMs: nowMs }
        : { phase: "closed", failures };
    }
    case "half_open":
      // A failed probe re-opens and resets the cooldown clock to nowMs.
      return { phase: "open", openedAtMs: nowMs };
    case "open":
      return state;
  }
}

/**
 * Decide whether a call may pass, advancing the phase as a side effect of the
 * decision. PURE — returns `[next, allowed]`; the input is never mutated.
 * Branch on the boolean, thread the state forward regardless:
 *
 *   const [c1, allowed] = canPass(state.circuit, policy, nowMs);
 *   if (!allowed) return [{ ...state, circuit: c1 }, [fastFailCmd]];
 *   return [{ ...state, circuit: c1 }, [doGuardedCallCmd]];
 *
 *   - `closed`    → `[state, true]` — always passes; failures are recorded by
 *                   `onFailure` once the call resolves, not gated here.
 *   - `open`      → if `nowMs - openedAtMs >= cooldownMs` the cooldown has
 *                   elapsed → enter `half_open` and admit this caller as the
 *                   first probe: `[half_open(1), true]`. Otherwise still cooling
 *                   down → `[state, false]` (fast-fail, no downstream load).
 *   - `half_open` → admit while `probes < halfOpenMaxProbes`, incrementing the
 *                   count: `[half_open(probes+1), true]`. Once the cap is hit →
 *                   `[state, false]` until a probe resolves and `onSuccess` /
 *                   `onFailure` moves the phase out of `half_open`.
 *
 * Entering `half_open` lives here (not in `onSuccess` / `onFailure`) because the
 * cooldown is a time condition and only `canPass` reads `nowMs` against
 * `openedAtMs`. See the module header's probe-admission note.
 */
export function canPass(
  state: CircuitState,
  policy: CircuitPolicy,
  nowMs: number,
): readonly [CircuitState, boolean] {
  switch (state.phase) {
    case "closed":
      return [state, true];
    case "open": {
      const elapsed = nowMs - state.openedAtMs;
      // Half-open cutoff: elapsed exactly == cooldownMs admits the first probe,
      // matching the >= edge `rate-limit` / `idempotency` use for their windows.
      if (elapsed >= policy.cooldownMs) {
        return [{ phase: "half_open", probes: 1 }, true];
      }
      return [state, false];
    }
    case "half_open":
      if (state.probes < policy.halfOpenMaxProbes) {
        return [{ phase: "half_open", probes: state.probes + 1 }, true];
      }
      return [state, false];
  }
}
