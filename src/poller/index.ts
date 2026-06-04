/**
 * @demlik/tea/poller — "poll a source every N ms until a predicate holds, with
 * backoff on failure" as a TEA knob: one config object + a few pre-wired hooks
 * you spread into your machine.
 *
 * The recipe (which bricks it composes):
 *
 *   - `../deadline`        — the recurring tick is an ABSOLUTE-deadline Sub.
 *                            Each successful tick computes the NEXT absolute
 *                            fire time (`at + everyMs`) and the knob re-arms a
 *                            deadline against it. Absolute (not relative) so a
 *                            poller resumed after a DO eviction / page reload
 *                            fires at the correct wall-clock moment, not
 *                            `everyMs` after the reload (`../deadline`'s late-
 *                            subscribe property).
 *   - `../retry-backoff`   — a failed tick does NOT reschedule on the steady
 *                            cadence; it backs off. The next attempt is armed
 *                            `nextDelayMs(retry, policy)` from now, the retry
 *                            counter advances, and `shouldRetry` decides whether
 *                            the poller keeps trying or gives up.
 *   - `../idempotency`     — successive ticks against a flaky source can deliver
 *                            the SAME observation twice (a retried fetch, a
 *                            duplicate webhook the poll re-reads). `dedupeKey`
 *                            lets the consumer key each tick result; a duplicate
 *                            key is recorded but emits no fresh `onTick` follow-
 *                            up Cmd, so the side effect runs once per distinct
 *                            observation.
 *
 * Typical wiring (spread the knob's hooks into your machine):
 *
 *   const poll = createPoller<MyState, MyResult>({
 *     everyMs: 5_000,
 *     until: (s) => s.poll.lastResult?.status === "ready",
 *     onTick: () => ({ type: "fetch_status" }),
 *     retry: { ...defaultRetryPolicy, maxAttempts: 4 },
 *   });
 *
 *   // Model slice:
 *   init: (loaded) => [loaded ?? { poll: poll.init(), ... }, []],
 *
 *   // The deadline Sub fires `deadline_exceeded` on the cadence/backoff target;
 *   // route it to `tick`, the ONLY place the `onTick` fetch is emitted:
 *   deadline_exceeded: (s) => {
 *     const [slice, cmds] = poll.tick(s.poll);
 *     return [{ ...s, poll: slice }, cmds];
 *   },
 *
 *   // update cells (thread `at` in from the firing Msg / the runtime clock):
 *   poll_result: (s, m) => {
 *     const untilHeld = config.until({ ...s, ...folded });
 *     const [slice, cmds] = poll.tickResult(s.poll, m.result, m.at, untilHeld);
 *     return [{ ...s, poll: slice }, cmds];
 *   },
 *   poll_error: (s, m) => {
 *     const [slice, cmds] = poll.tickErr(s.poll, m.error, m.at);
 *     return [{ ...s, poll: slice }, cmds];
 *   },
 *
 *   // Subs — the knob owns the interval/backoff deadline:
 *   subscriptions: (s) => poll.subs(s.poll),
 *
 * The cadence has exactly ONE source: the `everyMs` deadline Sub. `start`,
 * `tickResult`, and `tickErr` only RE-ARM the deadline (they emit no cadence
 * Cmd); the fetch fires solely from `tick`, which the consumer routes the
 * deadline's `deadline_exceeded` Msg to. No verb performs an immediate
 * "fire now" observation, so the poller never polls faster than `everyMs`.
 *
 * The two non-negotiables every knob preserves hold here:
 *   - **Durable** — `tick`, `lastResult`, `retry`, and the next-fire target all
 *     live in the Model slice, so a poller survives eviction and resumes its
 *     cadence from the persisted target.
 *   - **Replayable** — every transition is a pure verb returning new state; the
 *     clock is never read inside a verb (the firing Msg carries `at`), and the
 *     retry RNG is injected ONCE at `createPoller` and threaded internally (no
 *     verb body names the global RNG). `replay` reconstructs a poll run exactly.
 *
 * NOT a substrate primitive: it depends only on sibling subpaths
 * (`../deadline`, `../retry-backoff`, `../idempotency`) and the core `Cmd` /
 * `Sub` types. Consumers reach it via the `@demlik/tea/poller` subpath; the L1
 * escape hatch is those three sibling subpaths threaded by hand.
 */

