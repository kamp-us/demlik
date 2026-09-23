/**
 * internal/resilience/deadline — a one-shot Sub that fires when an ABSOLUTE wall-clock
 * deadline is reached.
 *
 * Generalizes the recurring "auto-fail a machine at T+N" / "15-minute stale
 * guard" pattern: a deadline a battery lists only while it should be armed,
 * which dispatches a single `DeadlineExceeded` Msg when the wall clock crosses
 * `atMs`.
 *
 * A battery's `subs(slice)` returns its deadlines as a LIST (`DeadlineSub[]`,
 * one per retry timer, say). A machine declares that list as ONE Sub of type
 * `"deadline"` whose `deps` is the list (`deadlinesSub(select)`), and the
 * `deadline` runner arms every deadline in it. A change to the list restarts
 * the runner, which re-arms each deadline for its REMAINING time — `atMs` is
 * absolute, so a restart never moves a deadline.
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
 * `deadlineSub` produces one deadline literal carrying `atMs`; the runner
 * (`subscribeDeadline`) translates each `atMs` → a relative delay and arms a
 * `setTimeout` / `clearTimeout` pair per deadline. The clock
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

import type { DepKeyedSub, Dispose, Sub, SubId } from "../../../index";
import { subId } from "../../../index";

/**
 * One deadline, as a battery lists it. `atMs` is the absolute target — epoch
 * milliseconds (the `Date.now()` / `Date.parse(...)` scale), NOT a relative
 * delay. `id` names the deadline inside its list: it rides on the dispatched
 * Msg so a reducer can tell WHICH deadline fired, and a registry-backed timer
 * (a DO alarm slot) keys its entry on it.
 *
 * It is plain data — it becomes part of the `deadline` Sub's `deps`, which the
 * engine hashes — and is not itself a running Sub.
 */
export type DeadlineSub<N extends string | undefined = undefined> = {
  readonly id: SubId;
  readonly type: "deadline";
  readonly atMs: number;
} & DeadlineOpts<N>;

/**
 * The running `"deadline"` Sub: its `deps` is the non-empty list of deadlines
 * to arm. Name it in `types.sub` for a machine that arms deadlines.
 */
export type DeadlinesSub<N extends string | undefined = undefined> = Sub<
  "deadline",
  readonly DeadlineSub<N>[]
>;

/**
 * The `deps` of a `deadline` Sub: the list, or `null` when it is empty — an
 * empty list is a Sub with nothing to arm, and an off Sub is not a live one
 * (`driveToDone` reads live Subs to tell a waiting machine from a stalled one).
 */
export function deadlines<N extends string | undefined = undefined>(
  list: readonly DeadlineSub<N>[],
): readonly DeadlineSub<N>[] | null {
  return list.length === 0 ? null : list;
}

/**
 * The `subs` entry that arms whatever deadlines `select` lists at a state:
 *
 *   subs: [deadlinesSub((s: State) => rc.subs(s.resilience))],
 *   // run(machine, { subscribe: { deadline: subscribeDeadline } })
 */
export function deadlinesSub<S, N extends string | undefined = undefined>(
  select: (state: S) => readonly DeadlineSub<N>[],
): DepKeyedSub<S, DeadlinesSub<N>> {
  return { type: "deadline", deps: (state) => deadlines(select(state)) };
}

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
 * Build a deadline literal. Pure data — no clock read, no timer; the timer
 * is armed later by the `deadline` runner. `id` is branded via `subId(...)` so
 * accidental raw-string drift fails at the type level (invariant 7).
 *
 * List it from a battery's `subs(slice)` while the deadline should be armed;
 * drop it to disarm — the engine restarts the `deadline` Sub, whose cleanup
 * clears the pending timer before it fires. That is the "cancel on state exit"
 * lifecycle.
 *
 * @param id   Identity for this deadline, echoed on the Msg it fires. Use
 *             distinct ids for distinct deadlines on the same machine.
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
 * `id` is the deadline's own id — a registry-backed host (the DO alarm slot)
 * keys its entry on `id` so the cleanup deletes the EXACT entry it armed. A
 * `setTimeout`-backed host ignores `id` (the closure holds the handle).
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
 * Build the `deadline` runner from a host-plugged `armTimer`. This module owns
 * the deadline shape, the anchor, and the Msg; the HOST owns what backs the
 * timer. The runner arms every deadline in the Sub's `deps` list — reading
 * `id` + `atMs`, building the `deadlineExceeded(...)` Msg and handing all three
 * to `armTimer` — and its cleanup cancels them all.
 *
 * Use it when `setTimeout` is the wrong backing — most concretely a Durable
 * Object, which hibernates and must register a `do_alarm` instead:
 *
 *   run(machine, {
 *     subscribe: {
 *       deadline: subscribeWith((id, atMs, msg, dispatch) =>
 *         alarms.register(id, atMs, () => dispatch(msg)),
 *       ),
 *     },
 *   })
 *
 * For the `setTimeout` default, use {@link subscribeDeadline} — it is exactly
 * `subscribeWith(setTimeoutArmTimer())`, so there is one deadline surface and
 * one anchor, not a second one per host.
 */
