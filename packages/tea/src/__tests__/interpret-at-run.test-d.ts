// Type-level test for handlers-at-run (#278, #251 R1.1). Compiled by
// `pnpm typecheck`. Each `@ts-expect-error` MUST sit on a line that genuinely
// fails to type-check; every line without one is a positive case.
//
// The contract: a `Machine` carries no `interpret`, so handing one to
// `defineMachine` is a type error in every overload family. The handlers are an
// option of `run` instead — required once the machine emits a Cmd, optional
// for a cmdless one, and checked per Cmd variant against the machine's own
// `M` / `C`.

import { z } from "zod";
import {
  Cmd,
  defineMachine,
  type Interpret,
  type Machine,
  type NoCtx,
  type Reducer,
  type Sub,
} from "../index";
import { run } from "../promise";

type State = { readonly n: number };
type Msg = { readonly type: "bump" } | { readonly type: "set"; n: number };
type Save = Cmd<"save"> & { readonly n: number };

const update: Reducer<State, Msg, Save> = {
  bump: (s) => [{ n: s.n + 1 }, [{ type: "save", n: s.n + 1 }]],
  set: (_s, m) => [{ n: m.n }, []],
};

const saving = defineMachine({
  types: { model: {} as State, msg: {} as Msg, cmd: {} as Save },
  init: () => [{ n: 0 }, []],
  update,
});

const interpret: Interpret<Msg, Save, unknown> = {
  save: async () => undefined,
};

// ── `Machine` has no `interpret` field ─────────────────────────────────────
type HasInterpret<T> = "interpret" extends keyof T ? true : false;
const noField: HasInterpret<Machine<State, Msg, Save, Sub<never>, NoCtx>> =
  false;
void noField;

export const annotated: Machine<State, Msg, Save, Sub<never>, NoCtx> = {
  init: () => [{ n: 0 }, []],
  update,
  // @ts-expect-error — a machine carries no handlers; pass them to `run`
  interpret,
};

// ── handing `interpret` to `defineMachine` is refused, every form ──────────
//
// With every overload refusing the literal, TS reports the call against the
// LAST overload it tried, at the first property that overload cannot take —
// so each directive below sits on that line. What it proves is the call as a
// whole: were `interpret` accepted, the call would resolve and the directive
// would go unused.

export const typesForm = defineMachine({
  // @ts-expect-error — a machine carries no handlers; pass them to `run`
  types: { model: {} as State, msg: {} as Msg, cmd: {} as Save },
  init: () => [{ n: 0 }, []],
  update,
  interpret,
});

const lookup = Cmd.define("lookup", {
  input: z.object({ id: z.string() }),
  ok: z.object({ name: z.string() }),
  err: ["not_found"],
});
export const cmdsForm = defineMachine({
  // @ts-expect-error — a machine carries no handlers; pass them to `run`
  types: { model: {} as State, msg: {} as Msg },
  cmds: [lookup],
  init: () => [{ n: 0 }, []],
  update: {
    bump: (s) => [s, []],
    set: (s) => [s, []],
    lookup_ok: (s) => [s, []],
    lookup_err: (s) => [s, []],
  },
  interpret: { lookup: async () => ({ _tag: "Ok", value: { name: "x" } }) },
});

// @ts-expect-error — a machine carries no handlers; pass them to `run`
export const reducerForm = defineMachine<State, Msg, Save, Sub<never>, NoCtx>({
  init: () => [{ n: 0 }, []],
  update,
  interpret,
});

// ── `run` takes the handlers ───────────────────────────────────────────────
export const wired = run(saving, { interpret });

// A machine that emits a Cmd must be handed a handler for it.
// @ts-expect-error — `interpret` is required once the machine emits a Cmd
export const unwired = run(saving, {});

export const missingCell = run(saving, {
  // @ts-expect-error — every Cmd variant needs its handler
  interpret: {},
});

export const wrongCell = run(saving, {
  interpret: {
    // @ts-expect-error — a handler resolves to a Msg of the machine's union
    save: async () => ({ type: "not_a_msg" }),
  },
});

// A handler's parameters are read off the machine: `cmd` is `Save` here.
export const contextual = run(saving, {
  interpret: {
    save: async (cmd) => ({ type: "set", n: cmd.n }),
  },
});

// A cmdless machine needs no `interpret` at all.
const pure = defineMachine({
  types: { model: {} as State, msg: {} as Msg },
  init: () => [{ n: 0 }, []],
  update: {
    bump: (s) => [{ n: s.n + 1 }, []],
    set: (_s, m) => [{ n: m.n }, []],
  },
});
export const pureRun = run(pure, {});
