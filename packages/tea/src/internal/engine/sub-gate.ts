/**
 * The one say a host has over a run's Subs: when a Sub the State asks for really
 * runs. `/react` closes it while a component is hidden, so the Subs stop and the
 * run, with its Cmds in flight, stays.
 *
 * It sits where a Sub starts in the core loop, so it gates whatever the engine's
 * runner is: the Promise engine's `Dispose`-returning functions and the Effect
 * engine's `Stream` drains reach it as the same `LoopRunner`. To the loop each
 * Sub stays started for as long as its State wants it.
 *
 * The key is symbol-keyed and read off the options `run` was handed, so it is in
 * no published options type, and enumerable so it survives a wrapper's spread.
 * Its own file so `/react` reads it without importing an engine.
 */

import type { Dispose } from "../../pure/core";

export const subGate: unique symbol = Symbol("demlik-tea.subGate");

/** What the loop asks of a gate when the State wants a Sub started. */
export interface SubAdmission {
  /**
   * Called for each Sub the loop starts. Returns the Sub's cleanup, which the
   * loop calls when the State no longer wants it. `begin` starts the real runner
   * and may run now, later, more than once, or not at all: a gate that closes
   * stops the runner and starts it again when it opens.
   */
  admit(begin: () => Dispose): Dispose;
}

/** Options `run` was handed, with the gate a host put on them. */
export interface SubGateOption {
  readonly [subGate]: SubAdmission;
}

/** The gate on `opts`, or `undefined` when no host put one there. */
export function subGateOf(opts: object): SubAdmission | undefined {
  return (opts as Partial<SubGateOption>)[subGate];
}
