// ---------------------------------------------------------------------------
// Test-side assertions over `replay`. Each helper composes the replay call
// with a single `expect(...)` so consumers stop hand-rolling the 5-line
// "destructure { state, cmds } → expect.toBe / toEqual / toContainEqual"
// boilerplate at every test site.
//
// Each helper is a thin wrapper that:
//   1. Calls `replay(machine, opts)` once.
//   2. Pipes the result into a single vitest `expect(...)` matcher.
//
// All helpers return `void` — assertions throw on failure (vitest contract).
// No mutation of the machine or opts. Pure test ergonomics.
//
// Type-inference note: each helper anchors its generic parameters to the
// `machine` argument. The `expected` (and `opts.msgs`) arguments are wrapped
// in `NoInfer<...>` so they do NOT participate in inference — otherwise a
// `[]`-shaped `expected` would force `C = never` and reject a machine whose
// real Cmd union is non-empty. Anchoring inference to the machine is the
// same discipline `replay` uses (it has nothing but the machine and opts).
//
// Strengthens invariant 9 (the testing surface is named, small, and forks
// nothing of the substrate's purity guarantees).
// ---------------------------------------------------------------------------

import { expect } from "vitest";
import { type Cmd, type Machine, replay, type Sub } from "../index";

// `NoInfer<T>` is the built-in TypeScript 5.4+ intrinsic that blocks
// inference from a generic parameter at a position. We use it on `expected`
// and `opts` so inference flows purely FROM the machine — `[]`-shaped
// `expected` no longer drags `C` down to `never` and rejects the machine.

/**
 * Shared options shape for every test assertion below. Mirrors the
 * second argument of `replay(machine, opts)` — `msgs` is the sequence to
 * fold over (may be empty for init-only assertions), `ctx` is the
 * substrate-required ctx value, `loaded` is the optional pre-`init`
 * snapshot (omit / pass `null` for fresh boot).
 */
export interface ReplayOpts<S, M, Ctx> {
  readonly msgs: readonly M[];
  readonly ctx: Ctx;
  readonly loaded?: S | null;
}

/**
 * Assert the final state after replaying `opts.msgs` equals `expected`.
 * Replaces the boilerplate:
 *
 *   const { state } = replay(machine, opts);
 *   expect(state).toEqual(expected);
 *
 * Uses `toEqual` (deep structural). For type-narrowing assertions that
 * branch on `state.type` afterwards, fall back to plain `replay` —
 * `expectFinalState` is the "exact match" tool.
 */
export function expectFinalState<S, M extends { type: string }, C extends Cmd, U extends Sub, Ctx>(
  machine: Machine<S, M, C, U, Ctx>,
  opts: NoInfer<ReplayOpts<S, M, Ctx>>,
  expected: NoInfer<S>,
): void {
  const { state } = replay(machine, opts);
  expect(state).toEqual(expected);
}

/**
 * Assert that `cmd` appears at least once in the cmds array produced by
 * replaying `opts.msgs`. Uses `toContainEqual` (deep structural). Order
 * and surrounding cmds are not asserted — use `expectCmdSequence` for
 * exact ordered match.
 *
 * Replaces:
 *
 *   const { cmds } = replay(machine, opts);
 *   expect(cmds).toContainEqual(cmd);
 */
export function expectCmdEmitted<S, M extends { type: string }, C extends Cmd, U extends Sub, Ctx>(
  machine: Machine<S, M, C, U, Ctx>,
  opts: NoInfer<ReplayOpts<S, M, Ctx>>,
  cmd: NoInfer<C>,
): void {
  const { cmds } = replay(machine, opts);
  expect(cmds).toContainEqual(cmd);
}

/**
 * Assert the exact ordered sequence of cmds emitted by replaying
 * `opts.msgs`. Uses `toEqual` against the full cmds array — extra cmds
 * fail the assertion, missing cmds fail the assertion, wrong order
 * fails the assertion.
 *
 * Replaces:
 *
 *   const { cmds } = replay(machine, opts);
 *   expect(cmds).toEqual(expected);
 */
export function expectCmdSequence<S, M extends { type: string }, C extends Cmd, U extends Sub, Ctx>(
  machine: Machine<S, M, C, U, Ctx>,
  opts: NoInfer<ReplayOpts<S, M, Ctx>>,
  expected: NoInfer<readonly C[]>,
): void {
  const { cmds } = replay(machine, opts);
  expect(cmds).toEqual(expected);
}

/**
 * Assert the exact set of subs desired at the final state after
 * replaying `opts.msgs`. Uses `toEqual` against the full subs array.
 *
 * Replaces:
 *
 *   const { subs } = replay(machine, opts);
 *   expect(subs).toEqual(expected);
 */
export function expectActiveSubs<S, M extends { type: string }, C extends Cmd, U extends Sub, Ctx>(
  machine: Machine<S, M, C, U, Ctx>,
  opts: NoInfer<ReplayOpts<S, M, Ctx>>,
  expected: NoInfer<readonly U[]>,
): void {
  const { subs } = replay(machine, opts);
  expect(subs).toEqual(expected);
}

/**
 * Single-msg step helper — feeds `loaded → msg → next state + cmds emitted by
 * that msg`. Returns a readonly tuple in the shape consumers used before the
 * substrate (`[state, cmds]`), so existing tests that destructure with
 * `[next, cmds]` can swap `reduce(state, msg)` for `step(machine, state, msg,
 * ctx)` without changing the assertion code.
 *
 * Internally a `replay` call with `loaded: prevState` and a single-element
 * `msgs` array. The cmds returned are exactly the cmds emitted by THIS msg
 * (init emits no cmds when `loaded` is provided, so the slice is the entire
 * array).
 *
 * Use when consumers want to walk a machine one msg at a time and assert per
 * step. For one-shot "final state after N msgs" assertions, prefer
 * `expectFinalState`.
 */
export function step<S, M extends { type: string }, C extends Cmd, U extends Sub, Ctx>(
  machine: Machine<S, M, C, U, Ctx>,
  loaded: NoInfer<S>,
  msg: NoInfer<M>,
  ctx: NoInfer<Ctx>,
): readonly [S, readonly C[]] {
  const { state, cmds } = replay(machine, { msgs: [msg], ctx, loaded });
  return [state, cmds] as const;
}
