// Type-level test for a handler's ctx on a machine that declares no context
// (#296). Compiled by `pnpm typecheck` (tsc over `src/**` INCLUDES
// `*.test-d.ts`). No runtime assertions: every `@ts-expect-error` MUST sit on a
// line that genuinely fails to type-check, and every undirected line is a
// positive case that must compile.
//
// The contract (`HandlerCtx<Ctx>`): a machine whose `Ctx` is `undefined` hands
// its handlers the kernel's half alone — `ok` / `err` for a `Cmd.define`d Cmd
// — instead of `undefined & {…}`, which reduces to `never`. The kernel's half
// carries no `emit`: the old port family is gone (#664), so a handler that
// calls `ctx.emit` does not compile, with or without a declared Ctx.
//
// Each `emit` case below is a bare property read, never a call. A call with
// wrong arguments fails whether or not `emit` exists, so it would stay green if
// `emit` came back. A bare read compiles the moment the property is there,
// which leaves its `@ts-expect-error` unused and fails the typecheck.

import { z } from "zod";
import {
  Cmd,
  defineMachine,
  type Interpret,
  type InterpretDetached,
  type Settled,
  wrapDetached,
} from "../index";
import { run } from "../promise";
import type { HandlerCtx } from "../pure/core";

const fetchName = Cmd.define("fetch_name", {
  input: z.object({ id: z.string() }),
  ok: z.string(),
  err: ["not_found"],
});

type Ping = { readonly type: "ping" };
type Pong = { readonly type: "pong" };
type Go = { readonly type: "go" };
type Msg = Go | Pong | Settled<typeof fetchName>;
type AppCmd = ReturnType<typeof fetchName> | Ping;

// ── Interpret<M, C, undefined> ──────────────────────────────────────────────

const interpret: Interpret<Msg, AppCmd, undefined> = {
  // A `Cmd.define`d cell reaches `ok` / `err` with no cast.
  fetch_name: async (cmd, ctx) => {
    if (cmd.id === "") return ctx.err({ _tag: "not_found" });
    return ctx.ok(`user ${cmd.id}`);
  },
  ping: async () => ({ type: "pong" }),
};

// No handler ctx carries `emit`.
const emitting: Interpret<Msg, AppCmd, undefined> = {
  fetch_name: async (cmd, ctx) => {
    // @ts-expect-error a `Cmd.define`d cell's ctx has no `emit`
    void ctx.emit;
    return ctx.ok(`user ${cmd.id}`);
  },
  ping: async (_cmd, ctx) => {
    // @ts-expect-error a hand-written cell's ctx has no `emit`
    void ctx.emit;
    return { type: "pong" };
  },
};
void emitting;

// `err` is still typed to the def's declared tags.
const undeclared: Interpret<Msg, AppCmd, undefined> = {
  fetch_name: async (_cmd, { err }) =>
    // @ts-expect-error `timeout` is not a declared tag of `fetch_name`
    err({ _tag: "timeout" }),
  ping: async () => undefined,
};
void undeclared;

// ── the same table handed to `run` for a `ctx: undefined` machine ──────────

const machine = defineMachine({
  types: {
    model: {} as { readonly n: number },
    msg: {} as Msg,
    cmd: {} as AppCmd,
    ctx: undefined,
  },
  cmds: [fetchName],
  init: () => [{ n: 0 }, []],
  update: {
    go: (s) => [s, [fetchName({ id: "u1" }), { type: "ping" }]],
    pong: (s) => [s, []],
    fetch_name_ok: (s) => [s, []],
    fetch_name_err: (s) => [s, []],
  },
});
void run(machine, { ctx: undefined, interpret });

// ── InterpretDetached<C, Allowed, undefined> ───────────────────────────────

const detached: InterpretDetached<Ping, Pong, undefined> = async (
  _cmd,
  ctx,
  dispatch,
) => {
  // @ts-expect-error a detached handler's ctx has no `emit`
  void ctx.emit;
  dispatch({ type: "pong" });
};
const wrapped = wrapDetached<Ping, Msg, Pong, undefined>(detached);
void wrapped;

// ── a present Ctx is unchanged ──────────────────────────────────────────────

type Db = { readonly db: { readonly get: (id: string) => string } };

// A declared Ctx still reaches the handler, beside the kernel's half.
const withCtx: Interpret<Msg, AppCmd, Db> = {
  fetch_name: async (cmd, ctx) => ctx.ok(ctx.db.get(cmd.id)),
  ping: async () => undefined,
};
void withCtx;

// A declared Ctx gains no `emit` either: the handler reads exactly its Ctx.
const withCtxEmitting: Interpret<Msg, AppCmd, Db> = {
  fetch_name: async (cmd, ctx) => {
    // @ts-expect-error `emit` is not on `Db`, and the kernel adds none
    void ctx.emit;
    return ctx.ok(ctx.db.get(cmd.id));
  },
  ping: async (_cmd, ctx) => {
    // @ts-expect-error `emit` is not on `Db`, and the kernel adds none
    void ctx.emit;
  },
};
void withCtxEmitting;

// A detached handler with a declared Ctx gains none either.
const detachedWithCtx: InterpretDetached<Ping, Pong, Db> = async (
  _cmd,
  ctx,
  dispatch,
) => {
  // @ts-expect-error `emit` is not on `Db`, and the kernel adds none
  void ctx.emit;
  dispatch({ type: "pong" });
};
void detachedWithCtx;

// ── the alias itself has no `emit` key ──────────────────────────────────────
//
// The same fact stated on `HandlerCtx`, the one alias every handler-ctx site
// builds on. `true` is assignable only while `emit` is not a key.

type LacksEmit<T> = "emit" extends keyof T ? false : true;

const noCtxLacksEmit: LacksEmit<HandlerCtx<undefined>> = true;
const declaredCtxLacksEmit: LacksEmit<HandlerCtx<Db>> = true;
void noCtxLacksEmit;
void declaredCtxLacksEmit;