import { type DeadlineSub, deadlineSub } from "../deadline";
import {
  type IdempotencyStore,
  initStore as initDedupeStore,
  remember,
  seen,
} from "../idempotency";
import type { Cmd, Sub } from "../index";
import {
  defaultRetryPolicy,
  initRetry,
  nextDelayMs,
  type RetryPolicy,
  type RetryState,
  recordFailure,
  shouldRetry,
} from "../retry-backoff";

/**
 * The poller knob's config — the single object you hand `createPoller`.
 *
 * `State` is the consumer's WHOLE Model (so `until` can read any field), `R` is
 * the shape of one tick observation (`lastResult` carries it forward).
 */
export interface PollerConfig<State, R> {
  /**
   * The steady cadence, in milliseconds, between successful ticks. The next
   * tick is armed at the absolute target `at + everyMs` (computed from the
   * `at` the prior tick's Msg carried), NOT `everyMs` from when the Sub
   * happens to be reconciled — so the cadence does not drift across resumes.
   */
  readonly everyMs: number;
  /**
   * The stop predicate, read against the consumer's whole Model. When it
   * returns `true`, the poller is DONE: `subs` returns `[]` (the timer
   * disarms) and no further tick is scheduled. Pure — it must not read the
   * clock or mutate; the substrate calls it inside `subscriptions(state)`.
   */
  readonly until: (state: State) => boolean;
  /**
   * The effect to run on each tick — the actual "go observe the source" Cmd
   * (a fetch, a status read, a list call). The knob returns it from
   * `tickResult` when the run continues; the consumer's `interpret` performs
   * it and routes the observation back as the next tick-result Msg.
   *
   * Nullary by contract: a tick carries no per-call argument (the poller
   * re-reads the same source every cadence). Capture any target in the Cmd
   * literal the consumer's `onTick` returns.
   */
  readonly onTick: () => Cmd;
  /**
   * Backoff policy for FAILED ticks. Omit to use `defaultRetryPolicy`
   * (full-jitter, 5 attempts). A success resets the retry counter, so the
   * policy only governs consecutive failures.
   */
  readonly retry?: RetryPolicy;
  /**
   * Optional dedupe key derived from a tick result. When provided, a result
   * whose key was already `seen` records the observation but emits NO fresh
   * `onTick` follow-up — the side effect runs once per distinct observation.
   * Omit to treat every tick result as fresh (no dedupe). The dedupe store is
   * bounded by `dedupeTtlMs` if set; otherwise it grows with distinct keys.
   */
  readonly dedupeKey?: (result: R) => string;
  /**
   * TTL for the dedupe store, in milliseconds. Only meaningful when
   * `dedupeKey` is set. An observation older than `dedupeTtlMs` is forgotten,
   * so a key seen long ago is treated as fresh again. Omit for an unbounded
   * dedupe window (every distinct key remembered for the poller's lifetime).
   */
  readonly dedupeTtlMs?: number;
}

