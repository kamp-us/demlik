// Type-level test for conditionally-required `subscribe`/`subscriptions` (#276).
// Compiled by `pnpm typecheck` (tsc over `src/**`, which INCLUDES `*.test-d.ts`;
// `*.test.ts` is excluded by tsconfig). Each `@ts-expect-error` MUST sit on a
// line that genuinely fails to type-check — if the conditional-required encoding
// regresses and the line stops erroring, the directive becomes "unused" and
// `tsc` fails the whole package. Every line without a directive is a positive
// case that must compile.
//
// The contract: a machine whose Sub union is `never` / `Sub<never>` compiles
// WITHOUT `subscribe`/`subscriptions` (nothing to wire); a machine declaring a
// real Sub union MUST provide both — omitting `subscribe` used to compile and
// silently wire no subs (`reconcileSubs` skips undefined handlers), the exact
// silent-failure class the `interpret` conditional already prevents.

import {
  defineMachine,
  type NoCtx,
  type Reducer,
  type Sub,
  type Subscribe,
  subId,
} from "../index";

type State = { readonly count: number };
type Msg = { readonly type: "bump" };
type TickSub = Sub<"tick">;

const update: Reducer<State, Msg, never> = {
  bump: (s) => [{ count: s.count + 1 }, []],
};

const subscribe: Subscribe<Msg, TickSub, NoCtx> = {
  tick: () => () => {},
};

const subscriptions = (_s: State): readonly TickSub[] => [
  { id: subId("tick"), type: "tick" },
];

// A subless machine (U = never) still compiles with NEITHER field.
export function sublessNever() {
  return defineMachine<State, Msg, never, never, NoCtx>({
    init: () => [{ count: 0 }, []],
    update,
  });
}

// `Sub<never>` (the spelled-out form) is equally exempt.
export function sublessSubNever() {
  return defineMachine<State, Msg, never, Sub<never>, NoCtx>({
    init: () => [{ count: 0 }, []],
    update,
  });
}

// A real Sub union with BOTH fields wired compiles.
export function subsWired() {
  return defineMachine<State, Msg, never, TickSub, NoCtx>({
    init: () => [{ count: 0 }, []],
    update,
    subscriptions,
    subscribe,
  });
}

// A real Sub union WITHOUT `subscribe` fails to compile — the silent-no-subs
// hole this test pins shut.
export function subsWithoutSubscribe() {
  // @ts-expect-error — U is a real Sub union, so `subscribe` is required
  return defineMachine<State, Msg, never, TickSub, NoCtx>({
    init: () => [{ count: 0 }, []],
    update,
    subscriptions,
  });
}

// A real Sub union WITHOUT `subscriptions` fails too — a subscribe map with no
// declaration function can never be reconciled in.
export function subsWithoutSubscriptions() {
  // @ts-expect-error — U is a real Sub union, so `subscriptions` is required
  return defineMachine<State, Msg, never, TickSub, NoCtx>({
    init: () => [{ count: 0 }, []],
    update,
    subscribe,
  });
}

// A real Sub union with NEITHER field is doubly wrong.
export function subsWithNeither() {
  // @ts-expect-error — U is a real Sub union, so both fields are required
  return defineMachine<State, Msg, never, TickSub, NoCtx>({
    init: () => [{ count: 0 }, []],
    update,
  });
}

// A multi-variant union does not distribute its way back to optional: the
// tuple-wrap (`[U] extends [Sub<never>]`) keeps `Sub<"a"> | Sub<"b">` in the
// required branch even though neither arm is `Sub<never>`.
type ASub = Sub<"a">;
type BSub = Sub<"b">;
export function multiVariantUnion() {
  // @ts-expect-error — a real (multi-variant) Sub union still requires both
  return defineMachine<State, Msg, never, ASub | BSub, NoCtx>({
    init: () => [{ count: 0 }, []],
    update,
  });
}
