/**
 * internal/resilience/deadline — a one-shot Sub that fires when an ABSOLUTE wall-clock
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
 * `subscribe` handler (`subscribeDeadline`) translates `atMs` → a relative delay
 * and delegates the `setTimeout` / `clearTimeout` to `fromTimeout`. The clock
 * read (`Date.now()`) lives only in the subscribe handler — never in a reducer
 * (invariant 2) — and is exercised in tests via vitest fake timers, matching
 * the no-injection convention of the `fromTimeout` / `fromInterval` exemplars.
 *
 * WHAT BACKS THE TIMER IS THE HOST'S CHOICE. `setTimeout` is the universal
 * default, but it is not universal: a Durable Object that hibernates has no
 * live `setTimeout` to wake it, so its deadline must be backed by a `do_alarm`
 * registered on the alarm registry; a test host wants a fake-timer schedule.
 * That backing is the `ArmTimer` seam — `subscribeWith(armTimer)` builds the
 * `subscribe.deadline` handler from a host-plugged timer, and `subscribeDeadline`
 * IS `subscribeWith(setTimeoutArmTimer())`. One deadline surface, three hosts;
 * there is no second Sub type and no second `atMs` anchor to keep in sync.
 *
 * The anchor is what makes the seam safe. `atMs` is ABSOLUTE, so whatever backs
 * it arms to a fixed wall-clock instant: the host computes the gap itself
 * (`atMs - Date.now()`), and on a host that just rehydrated after hibernation
 * that gap is the SHRUNKEN remainder — the deadline honours the original target
 * rather than resetting to a fresh full-length window.
 *
 * Strengthens invariant 4 (external time is a subscription — the deadline is a
 * `Sub` the runtime reconciles, never a `setTimeout` leaked into a reducer) and
 * invariant 7 (identity is explicit — the Sub carries a stable `SubId`, so the
 * reconcile pass leaves it running across transitions instead of churning it).
 */

import { type Sub, type SubId, subId } from "../../../index";
import { fromTimeout } from "../../../subs/from-timeout";
import type { SubscribeHandler } from "../../../subs/types";

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
export type DeadlineSub<N extends string | undefined = undefined> =
  Sub<"deadline"> & {
    readonly atMs: number;
  } & DeadlineOpts<N>;

/**
 * Additive options the `deadlineSub` factory folds onto the Sub literal. This
 * is the extension seam (invariant 5 — composition by reduction): future fields
 * — `repeatMs` for a re-arming deadline, `jitterMs` for spread, etc. — land HERE
 * as optional members, and every existing call site keeps compiling because the
 * factory's third parameter is optional and the fields are `readonly` optionals
 * on `DeadlineSub`. Callers are insulated from the concrete `DeadlineSub` shape:
 * they ask for what they need by name, never positionally, so a shape extension
 * never rewrites the ~13 `deadlineSub(id, atMs)` call sites.
 *
 * The first field to land here is {@link DeadlineOpts.name} — the knob name the
 * dispatched Msg tag is derived from — and it landed exactly that way: one
 * optional member, zero rewritten call sites.
 */
export type DeadlineOpts<N extends string | undefined = undefined> = {
  /**
   * The knob this deadline belongs to. Present → the dispatched Msg's tag is
   * `` `${name}_deadline` ``; absent → the tag stays the bare
   * `"deadline_exceeded"` every machine wired before this field is already
   * handling. `N` is the name as a TYPE as well as a value, so a consumer's
   * cell key and the Msg type are derived from one place and cannot drift.
   *
   * Name a deadline when a machine arms more than one family of them. The Sub
   * *id* was already scoped (`` `${name}:deadline:${key}` ``); this scopes the
   * Msg the Sub dispatches, which is what a reducer cell keys off.
   */
  readonly name?: N;
};

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
export type DeadlineExceeded<N extends string | undefined = undefined> = {
  readonly type: DeadlineMsgType<N>;
  readonly id: string;
  readonly atMs: number;
};

/**
 * The dispatched Msg's tag, derived from the deadline's optional name. A named
 * deadline speaks `` `${N}_deadline` ``; an unnamed one speaks the bare
 * `"deadline_exceeded"` literal, which is what `DeadlineExceeded` with no type
 * argument still means — so every machine wired before the name existed keeps
 * the exact type it had.
 */
export type DeadlineMsgType<N extends string | undefined> = N extends string
  ? `${N}_deadline`
  : "deadline_exceeded";

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
 * @param opts Optional additive fields folded onto the Sub literal (see
 *             {@link DeadlineOpts}). Omit it for the common case; pass it when a
 *             future field (e.g. `repeatMs`) needs to ride on the deadline. The
 *             optionality is the future-proofing seam — extending the shape
 *             never breaks an existing `deadlineSub(id, atMs)` call site.
 */
export function deadlineSub<N extends string | undefined = undefined>(
  id: string,
  atMs: number,
  opts?: DeadlineOpts<N>,
): DeadlineSub<N> {
  return { ...opts, id: subId(id), type: "deadline", atMs };
}

/**
 * The host-plugged timer backing. Given the deadline's stable `id`, its
 * absolute `atMs`, and the Msg to fire, arm the platform-appropriate timer
 * (DO alarm registry, `setTimeout`, fake timer) and return a cleanup that
 * cancels the pending fire.
 *
 * `id` is the Sub's reconcile id — a registry-backed host (the DO alarm slot)
 * keys its entry on `id` so the cleanup deletes the EXACT entry the substrate
 * reconciled. A `setTimeout`-backed host ignores `id` (the closure holds the
 * handle).
 *
 * The host computes the gap itself: `atMs - Date.now()` is the REMAINING time.
 * On a host that just rehydrated after hibernation that gap is the shrunken
 * remainder — the deadline is NOT reset to its full length. That recomputation
 * is the reason `atMs` rides on the Sub as an absolute instant rather than a
 * delay: the anchor is what every backing agrees on.
 */