/**
 * The Model field the poller knob owns — its visible slice (the knob principle:
 * managed state lives in the Model, never a closure, so it is durable and
 * replayable).
 *
 * - `tick`       — count of ticks recorded so far (success or failure). Doubles
 *                  as an observability cursor and a stable per-tick discriminant.
 * - `lastResult` — the most recent successful observation, or `undefined`
 *                  before the first success. `until` typically reads it (via the
 *                  consumer's Model), but the knob never interprets it.
 * - `retry`      — the `../retry-backoff` counter for consecutive failures.
 *                  Reset to `initRetry()` on every success.
 * - `nextAtMs`   — the ABSOLUTE target the interval/backoff timer is armed
 *                  against, or `null` when the poller is done / not yet started.
 *                  Persisted so a resumed poller re-arms the same moment.
 * - `phase`      — `"polling"` while ticks are scheduled, `"done"` once `until`
 *                  held, `"gave_up"` once backoff exhausted `maxAttempts`.
 * - `dedupe`     — the `../idempotency` store backing `dedupeKey`. An empty,
 *                  unbounded store when `dedupeKey` is unset (never written).
 */
export interface PollerState<R> {
  readonly tick: number;
  readonly lastResult?: R;
  readonly retry: RetryState;
  readonly nextAtMs: number | null;
  readonly phase: "polling" | "done" | "gave_up";
  readonly dedupe: IdempotencyStore<true>;
}

/**
 * The poller Sub type — a `../deadline` Sub under a fixed id family. One id per
 * knob instance keeps the reconcile pass from churning the timer: the same id
 * across transitions means "same armed deadline", even as `nextAtMs` advances.
 */
export type PollerSub = DeadlineSub;

/**
 * The Sub id the poller arms its tick deadline under, keyed on the absolute
 * target. The id ROTATES per target because a one-shot deadline timer is
 * exhausted once it fires and the substrate reconciles subs by `id` alone: a
 * fixed id would leave the fired timer registered and never re-arm, so the
 * cadence would die after exactly one tick. Encoding `atMs` in the id makes each
 * cadence/backoff target a distinct identity — the reconcile pass retires the
 * spent timer and arms the next — while a resumed poller re-arms the SAME id
 * from its persisted `nextAtMs` (eviction is idempotent).
 *
 * A single poller machine arms exactly one tick timer at a time; a consumer
 * running several pollers on one machine namespaces them by composing the knob
 * under distinct slices (a future multi-poller config would thread a prefix).
 */
function pollerSubId(atMs: number): string {
  return `poller:tick:${atMs}`;
}

/**
 * The knob handle returned by `createPoller`. Spread its hooks into your
 * machine: `init()` seeds the slice, `start(...)` arms the first tick,
 * `tickResult` / `tickErr` are the two update verbs, and `subs(...)` returns the
 * timer Sub while the poller is live.
 *
 * Pure-ops + subs module: there is no `handlers(ports)` cell. The poller's I/O
 * is the consumer's own `onTick` Cmd run by the consumer's `interpret` — the
 * knob never owns a port. (Compare `../deadline`, which ships a `subscribe`
 * cell; the poller reuses `../deadline`'s, so it has nothing of its own to
 * splice into `interpret`.)
 */
export interface Poller<
  // State is a phantom-style parameter — present so consumers can spell
  // `Poller<MyState, MyResult>` matching `createPoller<State, R>`. It is
  // consumed by the config's `until` predicate, not by any handle method, so
  // it does not appear in the interface body. Same discipline as
  // `BoundMachine`'s `Ctx`.
  // biome-ignore lint/correctness/noUnusedVariables: phantom type parameter (see above)
  State,
  R,
