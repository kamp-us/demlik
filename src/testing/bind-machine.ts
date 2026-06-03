// ---------------------------------------------------------------------------
// `bindMachine(machine, ctx)` — bound test harness over the free-function
// assertions in `./assertions.ts`. Closes over the `machine` and `ctx` once
// so per-test callsites stop repeating both at every invocation.
//
// Why this exists: every consumer test file ends up hand-rolling a local
// two-arg `step(state, msg)` wrapper around `step(machine, state, msg, ctx)`,
// and the four `expect*` assertions repeat `machine` + `ctx` at every
// callsite. The bound form pulls both into one place and gives every
// per-test call its tightest possible shape (2-arg max).
//
// `bindMachine` is built ON TOP of the free helpers — it does not replace
// them. Both forms coexist; pick the one that fits the call site:
//
//   - Free form  → one-off call inside a helper that isn't bound to one
//                  machine (e.g. cross-machine integration test).
//   - Bound form → a `describe` block runs many assertions against one
//                  machine + ctx. The bound form is the common case.
//
// Strengthens invariant 9 (the testing surface is named, small, and forks
// nothing of the substrate's purity guarantees).
// ---------------------------------------------------------------------------

import { expect } from "vitest";
import { type Cmd, type Machine, replay, type Sub } from "../index";

/**
 * Replay options shape used by every bound method. `ctx` is captured by
 * `bindMachine`; the per-call opts only need `msgs` and an optional
 * `loaded` snapshot. (Compare `ReplayOpts` in `./assertions.ts`, which
 * still takes `ctx` because the free helpers cannot capture it.)
 */
interface BoundOpts<S, M> {
  readonly msgs: readonly M[];
  readonly loaded?: S | null;
}

/**
 * The bound testing surface. Every method is 2-arg max — `ctx` and
 * `machine` are captured by `bindMachine`.
 *
 * `NoInfer<...>` on `expected` / `cmd` arguments mirrors the discipline
 * the free helpers use (see `./assertions.ts`): inference flows purely
 * FROM the machine, so a `[]`-shaped expected does not drag `C` down to
 * `never` and reject the machine.
 */
export interface BoundMachine<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  // biome-ignore lint/correctness/noUnusedVariables: Ctx is a phantom-style
  // parameter — present on the interface for consumers that want to spell
  // `BoundMachine<S, M, C, U, Ctx>` explicitly, mirroring `Machine`.
  Ctx,
> {
  /**
   * Single-msg step — feeds `loaded → msg → [next state, cmds emitted by
   * that msg]`. Mirrors the free `step(machine, loaded, msg, ctx)`.
   */
  step(loaded: S, msg: M): readonly [S, readonly C[]];
  /**
   * Assert the final state after replaying `opts.msgs` deep-equals
   * `expected`. Mirrors the free `expectFinalState(machine, opts, expected)`.
   */
  expectFinalState(opts: BoundOpts<S, M>, expected: NoInfer<S>): void;
  /**
   * Assert `cmd` appears at least once in the emitted cmd list. Order is
   * not asserted. Mirrors the free `expectCmdEmitted(machine, opts, cmd)`.
   */
  expectCmdEmitted(opts: BoundOpts<S, M>, cmd: NoInfer<C>): void;
  /**
   * Assert the exact ordered sequence of cmds emitted by replaying
   * `opts.msgs`. Mirrors the free `expectCmdSequence(machine, opts, expected)`.
   */
  expectCmdSequence(opts: BoundOpts<S, M>, expected: readonly NoInfer<C>[]): void;
  /**
   * Assert the exact set of subs desired at the final state. Mirrors the
   * free `expectActiveSubs(machine, opts, expected)`.
   */
  expectActiveSubs(opts: BoundOpts<S, M>, expected: readonly NoInfer<U>[]): void;
  /**
   * Bound `replay` — returns `{ state, cmds, subs }` for the given opts.
   * Use for the "narrow-then-assert" pattern where the test inspects a
   * specific field after `state.type === "..."` discrimination.
   */
  replay(opts: BoundOpts<S, M>): { state: S; cmds: readonly C[]; subs: readonly U[] };
}

/**
 * Bind a machine + ctx into a small bag of 2-arg helpers. Each method
 * delegates to `replay(machine, { ...opts, ctx })` and pipes the result
 * through a single `expect(...)` matcher (or returns the raw tuple, for
 * `step` and `replay`).
 *
 * Use one bind per `describe` block (or per file) when many assertions
 * share the same machine + ctx. For one-off cross-machine calls, stick
 * with the free helpers from `./assertions.ts`.
 */
export function bindMachine<S, M extends { type: string }, C extends Cmd, U extends Sub, Ctx>(
  machine: Machine<S, M, C, U, Ctx>,
  ctx: Ctx,
): BoundMachine<S, M, C, U, Ctx> {
  return {
    step(loaded, msg) {
      const { state, cmds } = replay(machine, { msgs: [msg], ctx, loaded });
      return [state, cmds] as const;
    },
    expectFinalState(opts, expected) {
      const { state } = replay(machine, { ...opts, ctx });
      expect(state).toEqual(expected);
    },
    expectCmdEmitted(opts, cmd) {
      const { cmds } = replay(machine, { ...opts, ctx });
      expect(cmds).toContainEqual(cmd);
    },
    expectCmdSequence(opts, expected) {
      const { cmds } = replay(machine, { ...opts, ctx });
      expect(cmds).toEqual(expected);
    },
    expectActiveSubs(opts, expected) {
      const { subs } = replay(machine, { ...opts, ctx });
      expect(subs).toEqual(expected);
    },
    replay(opts) {
      return replay(machine, { ...opts, ctx });
    },
  };
}
