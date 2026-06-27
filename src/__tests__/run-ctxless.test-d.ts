// Type-level test for `run()`'s conditionally-optional `ctx` (#182). Compiled by
// `pnpm typecheck` (tsc over `src/**`, which INCLUDES `*.test-d.ts`; `*.test.ts`
// is excluded by tsconfig). No runtime assertions: each `@ts-expect-error` MUST
// sit on a line that genuinely fails to type-check — if the conditional-optional
// encoding regresses and the line stops erroring, the directive becomes "unused"
// and `tsc` fails the whole package. Every line without a directive is a
// positive case that must compile.
//
// The contract (`CtxArg<Ctx>`): a machine whose `Ctx` is satisfiable by the
// empty object (`NoCtx`, `Record<string, never>` — the vortex arena grain) runs
// with `ctx` OMITTED; a machine whose `Ctx` carries a field a handler reads
// keeps `ctx` REQUIRED.

import { defineMachine, type NoCtx, type Reducer, run } from "../index";

type State = { readonly count: number };
type Msg = { readonly type: "bump" };

const pureUpdate: Reducer<State, Msg, never> = {
  bump: (s) => [{ count: s.count + 1 }, []],
};

// A PURE machine: Ctx = NoCtx (reads nothing from ctx).
function pureMachine() {
  return defineMachine<State, Msg, never, never, NoCtx>({
    init: () => [{ count: 0 }, []],
    update: pureUpdate,
  });
}

// vortex-style pure grain: Ctx = Record<string, never>.
function recordNeverMachine() {
  return defineMachine<State, Msg, never, never, Record<string, never>>({
    init: () => [{ count: 0 }, []],
    update: pureUpdate,
  });
}

// A CONTEXT-BEARING machine: Ctx has a field `init` reads.
type DbCtx = { readonly db: { readonly read: () => number } };
function dbMachine() {
  return defineMachine<State, Msg, never, never, DbCtx>({
    init: (_loaded, ctx) => [{ count: ctx.db.read() }, []],
    update: pureUpdate,
  });
}

// ── POSITIVE: a pure machine runs with NO ctx (the #182 win) ────────────────
run(pureMachine(), {});
run(pureMachine(), { ctx: {} }); // an explicit ctx still compiles (additive)
run(recordNeverMachine(), {});
run(recordNeverMachine(), { ctx: {} });

// ── NEGATIVE: a context-bearing machine still REQUIRES ctx ──────────────────
// @ts-expect-error pure-call form rejected — DbCtx is not satisfiable by {} (ctx required)
run(dbMachine(), {});

// ── POSITIVE: providing the required ctx compiles ───────────────────────────
run(dbMachine(), { ctx: { db: { read: () => 1 } } });
