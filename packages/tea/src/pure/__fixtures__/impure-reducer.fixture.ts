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
  // biome-ignore lint/complexity/useDateNow: `new Date()` is the bait — the
  // guard's own test asserts this line is flagged as "new Date() (reads current
  // time)", so the suggested `Date.now()` rewrite would delete what is tested.
  roll: (s) => [{ ...s, roll: Math.random(), at: new Date().getTime() }, []],
};
