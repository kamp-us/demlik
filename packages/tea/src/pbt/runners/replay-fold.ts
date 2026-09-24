// ---------------------------------------------------------------------------
// `foldEvents` — pure deterministic fold over a Msg sequence.
//
// PBT needs the per-step (prev/msg/next/cmds) structure to assert
// step-shaped invariants. The substrate's `replay(machine, opts)` returns
// only final state + cumulative cmds — insufficient. We use `replay` for
// the boot step (calls `machine.init(loaded, ctx)` faithfully) then walk
// msgs ourselves through `applyCell`, the substrate's own cell dispatch.
//
// Why walk cells directly instead of looping `replay` once per msg with
// `loaded: prevState`? Because `init(loaded)` runs every call, and on
// machines with non-trivial init transforms (e.g. the audit machine's
// `auditing → attach_debugger` resume cell) that would either (a) re-fire
// the transform on every step, or (b) require fragile cmd-subtraction to
// isolate this step's cmds. Calling the cells directly keeps the fold pure
// and the cmds per-step exactly.
//
// Dispatches through `applyCell` — the single primitive `run`/`replay` use —
// so form classification agrees with production by construction (#275).
//
// `foldEvents` does NOT call `interpret`, does NOT touch a Store, does NOT
// start Subs. The reducer surface is the contract.
// ---------------------------------------------------------------------------

import {
  applyCell,
  type Cmd,
  type Machine,
  replay,
  type Sub,
} from "../../index";

/**
 * One unit in a fold trace — the four pieces of data a property
 * invariant typically asserts on. `prev` is the state before the msg
 * applied; `next` is the state after; `cmds` is the cmds emitted by this
 * single step (NOT the running total).
 */
export interface Step<S, M, C> {
  readonly prev: S;
  readonly msg: M;
  readonly next: S;
  readonly cmds: readonly C[];
}

/**
 * Fold a Msg sequence through a machine's pure reducer, returning the
 * per-step trace, every state in order, and the final state. Initial
 * state comes from `replay(machine, { msgs: [], ctx, loaded })` — i.e.
 * `machine.init(loaded ?? null, ctx)` faithfully. Init's emitted cmds
 * are NOT included in any `Step` (they're the boot moment, not a Msg).
 *
 * @param machine  The machine under test.
 * @param ctx      The Ctx — typically `stubCtxThrowingProxy<Ctx>()` when
 *                 init is pure. Pass a real ctx if init reads from it.
 * @param loaded   Optional pre-init snapshot (the `loaded` arg to
 *                 `machine.init`). Defaults to `null` (fresh boot).
 * @param msgs     The Msg sequence to fold.
 *
 * @example
 *   const { states, steps, finalState } = foldEvents(machine, ctx, null, [
 *     { type: "start" }, { type: "tick" }, { type: "stop" },
 *   ]);
 *   // steps[1] = { prev: { type: "counting", n: 0 }, msg: { type: "tick" }, ... }
 */
export function foldEvents<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  ctx: NoInfer<Ctx>,
  loaded: NoInfer<S> | null,
  msgs: readonly NoInfer<M>[],
): {
  readonly states: readonly S[];
  readonly steps: readonly Step<S, M, C>[];
  readonly finalState: S;
} {
  // Boot through `replay` so `init` runs faithfully and we honor the
  // substrate's loaded-snapshot contract (init may transform the loaded
  // value before the first Msg lands — e.g. the audit machine flips
  // `debuggerAttached: false` on resume).
  const { state: initialState } = replay(machine, {
    msgs: [],
    ctx,
    loaded: loaded ?? null,
  });

  // Per-msg dispatch goes through `applyCell` — the same primitive `run` and
  // `replay` use — so this runner classifies the update form identically to
  // production (`formOf` honors the `__form` tag; #275).
  const states: S[] = [initialState];
  const steps: Step<S, M, C>[] = [];
  let current = initialState;

  for (const msg of msgs) {
    const [next, emitted] = applyCell<S, M, C>(machine, current, msg);
    steps.push({ prev: current, msg, next, cmds: [...emitted] });
    states.push(next);
    current = next;
  }

  return { states, steps, finalState: current };
}
