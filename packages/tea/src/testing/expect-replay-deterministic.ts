import { expect, vi } from "vitest";
import { type Cmd, type Machine, replay, type Sub } from "../index";
import type { ReplayOpts } from "./assertions";

interface Ambient {
  readonly now: number;
  readonly rng: number;
}

const AMBIENT_A: Ambient = { now: 1_000_000, rng: 0.123 };
const AMBIENT_B: Ambient = { now: 9_876_543, rng: 0.987 };

/**
 * Assert that replaying `opts.msgs` is a pure function of the Msg log: the
 * final state and every emitted Cmd come out the same under two different
 * global wall-clocks and RNG seeds.
 *
 * `init` and `update` never receive a clock, so a cell that reads
 * `Date.now()` or `Math.random()` reaches for the global one, and a replay of
 * the same log on another day or another host lands somewhere else. Two
 * back-to-back replays under one clock would hide that; this helper stubs
 * two distinct ambients and compares. Time belongs in the Msg (an `at`
 * field), where it is identical across replays.
 *
 * Subs are not compared: they are derived from the final state, so a state
 * that matches yields the same Subs.
 */
export function expectReplayDeterministic<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  opts: NoInfer<ReplayOpts<S, M, Ctx>>,
): void {
  const a = underAmbient(AMBIENT_A, () => replay(machine, opts));
  const b = underAmbient(AMBIENT_B, () => replay(machine, opts));
  expect(
    b.state,
    "final state changed under a different clock/RNG: init or update reads " +
      "Date.now()/Math.random(); time must enter as Msg data",
  ).toEqual(a.state);
  expect(
    b.cmds,
    "emitted Cmds changed under a different clock/RNG: a Cmd payload reads " +
      "Date.now()/Math.random(); time must enter as Msg data",
  ).toEqual(a.cmds);
}

/** Run `fn` with the global `Date.now` and `Math.random` pinned, then restore them. */
function underAmbient<T>(ambient: Ambient, fn: () => T): T {
  const nowSpy = vi.spyOn(Date, "now").mockReturnValue(ambient.now);
  const rngSpy = vi.spyOn(Math, "random").mockReturnValue(ambient.rng);
  try {
    return fn();
  } finally {
    nowSpy.mockRestore();
    rngSpy.mockRestore();
  }
}
