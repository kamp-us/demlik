// Type-level test for the `subscribe` option of `run` (#276, #279). Compiled by
// `pnpm typecheck` (tsc over `src/**`, which INCLUDES `*.test-d.ts`; `*.test.ts`
// is excluded by tsconfig). Each `@ts-expect-error` MUST sit on a line that
// genuinely fails to type-check — if the encoding regresses and the line stops
// erroring, the directive becomes "unused" and `tsc` fails the whole package.
// Every line without a directive is a positive case that must compile.
//
// The contract: a machine is data. It declares `subs: [{ type, deps(state) }]`
// and carries no runner, so `subscriptions` / `subscribe` on a machine are type
// errors. The runners arrive at `run` in `subscribe`: REQUIRED, one per type,
// when the machine's `types.sub` names a type other than the built-in `timer`
// (a missing runner used to compile and silently start nothing); optional when
// the machine declares no Subs or only `timer`; and a user `timer` runner is
// accepted in place of the built-in.

import {
  defineMachine,
  type Machine,
  type NoCtx,
  type Reducer,
  type Sub,
  type Subscribe,
} from "../index";
import { run } from "../promise";
import { useMachine } from "../react";

type State = { readonly count: number };
type Msg = { readonly type: "bump" };
type TickSub = Sub<"tick", { readonly every: number }>;

const update: Reducer<State, Msg, never> = {
  bump: (s) => [{ count: s.count + 1 }, []],
};

const subscribe: Subscribe<Msg, TickSub, NoCtx> = {
  tick: () => () => {},
};

const ticking = defineMachine({
  types: {
    model: {} as State,
    msg: {} as Msg,
    sub: {} as TickSub,
    ctx: {} as NoCtx,
  },
  init: () => [{ count: 0 }, []],
  update,
  subs: [{ type: "tick", deps: (s) => ({ every: s.count }) }],
});

// ── a declared Sub type needs its runner at `run` ──────────────────────────
export const wired = run(ticking, { subscribe });

// A runner's `sub` is typed off the machine: `deps` is the entry's value.
export const contextual = run(ticking, {
  subscribe: {
    tick: (sub) => {
      const every: number = sub.deps.every;
      void every;
      return () => {};
    },
  },
});

// @ts-expect-error — `types.sub` names `tick`, so `subscribe` is required
export const unwired = run(ticking, {});

export const missingRunner = run(ticking, {
  // @ts-expect-error — every declared Sub type needs its runner
  subscribe: {},
});

// A multi-variant union does not collapse to optional: both runners are owed.
type ASub = Sub<"a", { readonly n: number }>;
type BSub = Sub<"b", { readonly n: number }>;
const twoTypes = defineMachine({
  types: {
    model: {} as State,
    msg: {} as Msg,
    sub: {} as ASub | BSub,
    ctx: {} as NoCtx,
  },
  init: () => [{ count: 0 }, []],
  update,
  subs: [
    { type: "a", deps: (s) => ({ n: s.count }) },
    { type: "b", deps: (s) => ({ n: s.count }) },
  ],
});
export const bothRunners = run(twoTypes, {
  subscribe: { a: () => () => {}, b: () => () => {} },
});
export const oneRunner = run(twoTypes, {
  // @ts-expect-error — `b` is declared too, so its runner is owed
  subscribe: { a: () => () => {} },
});

// `useMachine` takes the same handlers, so the same requiredness holds there.
export function Hosted(): null {
  useMachine(ticking, { run, ctx: {}, subscribe });
  // @ts-expect-error — `types.sub` names `tick`, so `subscribe` is required
  useMachine(ticking, { run, ctx: {} });
  return null;
}

// ── no Subs, or only the built-in `timer`: `subscribe` is optional ─────────
const subless = defineMachine({
  types: { model: {} as State, msg: {} as Msg, ctx: {} as NoCtx },
  init: () => [{ count: 0 }, []],
  update,
});
export const sublessRun = run(subless, {});

const timed = defineMachine({
  types: { model: {} as State, msg: {} as Msg, ctx: {} as NoCtx },
  init: () => [{ count: 0 }, []],
  update,
  subs: [
    {
      type: "timer",
      deps: (s) => (s.count < 3 ? { ms: 1_000, msg: { type: "bump" } } : null),
    },
  ],
});
export const timedRun = run(timed, {});

// A user `timer` replaces the built-in; its `sub.deps` is the timer's.
export const fakeClock = run(timed, {
  subscribe: {
    timer: (sub, _ctx, dispatch) => {
      const ms: number = sub.deps.ms;
      void ms;
      dispatch(sub.deps.msg);
      return () => {};
    },
  },
});

// A machine with its own Sub type may still override `timer` beside it.
export const overrideBeside = run(ticking, {
  subscribe: { ...subscribe, timer: () => () => {} },
});

// ── a `subs` entry is checked against its Sub variant ──────────────────────
//
// With every overload refusing the literal, TS reports the call against the
// LAST overload it tried, at its first property — so each directive below
// sits on `types`. What it proves is the call as a whole: were the entry
// accepted, the call would resolve and the directive would go unused.
export const wrongDeps = defineMachine({
  // @ts-expect-error — `tick`'s deps are `{ every: number }`, not a string
  types: {
    model: {} as State,
    msg: {} as Msg,
    sub: {} as TickSub,
    ctx: {} as NoCtx,
  },
  init: () => [{ count: 0 }, []],
  update,
  subs: [{ type: "tick", deps: () => "every-second" }],
});

export const undeclaredType = defineMachine({
  // @ts-expect-error — `poll` is not a declared (or built-in) Sub type
  types: { model: {} as State, msg: {} as Msg, ctx: {} as NoCtx },
  init: () => [{ count: 0 }, []],
  update,
  subs: [{ type: "poll", deps: () => ({ every: 1 }) }],
});

// ── a machine carries no runner ────────────────────────────────────────────
type HasField<T, K extends string> = K extends keyof T ? true : false;
const noSubscribe: HasField<
  Machine<State, Msg, never, TickSub, NoCtx>,
  "subscribe"
> = false;
const noSubscriptions: HasField<
  Machine<State, Msg, never, TickSub, NoCtx>,
  "subscriptions"
> = false;
void noSubscribe;
void noSubscriptions;

export const withSubscribe: Machine<State, Msg, never, TickSub, NoCtx> = {
  init: () => [{ count: 0 }, []],
  update,
  // @ts-expect-error — a machine carries no runners; pass them to `run`
  subscribe,
};

export const withSubscriptions: Machine<State, Msg, never, TickSub, NoCtx> = {
  init: () => [{ count: 0 }, []],
  update,
  // @ts-expect-error — a machine declares `subs`, never a `subscriptions` list
  subscriptions: () => [],
};
