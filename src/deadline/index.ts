/**
 * @demlik/tea/deadline — a one-shot Sub that fires when an ABSOLUTE wall-clock
 * deadline is reached.
 *
 * Generalizes the recurring "auto-fail a machine at T+N" / "15-minute stale
 * guard" pattern: a Sub whose `subscriptions(state)` returns it only while the
 * deadline should be armed, and which dispatches a single `DeadlineExceeded`
 * Msg when the wall clock crosses `atMs`.
 *
 * Difference from `fromTimeout` (relative — "fire after N ms"): a deadline is
 * an ABSOLUTE target. The delay is computed at subscribe time as
 * `max(0, atMs - Date.now())`. The consequence that matters: subscribing LATE —
 * e.g. after a `Store` rehydrate that resumes a machine whose deadline was set
 * before the page reloaded — still fires at the correct absolute moment,
 * because the remaining delay is recomputed from the current clock, not stored
 * in the Sub. A deadline already in the past at subscribe time yields delay `0`,
 * so `setTimeout(fn, 0)` fires on the NEXT tick (never synchronously inside the
 * reconcile pass — the substrate must finish wiring all subs before any Msg
 * lands).
 *
 * Composition over reinvention: the timer lifecycle is `fromTimeout`'s, not
 * redrawn here. `deadlineSub` produces the Sub literal carrying `atMs`; the
 * `subscribe` cell (`subscribeDeadline`) translates `atMs` → a relative delay
 * and delegates the `setTimeout` / `clearTimeout` to `fromTimeout`. The clock
 * read (`Date.now()`) lives only in the subscribe handler — never in a reducer
 * (invariant 2) — and is exercised in tests via vitest fake timers, matching
 * the no-injection convention of the `fromTimeout` / `fromInterval` exemplars.
 *
 * Strengthens invariant 4 (external time is a subscription — the deadline is a
 * `Sub` the runtime reconciles, never a `setTimeout` leaked into a reducer) and
 * invariant 7 (identity is explicit — the Sub carries a stable `SubId`, so the
 * reconcile pass leaves it running across transitions instead of churning it).
 */

import { type Sub, subId } from "../index";
import { fromTimeout } from "../subs/from-timeout";
import type { SubscribeHandler } from "../subs/types";

/**
 * The Sub variant a deadline produces. `atMs` is the absolute target — epoch
 * milliseconds (the `Date.now()` / `Date.parse(...)` scale), NOT a relative
 * delay. It rides on the Sub so the reconcile pass keys identity by `id`
 * alone: the same `id` across transitions means the same armed timer, even if
 * a later `subscriptions(state)` recomputes the literal.
 *
 * Lowercase `"deadline"` discriminant per the Sub naming convention (a source
 * noun that doubles as the SubId family); same shape family as the
 * `TimeoutSubData` the `fromTimeout` factory consumes.
 */
export type DeadlineSub = Sub<"deadline"> & { readonly atMs: number };

/**
 * The Msg the deadline dispatches when the wall clock crosses `atMs`. Exported
 * as a tagged shape so consumers can union it into their machine's Msg type and
 * handle it in a reducer cell. `id` lets a reducer disambiguate WHICH deadline
 * fired when a machine arms several at once; `atMs` echoes the target the timer
 * was scheduled against (useful for assertions / observability).
 *
 * Snake-shaped `"deadline_exceeded"` matches the tagged-Msg style this module's
 * orchestrator requested; the actor-in-name PascalCase convention
 * (`TimerFiredDeadline`) is the consumer's to apply at their own boundary if
 * they prefer — `deadlineExceeded(...)` only fixes the wire shape, not the
 * consumer's local dialect.
 */
export type DeadlineExceeded = {
  readonly type: "deadline_exceeded";
  readonly id: string;
  readonly atMs: number;
};

/**
 * Build a deadline Sub literal. Pure data — no clock read, no timer; the timer
 * is armed later by the `subscribe` cell. `id` is branded via `subId(...)` so
 * accidental raw-string drift fails at the type level (invariant 7).
 *
 * Return the result directly from `subscriptions(state)` while the deadline
 * should be armed; drop it (return `[]`, or stop returning this id) to disarm —
 * the reconcile pass calls the cleanup, clearing the pending timer before it
 * fires. That is the "cancel on state exit" lifecycle, identical to
 * `fromTimeout`'s.
 *
 * @param id   Stable identity for this deadline. Same `id` across transitions =
 *             same armed timer (no churn). Use distinct ids for distinct
 *             deadlines on the same machine.
 * @param atMs Absolute target in epoch milliseconds (e.g. `Date.now() + 900_000`
 *             for a 15-minute guard, or a persisted `expiresAt`).
 */
export function deadlineSub(id: string, atMs: number): DeadlineSub {
  return { id: subId(id), type: "deadline", atMs };
}

/**
 * The `subscribe["deadline"]` cell. Arms a one-shot timer for the remaining
 * delay `max(0, atMs - Date.now())` and dispatches `deadlineExceeded(...)` when
 * it fires; returns a cleanup that clears the pending timer.
 *
 * Composes on `fromTimeout`: it adapts the absolute `atMs` on the Sub to the
 * relative `delayMs` that `fromTimeout` schedules against, then hands off the
 * `setTimeout` / `clearTimeout` lifecycle wholesale. A past deadline collapses
 * to `delayMs: 0`, so `fromTimeout` fires on the next tick — asynchronously,
 * never inside the reconcile pass.
 *
 * Assign directly to a `Subscribe` cell:
 *
 *   subscribe: {
 *     deadline: subscribeDeadline,
 *   }
 */
export const subscribeDeadline: SubscribeHandler<
  DeadlineSub,
  DeadlineExceeded,
  unknown
> = (sub, ctx, dispatch) => {
  // Recompute the remaining delay from the CURRENT clock so a late subscribe
  // (post-rehydrate) still targets the correct absolute moment. `max(0, …)`
  // keeps a past deadline at delay 0 → setTimeout(fn, 0) → fires next tick, not
  // synchronously.
  const remainingMs = Math.max(0, sub.atMs - Date.now());

  // Delegate the timer lifecycle to fromTimeout: build the relative-delay Sub
  // shape it consumes (`{ ...sub, delayMs }`) and let it own setTimeout /
  // clearTimeout. The msgFn closes over the deadline's identity + target so the
  // dispatched Msg carries both.
  return fromTimeout<DeadlineSub & { delayMs: number }, DeadlineExceeded>(
    (armed) => deadlineExceeded(armed.id, armed.atMs),
  )({ ...sub, delayMs: remainingMs }, ctx, dispatch);
};

/**
 * Construct the Msg the deadline dispatches. Exported so consumers can build /
 * assert the same shape (and so the subscribe cell and tests share one
 * constructor rather than two literals that can drift).
 */
export function deadlineExceeded(id: string, atMs: number): DeadlineExceeded {
  return { type: "deadline_exceeded", id, atMs };
}
