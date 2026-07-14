/**
 * Guard-the-guard bait for `reducer-purity.test.ts` (#228). DELIBERATELY
 * IMPURE: every reducer cell below reaches a banned id/timestamp mint, which
 * the fold-purity guard MUST flag. This file lives under `__fixtures__/`, so
 * the production scan excludes it — it is scanned only by the guard's own test
 * to prove the guard actually fires. Never `run()`/`replay()` this machine.
 */

import type { Reducer } from "../core";

type State = {
  readonly id: string;
  readonly at: number;
  readonly roll: number;
};

type Msg = { readonly type: "spawn" } | { readonly type: "roll" };

export const impureUpdate: Reducer<State, Msg, never> = {
  spawn: (s) => [{ ...s, id: crypto.randomUUID(), at: Date.now() }, []],
  roll: (s) => [{ ...s, roll: Math.random(), at: new Date().getTime() }, []],
};
