// ---------------------------------------------------------------------------
// defineListener — listener-as-resource. The kernel primitive that turns an
// imperative `add`/`remove` listener pair into a substrate-owned Sub whose
// cleanup is MANDATORY and DERIVED — a forgotten or no-op disposer is
// unrepresentable.
//
// The leak it kills: every author who wires a raw listener hand-rolls the SAME
// skeleton —
//
//   return (sub, _ctx, dispatch) => {
//     const listener = (e) => { const m = msgFn(e, sub); if (m !== null) dispatch(m); };
//     target.addListener(listener);
//     return () => target.removeListener(listener);   // ← author-driven
//   };
//
// — and each re-write can SILENTLY LEAK two ways the type system never sees:
//
//   1. The disposer is a no-op (`return () => {}`) — the listener stays armed
//      forever. Nothing forces the returned cleanup to undo the add.
//   2. The disposer calls `remove` with a DIFFERENT function than `add`
//      received (a fresh closure, a re-bound `this`) — the original listener
//      is never removed; it leaks while a phantom remove succeeds silently.
//
// `fromBroadcastChannel`, `fromEventTarget`, and every host-side bridge
// hand-roll this skeleton today. They happen to be correct — but the
// correctness is convention (rung 5), not structure. `defineListener` moves it
// to rung 1: the listener the substrate builds is the SAME reference handed to
// both `add` and `remove`, and the cleanup IS `() => remove(thatListener, ...)`.
// You cannot write a no-op disposer because you do not write the disposer at
// all.
//
// Shape:
//
//   // Args is the tuple chrome invokes the listener with — here a single
//   // [Alarm]. The substrate builds ONE listener of this exact native shape.
//   const fromChromeAlarm = defineListener<[chrome.alarms.Alarm], S>({
//     add:    (l) => chrome.alarms.onAlarm.addListener(l),
//     remove: (l) => chrome.alarms.onAlarm.removeListener(l),
//   });
//
//   // ...then at the subscribe cell, supply the Msg projection:
//   subscribe: { tick: fromChromeAlarm<M>((sub, alarm) => ({ type: "tick", ... })) }
//
//   - `add`/`remove` receive `(listener, sub, ctx)`. The `listener` is the
//     EXACT function the substrate built; pass it straight to the platform's
//     addListener/removeListener — NO wrapper. A wrapper inside `add` would
//     break reference identity (the platform stores the wrapper, but the
//     substrate hands `remove` the unwrapped listener → silent leak). Carrying
//     the platform's native `Args` tuple on the listener is what lets it be
//     registered directly. `sub`/`ctx` let the target be pulled from `ctx` or
//     keyed on the `sub` (the `getTarget()`-from-ctx shape fromPort needs).
//
//   - `msgFn(sub, ...args) => M | null` — the universal drop-on-null filter
//     every factory in this subpath carries. `null` drops the dispatch; the
//     listener stays armed. `sub` is first (always present); the platform args
//     follow in their native order.
//
// Generalizes the `from*` pattern: a closure-owned disposer makes a forgotten
// cleanup a syntax error, and this brings it to every host/satellite.
//
// Strengthens invariant 4 (external events enter as Subs; the lifecycle —
// add on subscribe, remove on cleanup — is owned by the substrate, never the
// author) and invariant 6 (no silent looseness: a leaked listener is a silent
// failure, and this primitive removes the way to write one).
// ---------------------------------------------------------------------------

import type { Sub } from "../index";
import { dispatchIfPresent, type SubscribeHandler } from "./types";

/**
 * The imperative listener target, expressed as the `add`/`remove` pair the
 * substrate pairs into a reconciled resource. Both halves receive the SAME
 * `listener` reference — the substrate builds it once — so `remove` can never
 * be handed a different function than `add` saw.
 *
 * `add`/`remove` also receive `(sub, ctx)` so the target may be resolved from
 * `ctx` (a runtime, a port, a DOM node looked up lazily) or keyed on the Sub
 * (an alarm name, a channel name). Resolving the target inside `add` and
 * closing over nothing but the listener keeps a target swap from leaking the
 * old target's listener — same rationale as `fromEventTarget`'s captured
 * target.
 *
 * `Args` is the tuple the platform invokes the listener with — `[Alarm]` for
 * `chrome.alarms.onAlarm`, `[message, sender, sendResponse]` for
 * `chrome.runtime.onMessage`, `[changes, areaName]` for
 * `chrome.storage.onChanged`. The substrate builds ONE function of this exact
 * shape and threads the IDENTICAL reference to both `add` and `remove` — so a
 * platform that matches `removeListener` by reference (every chrome surface)
 * removes exactly what it added. A consumer that wrapped the listener inside
 * `add` would break reference identity (leak #2 above); carrying the native
 * `Args` on the listener itself removes the need for any wrapper.
 */
export interface ListenerTarget<
  Args extends readonly unknown[],
  S extends Sub,
  Ctx,
> {
  add: (listener: (...args: Args) => void, sub: S, ctx: Ctx) => void;
  remove: (listener: (...args: Args) => void, sub: S, ctx: Ctx) => void;
}

/**
 * Build a listener-backed Sub factory whose cleanup is mandatory and derived.
 *
 * `Args`, `S`, `Ctx` are fixed when the target is defined — they describe the
 * one listener topology this factory owns (the platform arg tuple, which Sub
 * shape it filters on, what context resolves it). `M` is supplied at the
 * subscribe cell because the same listener feeds different Msgs in different
 * machines. Pinning `S` here (rather than at the `msgFn` step) lets
 * `add`/`remove` read the concrete Sub's fields — `sub.alarmName`,
 * `sub.channel` — with NO cast at the substrate edge: the narrowing happens in
 * author-land where the Sub shape is in scope.
 *
 * The returned function is a `SubscribeHandler` factory in the exact shape of
 * every other `@demlik/tea/subs` battery: supply the `msgFn` projection, get a
 * `(sub, ctx, dispatch) => cleanup` handler assignable to `machine.subscribe`.
 * The cleanup the author NEVER writes is `() => remove(listener, sub, ctx)`,
 * with `listener` the identical reference passed to `add`.
 */
export function defineListener<
  Args extends readonly unknown[],
  S extends Sub = Sub,
  Ctx = unknown,
>(
  target: ListenerTarget<Args, S, Ctx>,
): <M>(
  msgFn: (sub: S, ...args: Args) => M | null,
) => SubscribeHandler<S, M, Ctx> {
  return <M>(
    msgFn: (sub: S, ...args: Args) => M | null,
  ): SubscribeHandler<S, M, Ctx> => {
    return (sub, ctx, dispatch) => {
      const listener = (...args: Args): void => {
        dispatchIfPresent(dispatch, msgFn(sub, ...args));
      };
      // ONE listener, identical reference to both halves — chrome's
      // removeListener matches by reference, so this removes exactly what
      // add registered. No wrapper, no WeakMap, no reference drift.
      target.add(listener, sub, ctx);
      return () => {
        target.remove(listener, sub, ctx);
      };
    };
  };
}