> {
  /** Seed the Model slice. Idle until `start(...)` arms the first tick. */
  init(): PollerState<R>;
  /**
   * Arm the first tick. `at` is the current clock (carried in from the Msg /
   * runtime that kicks the poller off — never read inside the verb). Returns
   * the slice with the first deadline target set to `at + everyMs` and emits NO
   * Cmd. The cadence has ONE source — the deadline Sub — so `start` does not
   * perform the first observation itself (an immediate `onTick` here would race
   * the timer and poll as fast as the source responds). The first observation
   * fires when the deadline crosses `at + everyMs` and the consumer routes
   * `deadline_exceeded` → `tick`.
   */
  start(
    state: PollerState<R>,
    at: number,
  ): readonly [PollerState<R>, readonly Cmd[]];
  /**
   * Perform one observation — the cadence verb. The consumer routes the
   * deadline Sub's `deadline_exceeded` Msg here; `tick` emits the single
   * `config.onTick()` Cmd that goes and reads the source. This is the ONLY
   * next-tick mechanism: the timer fires, the consumer calls `tick`, the fetch
   * runs, and the observation comes back through `tickResult` / `tickErr`
   * (which re-arm the next deadline). A no-op on a finished poller — a stale
   * deadline fire racing a terminal transition the reconcile pass has not yet
   * retired emits nothing.
   *
   * Takes no `at`: `tick` does not touch the schedule (the just-fired deadline
   * is exhausted; the next target is set when the result lands), so it needs no
   * clock — keeping it trivially pure.
   */
  tick(state: PollerState<R>): readonly [PollerState<R>, readonly Cmd[]];
  /**
   * Record a successful tick observation at clock `at`.
   *
   * - Resets the retry counter (a success clears consecutive-failure state).
   * - Stores `result` as `lastResult` and bumps `tick`.
   * - Re-arms the next tick at the absolute target `at + everyMs` (the steady
   *   cadence). It emits NO cadence `onTick` — the next observation fires from
   *   the deadline Sub via `tick`, never immediately from a result.
   * - Dedupe (opt-in, orthogonal to cadence): when `dedupeKey` is set, a FRESH
   *   observation emits one `onTick` FOLLOW-UP (the consumer's "run the
   *   downstream side effect once per distinct observation" hook) and a
   *   DUPLICATE key records the sighting but suppresses the follow-up. With no
   *   `dedupeKey`, `tickResult` emits nothing — the cadence `tick` is the only
   *   `onTick`, so an unconfigured poller never double-fetches.
   * - UNLESS `untilHeld` is `true` (the consumer evaluated `config.until`
   *   against the post-result Model) — then the poller enters `"done"`,
   *   disarms (`nextAtMs: null`), and emits no Cmd, dedupe or otherwise.
   *
   * `untilHeld` is passed in rather than computed here because `until` reads
   * the consumer's WHOLE Model, which this verb does not hold — the consumer
   * evaluates it at the call site after folding `result` into its Model and
   * passes the boolean. (`subs` re-checks `phase` to decide arming, so a
   * mis-passed `untilHeld` cannot leave a "done" poller arming timers.)
   */
  tickResult(
    state: PollerState<R>,
    result: R,
    at: number,
    untilHeld: boolean,
  ): readonly [PollerState<R>, readonly Cmd[]];
  /**
   * Record a FAILED tick at clock `at`. Backs off instead of holding the
   * steady cadence:
   *
   * - Advances the retry counter (`recordFailure`).
   * - If `shouldRetry` still permits another attempt, arms the next tick at
   *   `at + nextDelayMs(retry, policy)` (the backoff curve) and emits NO Cmd —
   *   the retry observation fires when that backoff deadline crosses and the
   *   consumer routes `deadline_exceeded` → `tick`. The timer is the single
   *   next-tick mechanism, on the backoff curve here instead of `everyMs`.
   * - If backoff is exhausted (`!shouldRetry`), enters `"gave_up"`, disarms
   *   (`nextAtMs: null`), and emits no Cmd.
   *
   * The backoff jitter uses the `rng` injected ONCE at `createPoller` (default
   * `Math.random` at the effect boundary, a fixed value in tests); the verb
   * body never names the global RNG, so a poller built with a fixed `rng`
   * replays a failure-and-backoff run bit-for-bit.
   */
  tickErr(
    state: PollerState<R>,
    error: unknown,
    at: number,
  ): readonly [PollerState<R>, readonly Cmd[]];
  /**
   * The pre-wired subscriptions cell. Returns the single tick-deadline Sub
   * while the poller is `"polling"` with an armed `nextAtMs`; returns `[]`
   * once `"done"` / `"gave_up"` (the timer disarms) or before `start`. Assign
   * directly: `subscriptions: (s) => poll.subs(s.poll)`.
   *
   * The `DeadlineSub` it returns is consumed by `../deadline`'s
   * `subscribeDeadline` cell, which the consumer wires into `subscribe` —
   * the poller does not redraw the timer lifecycle.
   */
  subs(state: PollerState<R>): readonly Sub[];
}