export function subscribeWith<N extends string | undefined = undefined>(
  armTimer: ArmTimer<DeadlineExceeded<N>>,
): (
  sub: DeadlinesSub<N>,
  ctx: unknown,
  dispatch: (msg: DeadlineExceeded<N>) => void,
) => Dispose {
  return (sub, _ctx, dispatch) => {
    const cancels = sub.deps.map((deadline) =>
      armTimer(
        deadline.id,
        deadline.atMs,
        deadlineExceeded(deadline.id, deadline.atMs, deadline.name),
        dispatch,
      ),
    );
    return () => {
      for (const cancel of cancels) cancel();
    };
  };
}

/**
 * The `setTimeout` timer backing — for node / browser / any host whose timer is
 * a plain `setTimeout`. Arms for the REMAINING time (`max(0, atMs - Date.now())`,
 * floored at 0 so an already-past deadline fires on the NEXT tick rather than
 * synchronously inside the reconcile pass), so a deadline re-derived after a
 * rehydrate — or re-armed by a restart — fires at the original instant, not a
 * fresh full window. A hibernating host does NOT use this — it plugs its own
 * `armTimer` (a `do_alarm` registration) into {@link subscribeWith}.
 */
export function setTimeoutArmTimer<
  N extends string | undefined = undefined,
>(): ArmTimer<DeadlineExceeded<N>> {
  return (_id, atMs, msg, dispatch) => {
    // Recompute the remaining delay from the CURRENT clock so a late start
    // (post-rehydrate, or a restart) still targets the same absolute moment.
    const handle = setTimeout(
      () => dispatch(msg),
      Math.max(0, atMs - Date.now()),
    );
    return () => clearTimeout(handle);
  };
}

/**
 * The `deadline` runner for the DEFAULT `setTimeout` backing. Arms a one-shot
 * timer per listed deadline for its remaining delay `max(0, atMs - Date.now())`
 * and dispatches `deadlineExceeded(...)` when each fires; the cleanup clears
 * every pending timer.
 *
 * It is `subscribeWith(setTimeoutArmTimer())` — the default backing named, not
 * a separate implementation, so the host-plugged path and the default path can
 * never disagree about the anchor.
 *
 *   run(machine, { subscribe: { deadline: subscribeDeadline } })
 *
 * Generic in the deadline's name so ONE runner serves every knob in a machine:
 * the tag it dispatches is read off each deadline's own `name`, so a machine
 * listing a named knob's deadlines beside an unnamed one's wires this once.
 */
export const subscribeDeadline: <N extends string | undefined = undefined>(
  sub: DeadlinesSub<N>,
  ctx: unknown,
  dispatch: (msg: DeadlineExceeded<N>) => void,
) => Dispose = <N extends string | undefined>(
  sub: DeadlinesSub<N>,
  ctx: unknown,
  dispatch: (msg: DeadlineExceeded<N>) => void,
) => subscribeWith<N>(setTimeoutArmTimer<N>())(sub, ctx, dispatch);

/**
 * Construct the Msg the deadline dispatches. Exported so consumers can build /
 * assert the same shape (and so the runner and tests share one
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
