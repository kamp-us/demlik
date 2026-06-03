// ---------------------------------------------------------------------------
// Property runners — three thin wrappers over `fc.assert(fc.property(...))`
// that fold a generated Msg sequence through the machine via `foldEvents`
// and pipe the result into a TEA-shaped predicate.
//
//   - `propertyTerminates` — every sequence ends in a terminal state.
//   - `propertyInvariant`  — predicate holds on every (prev, msg, next, cmds) step.
//   - `propertyTrace`      — predicate holds on the full (trace, final) shape.
//
// Each runner accepts `numRuns` (passed through to fast-check), an optional
// `loaded` snapshot (forwarded to `foldEvents`), and the Msg-sequence
// arbitrary. They return `void`; failures throw via fast-check's standard
// shrinking output.
//
// Default shrinker is fast-check's built-in (open question 4): drop-msg /
// prefix shrinkers can be layered later but are opt-in, not default. The
// built-in shrinker handles array-shape shrinking + per-element variant
// shrinking automatically.
// ---------------------------------------------------------------------------

import type { Cmd, Machine, Sub } from "../../index";
import * as fc from "fast-check";
import { foldEvents, type Step } from "./replay-fold";

/** Common options shared by every property runner. */
interface PropertyOpts<S> {
  /** Pre-init snapshot — passed to `machine.init(loaded, ctx)`. Default `null`. */
  readonly loaded?: S | null;
  /** Number of generated sequences to test. Forwarded to `fc.assert`. */
  readonly numRuns?: number;
  /** Optional fast-check seed for reproducibility. */
  readonly seed?: number;
}

/**
 * Assert every generated Msg sequence ends in a terminal state. `terminal`
 * is the predicate that names the acceptable final states (often
 * `(s) => s.type === "done" || s.type === "idle"`).
 *
 * The "every sequence" property catches stuck states (machine gets to a
 * non-terminal state and no further msg can escape) AND silent loops
 * (every msg variant is a noop from a given state).
 *
 * @example
 *   propertyTerminates(
 *     auditBackgroundMachine,
 *     stubCtxThrowingProxy<BackgroundCtx>(),
 *     arbMsgSequence(msgArb, { minLength: 1, maxLength: 30 }),
 *     (s) => s.type === "done" || s.type === "idle",
 *     { loaded: auditingState, numRuns: 500 },
 *   );
 */
export function propertyTerminates<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  ctx: NoInfer<Ctx>,
  seqArb: fc.Arbitrary<readonly NoInfer<M>[]>,
  terminal: (state: NoInfer<S>) => boolean,
  opts?: NoInfer<PropertyOpts<S>>,
): void {
  const fcParams: fc.Parameters<[readonly M[]]> = {
    numRuns: opts?.numRuns ?? 200,
    ...(opts?.seed !== undefined ? { seed: opts.seed } : {}),
  };
  fc.assert(
    fc.property(seqArb, (msgs) => {
      const { finalState } = foldEvents(machine, ctx, opts?.loaded ?? null, msgs);
      if (!terminal(finalState)) {
        // Throwing here (vs returning false) lets the error message carry
        // the offending final state — fast-check pretty-prints it inside
        // the shrunk counter-example.
        throw new Error(
          `propertyTerminates: final state did not match terminal predicate. ` +
            `Final: ${JSON.stringify(finalState)}`,
        );
      }
    }),
    fcParams,
  );
}

/**
 * Assert a predicate holds on EVERY transition step in a generated
 * sequence. The predicate sees `{ prev, msg, next, cmds }` per step;
 * return true to accept, false (or throw) to fail.
 *
 * Use to pin a "when X happens in state Y, cmd Z must be emitted" rule.
 * The shrinker minimizes the offending sequence to the smallest Msg list
 * that still violates the predicate.
 *
 * @example
 *   // Pin the resume-handshake fix: `ws:client:hello` in auditing must
 *   // emit `send_ws { client:ready }`.
 *   propertyInvariant(
 *     auditBackgroundMachine, ctx,
 *     arbMsgSequence(msgArb, { prefix: [{ type: "ws:client:hello" }] }),
 *     ({ prev, msg, cmds }) =>
 *       !(prev.type === "auditing" && msg.type === "ws:client:hello") ||
 *       cmds.some((c) => c.type === "send_ws" && c.msg.type === "client:ready"),
 *     { loaded: auditingState, numRuns: 200 },
 *   );
 */
export function propertyInvariant<S, M extends { type: string }, C extends Cmd, U extends Sub, Ctx>(
  machine: Machine<S, M, C, U, Ctx>,
  ctx: NoInfer<Ctx>,
  seqArb: fc.Arbitrary<readonly NoInfer<M>[]>,
  invariant: (step: Step<NoInfer<S>, NoInfer<M>, NoInfer<C>>) => boolean,
  opts?: NoInfer<PropertyOpts<S>>,
): void {
  const fcParams: fc.Parameters<[readonly M[]]> = {
    numRuns: opts?.numRuns ?? 200,
    ...(opts?.seed !== undefined ? { seed: opts.seed } : {}),
  };
  fc.assert(
    fc.property(seqArb, (msgs) => {
      const { steps } = foldEvents(machine, ctx, opts?.loaded ?? null, msgs);
      for (const step of steps) {
        if (!invariant(step)) {
          throw new Error(
            `propertyInvariant: failed at step msg=${JSON.stringify(step.msg)} ` +
              `prev=${JSON.stringify(step.prev)} next=${JSON.stringify(step.next)} ` +
              `cmds=${JSON.stringify(step.cmds)}`,
          );
        }
      }
    }),
    fcParams,
  );
}

/**
 * Assert a predicate over the full trace plus the final state. Use when
 * the property is "some Msg appeared in the trace before reaching the
 * final state" or "no two consecutive steps had the same state.type" —
 * predicates that need the full sequence, not a single step.
 *
 * @example
 *   propertyTrace(
 *     machine, ctx, seqArb,
 *     (steps, final) =>
 *       final.type !== "done" ||
 *       steps.some((step) => step.msg.type === "ws:audit:done"),
 *     { loaded: auditingState, numRuns: 500 },
 *   );
 */
export function propertyTrace<S, M extends { type: string }, C extends Cmd, U extends Sub, Ctx>(
  machine: Machine<S, M, C, U, Ctx>,
  ctx: NoInfer<Ctx>,
  seqArb: fc.Arbitrary<readonly NoInfer<M>[]>,
  predicate: (
    steps: readonly Step<NoInfer<S>, NoInfer<M>, NoInfer<C>>[],
    finalState: NoInfer<S>,
  ) => boolean,
  opts?: NoInfer<PropertyOpts<S>>,
): void {
  const fcParams: fc.Parameters<[readonly M[]]> = {
    numRuns: opts?.numRuns ?? 200,
    ...(opts?.seed !== undefined ? { seed: opts.seed } : {}),
  };
  fc.assert(
    fc.property(seqArb, (msgs) => {
      const { steps, finalState } = foldEvents(machine, ctx, opts?.loaded ?? null, msgs);
      if (!predicate(steps, finalState)) {
        throw new Error(
          `propertyTrace: predicate failed on trace length=${steps.length}, ` +
            `final=${JSON.stringify(finalState)}`,
        );
      }
    }),
    fcParams,
  );
}
