// Type-level test for the compile-time reentrancy guard (ADR 0003 primitive #5,
// issue #71). This file is compiled by `pnpm typecheck` (tsc over all of
// `src/**`). It has no runtime assertions: each `@ts-expect-error` MUST sit on a
// line that genuinely fails to type-check — if the guard regresses and the line
// stops erroring, the `@ts-expect-error` becomes "unused" and `tsc` fails the
// whole package. Every line without a directive is a positive case that must
// compile.
//
// The canon rule (`.patterns/tea-do/reentrancy.md`): a reducer must never
// inline-`await` a re-entrant result. The encoding: every reducer/transition
// cell returns the non-thenable `SyncReturn<S, C>`, so an `async` cell (which
// returns `Promise<...>`) is unrepresentable. The minting paths are `asReducer`
// and `defineMachine`.

import {
  asReducer,
  type Cmd,
  defineMachine,
  type Reducer,
  type SyncReturn,
  type Transitions,
} from "../index";

type State = { count: number };
type Msg = { type: "inc" } | { type: "dec" };
// Use a cmd-less machine (`Cmd<never>`) so `interpret` is optional — keeps these
// type-level cases focused on the reducer guard, not on effect wiring.
type NoCmd = Cmd<never>;

// ── NEGATIVE: an async reducer cell fails to compile under `asReducer` ──────────
// The async `inc` returns `Promise<readonly [State, readonly NoCmd[]]>`, which is
// not assignable to the non-thenable `SyncReturn<State, NoCmd>`. The error lands
// on the cell, so `@ts-expect-error` catches it precisely.
asReducer<State, Msg, NoCmd>({
  // @ts-expect-error async reducer returns a Promise — non-thenable SyncReturn rejects it
  inc: async (s, _m) => [{ count: s.count + 1 }, []],
  dec: (s, _m) => [{ count: s.count - 1 }, []],
});

// An inline-`await`ing cell is async under the hood and is rejected the same way.
asReducer<State, Msg, NoCmd>({
  // @ts-expect-error an inline-awaiting reducer returns a Promise — rejected
  inc: async (s, _m) => {
    await Promise.resolve();
    return [{ count: s.count + 1 }, []];
  },
  dec: (s, _m) => [{ count: s.count - 1 }, []],
});

// ── POSITIVE: a pure synchronous reducer compiles (no directive) ────────────────
const branded = asReducer<State, Msg, NoCmd>({
  inc: (s, _m) => [{ count: s.count + 1 }, []],
  dec: (s, _m) => [{ count: s.count - 1 }, []],
});
void branded;

// ── NEGATIVE: an async reducer cell fails under `defineMachine` too ─────────────
// Under a failed overload the error surfaces at the call, so the directive sits
// on the `defineMachine(` line rather than the cell.
// @ts-expect-error async reducer cell makes the machine literal fail to type-check
defineMachine<State, Msg, NoCmd, never, undefined>({
  init: () => [{ count: 0 }, []],
  update: {
    inc: async (s, _m) => [{ count: s.count + 1 }, []],
    dec: (s, _m) => [{ count: s.count - 1 }, []],
  },
});

// ── POSITIVE: a pure synchronous machine compiles ───────────────────────────────
const syncMachine = defineMachine<State, Msg, NoCmd, never, undefined>({
  init: () => [{ count: 0 }, []],
  update: {
    inc: (s, _m) => [{ count: s.count + 1 }, []],
    dec: (s, _m) => [{ count: s.count - 1 }, []],
  },
});
void syncMachine;

// ── The structural `: Reducer<...>` annotation form still accepts a plain literal ─
const annotated: Reducer<State, Msg, NoCmd> = {
  inc: (s, _m) => [{ count: s.count + 1 }, []],
  dec: (s, _m) => [{ count: s.count - 1 }, []],
};
void annotated;

// ── Transitions cells carry the same guard ──────────────────────────────────────
type Phase = { type: "idle" } | { type: "busy" };
type PhaseMsg = { type: "go" } | { type: "stop" };

// NEGATIVE: an async transition cell makes the table fail to type-check; the
// error surfaces at the `defineMachine(` call.
// @ts-expect-error async transition cell returns a Promise — rejected
defineMachine<Phase, PhaseMsg, NoCmd, never, undefined>({
  init: () => [{ type: "idle" }, []],
  update: {
    idle: {
      go: async (_s, _m) => [{ type: "busy" }, []],
      stop: (s, _m) => [s, []],
    },
    busy: {
      go: (s, _m) => [s, []],
      stop: (_s, _m) => [{ type: "idle" }, []],
    },
  },
});

// POSITIVE: a pure synchronous transition table compiles.
const transitions: Transitions<Phase, PhaseMsg, NoCmd> = {
  idle: {
    go: (_s, _m) => [{ type: "busy" }, []],
    stop: (s, _m) => [s, []],
  },
  busy: {
    go: (s, _m) => [s, []],
    stop: (_s, _m) => [{ type: "idle" }, []],
  },
};
void transitions;

// ── `SyncReturn<S, C>` itself: a sync tuple satisfies it, a Promise does not ─────
const okReturn: SyncReturn<State, NoCmd> = [{ count: 0 }, []];
void okReturn;

// @ts-expect-error a Promise is thenable, so it is not a SyncReturn
const badReturn: SyncReturn<State, NoCmd> = Promise.resolve([
  { count: 0 },
  [],
]) as Promise<readonly [State, readonly NoCmd[]]>;
void badReturn;
