// ---------------------------------------------------------------------------
// Msg-sequence arbitraries.
//
// `arbMsgSequence(msgArb, opts)` produces `fc.Arbitrary<readonly M[]>` —
// fast-check's default-shrinker handles the array; the per-element shrinker
// inside `msgArb` shrinks each variant. Optional `prefix` is prepended
// verbatim (used by Test A: "the bug-triggering Msg leads the sequence").
//
// `arbGuidedSequence` is the state-aware sequence builder. In v1 it throws
// — Phase 6 of the design doc lands the `fc.commands`-backed implementation.
// The export exists today so the surface is forward-compatible: consumers
// that need state-aware generation get a useful error pointing at the
// design doc instead of "is not a function."
// ---------------------------------------------------------------------------

import * as fc from "fast-check";
import type { Cmd, Machine, Sub } from "../../index";

/**
 * Build an arbitrary of Msg sequences over a per-Msg arbitrary. Optionally
 * bounded in length and / or prefixed with a fixed sequence.
 *
 * - `minLength` (default 0) and `maxLength` (default 30) bound the random
 *   array length. `prefix` is prepended AFTER the random tail is built; the
 *   final length is `prefix.length + tail.length`.
 * - `prefix` is the load-bearing escape hatch for "the first msg is the
 *   one that exercises the cell I care about" (e.g. Test A's
 *   `[{ type: "ws:client:hello" }]` prefix to land in the
 *   `auditing.ws:client:hello` cell on the first transition).
 *
 * @example
 *   arbMsgSequence(msgArb, { minLength: 1, maxLength: 30 });
 *   arbMsgSequence(msgArb, { prefix: [{ type: "ws:client:hello" }], maxLength: 20 });
 */
export function arbMsgSequence<M extends { type: string }>(
  msgArb: fc.Arbitrary<M>,
  opts?: {
    readonly minLength?: number;
    readonly maxLength?: number;
    readonly prefix?: readonly NoInfer<M>[];
  },
): fc.Arbitrary<readonly M[]> {
  const minLength = opts?.minLength ?? 0;
  const maxLength = opts?.maxLength ?? 30;
  const prefix = opts?.prefix ?? [];
  const tail = fc.array(msgArb, { minLength, maxLength });
  if (prefix.length === 0) return tail;
  return tail.map((arr) => [...prefix, ...arr]);
}

/**
 * State-aware Msg sequence arbitrary — generates only msgs whose
 * precondition holds in the current state. Backed by `fc.commands`
 * internally. Planned for a later phase.
 *
 * **NOT IMPLEMENTED IN v1.** The export exists today so the surface is
 * forward-compatible; this ships in a later phase alongside
 * shrinkers. Calling it throws.
 */
export function arbGuidedSequence<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  _machine: Machine<S, M, C, U, Ctx>,
  _ctx: Ctx,
  _cells: {
    [K in M["type"]]?: (
      state: S,
    ) => fc.Arbitrary<Extract<M, { type: K }>> | null;
  },
  _opts?: { maxLength?: number },
): fc.Arbitrary<readonly M[]> {
  throw new Error(
    "@demlik/tea/pbt: arbGuidedSequence is not implemented in v1. " +
      "Use arbMsgSequence with " +
      "an unguided arbMsg table for now; states that don't accept a given " +
      "msg should noop in the reducer (mapped-type discipline).",
  );
}