/**
 * Build a poller knob from `config`. Returns the hook bag to spread into a
 * machine (see the module doc-comment for the wiring). Pure factory — no clock
 * read, no timer; everything happens when the consumer calls the returned
 * verbs / `subs` with an injected `at`.
 *
 * `rng` is injected ONCE here (default `Math.random` at the effect boundary, a
 * fixed value in tests) and threaded internally into the backoff jitter. No
 * verb body ever names the global RNG, so a poller built with a fixed `rng`
 * replays a failure-and-backoff run bit-for-bit (invariant 2: the verbs are
 * pure given the injected `rng`).
 */
export function createPoller<State, R>(
  config: PollerConfig<State, R>,
  rng: () => number = Math.random,
): Poller<State, R> {
  const policy: RetryPolicy = config.retry ?? defaultRetryPolicy;

  function init(): PollerState<R> {
    return {
      tick: 0,
      retry: initRetry(),
      nextAtMs: null,
      phase: "polling",
      // The dedupe store is created regardless; it is only WRITTEN when
      // `dedupeKey` is set, so an unconfigured poller carries an inert empty
      // store (no per-op cost, JSON-serializable, durable like the rest of
      // the slice).
      dedupe: initDedupeStore<true>({ ttlMs: config.dedupeTtlMs }),
    };
  }

  function start(
    state: PollerState<R>,
    at: number,
  ): readonly [PollerState<R>, readonly Cmd[]] {
    // Arm the first deadline at `at + everyMs` and emit NOTHING. The cadence has
    // ONE source — the `everyMs` deadline Sub. `start` does not perform the
    // first observation itself: that would be a second, immediate next-tick
    // mechanism racing the timer (it would fire as fast as the source responds,
    // never honoring `everyMs`). The first observation fires when the deadline
    // crosses `at + everyMs` and the consumer routes `deadline_exceeded` → the
    // `tick` verb (which emits `onTick`). No drift, no double-fire.
    return [{ ...state, phase: "polling", nextAtMs: at + config.everyMs }, []];
  }

  function tick(
    state: PollerState<R>,
  ): readonly [PollerState<R>, readonly Cmd[]] {
    // The deadline fired. Perform the observation — this is the ONLY place the
    // `onTick` Cmd is emitted, so the timer is the single next-tick mechanism.
    // No schedule change here: the just-fired deadline is exhausted, and the
    // NEXT target is re-armed when the observation lands (`tickResult` /
    // `tickErr`). A no-op on a finished poller (a stale fire racing a terminal
    // transition the reconcile pass has not yet retired).
    if (state.phase !== "polling") return [state, []];
    return [state, [config.onTick()]];
  }

  function tickResult(
    state: PollerState<R>,
    result: R,
    at: number,
    untilHeld: boolean,
  ): readonly [PollerState<R>, readonly Cmd[]] {
    // A success always clears consecutive-failure state and records the datum.
    const base: PollerState<R> = {
      ...state,
      tick: state.tick + 1,
      lastResult: result,
      retry: initRetry(),
    };

    // Stop condition first: if the consumer's `until` held against the
    // post-result Model, we are DONE — disarm and emit nothing, regardless of
    // dedupe (the final observation is still recorded as `lastResult`).
    if (untilHeld) {
      return [{ ...base, phase: "done", nextAtMs: null }, []];
    }

    // Re-arm the steady cadence: the next observation fires when THIS deadline
    // (`at + everyMs`) crosses and the consumer routes `deadline_exceeded` →
    // `tick`. `tickResult` itself never emits the cadence `onTick` — the timer
    // is the single next-tick mechanism (recording a result is not a reason to
    // immediately re-fetch; that would poll as fast as the source responds).
    const next: PollerState<R> = {
      ...base,
      phase: "polling",
      nextAtMs: at + config.everyMs,
    };

    // Dedupe is an OPT-IN follow-up, orthogonal to the cadence above. When
    // `dedupeKey` is set, a FRESH observation emits one `onTick` follow-up (the
    // consumer's "run the downstream side effect once per distinct observation"
    // hook); a DUPLICATE key records the sighting but suppresses that follow-up.
    // With no `dedupeKey` there is no follow-up at all — the cadence `tick` is
    // the only `onTick`, so an unconfigured poller never double-fetches.
    if (!config.dedupeKey) return [next, []];

    const key = config.dedupeKey(result);
    const suppress = seen(next.dedupe, key, at);
    // `remember` refreshes the key's TTL clock on every sighting (the
    // idempotency "touch" semantics), so a steadily-repeating observation never
    // ages out mid-poll. The stored value is the unit `true` — the poller only
    // needs presence, not a payload.
    const deduped: PollerState<R> = {
      ...next,
      dedupe: remember(next.dedupe, key, true, at),
    };
    return [deduped, suppress ? [] : [config.onTick()]];
  }

  function tickErr(
    state: PollerState<R>,
    error: unknown,
    at: number,
  ): readonly [PollerState<R>, readonly Cmd[]] {
    const retry = recordFailure(state.retry, error);
    const failed: PollerState<R> = { ...state, tick: state.tick + 1, retry };

    // Backoff exhausted → give up: disarm and emit nothing. `shouldRetry`
    // reads the just-advanced `retry`, so the (maxAttempts)-th failure is the
    // one that stops the poller.
    if (!shouldRetry(retry, policy)) {
      return [{ ...failed, phase: "gave_up", nextAtMs: null }, []];
    }

    // Back off: arm the next attempt at `at + backoff(retry)` rather than the
    // steady cadence, and emit NOTHING. The retry observation fires when this
    // backoff deadline crosses and the consumer routes `deadline_exceeded` →
    // `tick` — the timer is the single next-tick mechanism, on the backoff
    // curve here instead of `everyMs`. `rng` is the value injected once at
    // `createPoller`; the verb body never names the global RNG, so a fixed
    // `rng` makes the backoff target replay bit-for-bit.
    const delayMs = nextDelayMs(retry, policy, rng);
    return [{ ...failed, phase: "polling", nextAtMs: at + delayMs }, []];
  }

  function subs(state: PollerState<R>): readonly Sub[] {
    // Arm the tick deadline only while live. `phase` is the authority (so a
    // mis-passed `untilHeld` into `tickResult` cannot resurrect a finished
    // poller); `nextAtMs` is the absolute target `../deadline` translates to a
    // remaining delay at subscribe time — a resumed poller re-arms the exact
    // persisted moment.
    if (state.phase !== "polling" || state.nextAtMs === null) return [];
    // The Sub id ROTATES with the target. A one-shot deadline timer is
    // exhausted once it fires, and the substrate's reconcile pass keys identity
    // by `id` alone — a fixed id would leave the fired timer in the registry and
    // NEVER re-arm for the next cadence (cadence dies after one tick). Folding
    // `nextAtMs` into the id makes each successive target a distinct identity:
    // the reconcile pass retires the spent timer (old id absent from the desired
    // set) and arms the next one (new id). A resumed poller re-arms the SAME id
    // from its persisted `nextAtMs`, so eviction is idempotent.
    return [deadlineSub(pollerSubId(state.nextAtMs), state.nextAtMs)];
  }

  return { init, start, tick, tickResult, tickErr, subs };
}
