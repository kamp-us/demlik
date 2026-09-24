// Type-level test for a handler's ctx on a machine that declares no context
// (#296). Compiled by `pnpm typecheck` (tsc over `src/**` INCLUDES
// `*.test-d.ts`). No runtime assertions: every `@ts-expect-error` MUST sit on a
// line that genuinely fails to type-check, and every undirected line is a
// positive case that must compile.
//
// The contract (`HandlerCtx<Ctx>`): a machine whose `Ctx` is `undefined` hands
// its handlers the kernel's half alone — `emit`, plus `ok` / `err` for a
// `Cmd.define`d Cmd — instead of `undefined & {…}`, which reduces to `never`.

import { z } from "zod";
import {
  Cmd,
  defineMachine,
  definePort,
  type Interpret,
  type InterpretDetached,
  type Settled,
  wrapDetached,
} from "../index";
import { run } from "../promise";

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

const progress = definePort<number>("progress");

// ── Interpret<M, C, undefined> ──────────────────────────────────────────────

const interpret: Interpret<Msg, AppCmd, undefined> = {
  // A `Cmd.define`d cell reaches `ok` / `err` (and `emit`) with no cast.
  fetch_name: async (cmd, ctx) => {
    ctx.emit(progress, 1);
    if (cmd.id === "") return ctx.err({ _tag: "not_found" });
    return ctx.ok(`user ${cmd.id}`);
  },
  // A hand-written cell reaches `emit` with no cast.
  ping: async (_cmd, ctx) => {
    ctx.emit(progress, 2);
    return { type: "pong" };
  },
};

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
  ctx.emit(progress, 3);
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