export type ArmTimer<M> = (
  id: SubId,
  atMs: number,
  msg: M,
  dispatch: (msg: M) => void,
) => () => void;

/**
 * Build the `subscribe["deadline"]` cell from a host-plugged `armTimer`. This
 * module owns the Sub shape, the anchor, and the Msg; the HOST owns what backs
 * the timer. The returned handler reads `id` + `atMs` off the Sub, builds the
 * `deadlineExceeded(...)` Msg, and hands all three to `armTimer`.
 *
 * Use it when `setTimeout` is the wrong backing — most concretely a Durable
 * Object, which hibernates and must register a `do_alarm` instead:
 *
 *   subscribe: {
 *     deadline: subscribeWith((id, atMs, msg, dispatch) =>
 *       alarms.register(id, atMs, () => dispatch(msg)),
 *     ),
 *   }
 *
 * For the `setTimeout` default, use {@link subscribeDeadline} — it is exactly
 * `subscribeWith(setTimeoutArmTimer())`, so there is one deadline surface and
 * one anchor, not a second one per host.
 */
export function subscribeWith<N extends string | undefined = undefined>(
  armTimer: ArmTimer<DeadlineExceeded<N>>,
): SubscribeHandler<DeadlineSub<N>, DeadlineExceeded<N>, unknown> {
  return (sub, _ctx, dispatch) =>
    armTimer(
      sub.id,
      sub.atMs,
      deadlineExceeded(sub.id, sub.atMs, sub.name),
      dispatch,
    );
}

/**
 * The `setTimeout` timer backing — for node / browser / any host whose timer is
 * a plain `setTimeout`. Arms for the REMAINING time (`max(0, atMs - Date.now())`,
 * floored at 0 so an already-past deadline fires on the NEXT tick rather than
 * synchronously inside the reconcile pass), so a deadline re-derived after a
 * rehydrate fires at the original instant, not a fresh full window.
 *
 * Composes on `fromTimeout` rather than redrawing `setTimeout` /
 * `clearTimeout`: this package has ONE timer lifecycle, and the arm-timer seam
 * plugs into it instead of forking it. A hibernating host does NOT use this —
 * it plugs its own `armTimer` (a `do_alarm` registration) into
 * {@link subscribeWith}.
 */
export function setTimeoutArmTimer<
  N extends string | undefined = undefined,
>(): ArmTimer<DeadlineExceeded<N>> {
  return (id, atMs, msg, dispatch) => {
    // Recompute the remaining delay from the CURRENT clock so a late subscribe
    // (post-rehydrate) still targets the correct absolute moment.
    const delayMs = Math.max(0, atMs - Date.now());
    return fromTimeout<
      Sub<"deadline"> & { delayMs: number },
      DeadlineExceeded<N>
    >(() => msg)({ id, type: "deadline", delayMs }, undefined, dispatch);
  };
}

/**
 * The `subscribe["deadline"]` handler for the DEFAULT `setTimeout` backing. Arms a
 * one-shot timer for the remaining delay `max(0, atMs - Date.now())` and
 * dispatches `deadlineExceeded(...)` when it fires; returns a cleanup that
 * clears the pending timer.
 *
 * It is `subscribeWith(setTimeoutArmTimer())` — the default backing named, not
 * a separate implementation, so the host-plugged path and the default path can
 * never disagree about the anchor.
 *
 * Assign directly to a `Subscribe` handler:
 *
 *   subscribe: {
 *     deadline: subscribeDeadline,
 *   }
 *
 * Generic in the deadline's name so ONE handler serves every knob in a machine:
 * the tag it dispatches is read off the Sub's own `name`, so a machine mounting
 * a named knob beside an unnamed one wires this same cell once and each Sub
 * still dispatches its own tag.
 */
export const subscribeDeadline: <N extends string | undefined = undefined>(
  sub: DeadlineSub<N>,
  ctx: unknown,
  dispatch: (msg: DeadlineExceeded<N>) => void,
) => () => void = <N extends string | undefined>(
  sub: DeadlineSub<N>,
  ctx: unknown,
  dispatch: (msg: DeadlineExceeded<N>) => void,
) => subscribeWith<N>(setTimeoutArmTimer<N>())(sub, ctx, dispatch);

/**
 * Construct the Msg the deadline dispatches. Exported so consumers can build /
 * assert the same shape (and so the subscribe cell and tests share one
 * constructor rather than two literals that can drift).
 */
export function deadlineExceeded<N extends string | undefined = undefined>(
  id: string,
  atMs: number,
  name?: N,
): DeadlineExceeded<N> {
  return { type: deadlineMsgType(name), id, atMs };
}

/**
 * The one place the named tag is spelled. `undefined` → the bare
 * `"deadline_exceeded"` literal; a name → `` `${name}_deadline` ``. Exported so
 * a consumer keying a reducer cell off a named deadline derives the key from
 * the same function the Sub dispatches through, instead of re-spelling the
 * template and drifting.
 */
export function deadlineMsgType<N extends string | undefined>(
  name?: N,
): DeadlineMsgType<N> {
  return (
    name === undefined ? "deadline_exceeded" : `${name}_deadline`
  ) as DeadlineMsgType<N>;
}
