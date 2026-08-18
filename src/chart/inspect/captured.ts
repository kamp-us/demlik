// ═══════════════════════════════════════════════════════════════════════════
// THE CAPTURED CMDS — what actually fired, not what would.
//
// `describeChart` reads the cmds an edge DECLARES, and `previewEvent` reports
// them as the effects a dispatch would cause. That is a BEFORE question, and it
// has two blind spots by construction:
//
//   1. a `{ to, cell }` edge declares no cmds at all — the cell builds them in
//      its body, so the chart has nothing to show for exactly the edges that do
//      the most interesting work; and
//   2. a guarded edge declares both arms, and only one of them ever fired.
//
// This module answers the AFTER question, and it does it without a new observer
// seam: `replay` already returns the cmds a fold emitted, and the scrubber
// already re-folds a prefix of the recorded msgs through it. So "what fired at
// step n" is the difference between two prefixes that are already being
// computed — read off the machine's own output, by the same pure fold, with
// nothing subscribed and nothing intercepted.
//
// PURE. `replay` runs `init` + `update` only — never `interpret`, never a Store,
// never a subscription — so capturing a cmd list cannot re-perform the effect it
// is reporting. That is the same guarantee the scrubber rests on.
//
// COST. One `replay` per step, so the walk is quadratic in the trace length.
// That is deliberate: the alternative is a second fold implementation inside
// this module, and a second fold is a second answer — the thing the whole
// inspector exists to avoid. Traces are inspector-sized (tens to hundreds of
// msgs), and the fold is pure arithmetic over plain data.
// ═══════════════════════════════════════════════════════════════════════════

import { type Cmd, type Machine, replay, type Sub } from "../../index";

/**
 * The cmds ONE step emitted, tagged with the msg that caused them.
 *
 * `step` is `0` for `init` and `n` for the nth recorded msg, which is the same
 * index the scrubber's cursor uses — so a UI showing step `n` asks for
 * `capture.steps[n]` and gets the effects of the transition it is displaying.
 */
export interface CapturedStep<M extends { type: string }, K extends Cmd> {
  /** `0` = `init`; `1..n` = the nth recorded msg. */
  readonly step: number;
  /**
   * The msg that caused these cmds. `null` at step `0` — `init` has no cause,
   * and pinning its cmds on the first msg would be a lie about who fired them.
   */
  readonly by: M | null;
  /** What ACTUALLY fired, in emission order. Cell-built cmds included. */
  readonly cmds: readonly K[];
}

/**
 * Every step of a recorded run, with the cmds each one actually emitted.
 *
 * `stoppedAt` is the honest degradation: a fold that throws (a chart compiled
 * against parts that are not there, a cell that blew up on a state the current
 * code no longer produces) truncates the capture at that step and says so,
 * rather than reporting a short list as if it were complete.
 */
export interface CmdCapture<M extends { type: string }, K extends Cmd> {
  readonly steps: readonly CapturedStep<M, K>[];
  /** Every captured cmd, flattened in fire order. */
  readonly cmds: readonly K[];
  /** Present iff the fold threw before the trace ran out. */
  readonly stoppedAt?: { readonly step: number; readonly error: string };
}

/** The recorded input a capture folds — `Trace`'s two input halves. */
export interface CaptureInput<S, M extends { type: string }, Ctx> {
  readonly msgs: readonly M[];
  readonly ctx: Ctx;
  /** The rehydrated state the run booted from, when it booted from one. */
  readonly loaded?: S | null;
}

/**
 * Fold `input` through `machine` and report the cmds EVERY step emitted.
 *
 * This is the after-the-fact counterpart to the declarative preview: where
 * `EventPreview.cmds` says *what would fire if this event were dispatched now*,
 * this says *what did fire, in order, and which msg caused it*. Both are useful
 * and they are not the same question — a cell edge declares no cmds and emits
 * plenty, and a guarded edge declares two arms and takes one.
 */
export function captureCmds<
  S,
  M extends { type: string },
  K extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, K, U, Ctx>,
  input: CaptureInput<S, M, Ctx>,
): CmdCapture<M, K> {
  const steps: CapturedStep<M, K>[] = [];
  const cmds: K[] = [];
  let seen = 0;

  for (let n = 0; n <= input.msgs.length; n++) {
    let sofar: readonly K[];
    try {
      // `replay`'s cmds are CUMULATIVE over the prefix, in fold order, so the
      // ones this step added are exactly the tail past the previous prefix.
      sofar = replay(machine, {
        msgs: input.msgs.slice(0, n),
        ctx: input.ctx,
        loaded: input.loaded ?? null,
      }).cmds;
    } catch (e) {
      return {
        steps,
        cmds,
        stoppedAt: {
          step: n,
          error: e instanceof Error ? e.message : String(e),
        },
      };
    }
    const fired = sofar.slice(seen);
    seen = sofar.length;
    cmds.push(...fired);
    steps.push({
      step: n,
      by: n === 0 ? null : (input.msgs[n - 1] ?? null),
      cmds: fired,
    });
  }

  return { steps, cmds };
}

/**
 * The step at cursor `n`, or `undefined` when the capture does not reach it
 * (an out-of-range cursor, or a fold that stopped early).
 */
export function firedAt<M extends { type: string }, K extends Cmd>(
  capture: CmdCapture<M, K>,
  step: number,
): CapturedStep<M, K> | undefined {
  return capture.steps.find((s) => s.step === step);
}

/**
 * The captured cmds grouped by cmd NAME, in first-fire order — the roll-up a
 * "which effects did this run actually perform" panel wants.
 */
export function firedCounts<M extends { type: string }, K extends Cmd>(
  capture: CmdCapture<M, K>,
): readonly { readonly type: string; readonly count: number }[] {
  const counts = new Map<string, number>();
  for (const c of capture.cmds) {
    counts.set(c.type, (counts.get(c.type) ?? 0) + 1);
  }
  return [...counts].map(([type, count]) => ({ type, count }));
}
