/**
 * Typed effect channels on Cmd constructors — the RUNTIME half (ADR 0014, #44).
 * The compile-time half (an `_err` cell must cover every `_tag`; `run` refuses
 * a ctx missing a key the machine's `ctx` names) lives in `__tests__/typed-cmd-channels.test-d.ts`.
 *
 * What the runtime owes:
 *   - the emitted Cmd is still a plain `{ type, ...input }` record (JSON
 *     round-trip equal) — the channels are phantoms;
 *   - a handler returns an outcome and the engine mints the Msg (ADR 0021):
 *     `ok(v)` → `<name>_ok`, a declared `err({ _tag })` → `<name>_err`, and an
 *     undeclared failure (a throw, an undeclared tag) → the error sink, never
 *     `_err`;
 *   - an `Ok` value is parsed against the `ok` schema at the interpret edge: a
 *     value that fails becomes the minted `_err` carrying `malformed_result`,
 *     and Model never sees the corrupt value;
 *   - `fetch_ok` / `fetch_err` dispatch through a machine whose user-facing
 *     `Msg` never names them;
 *   - `at` is stamped from `run`'s clock on every settled Msg.
 */

import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AsyncSchemaError,
  Cmd,
  defineMachine,
  type Interpret,
  type MalformedResult,
  type NoCtx,
  Outcome,
  OutcomeContractError,
  type Reducer,
  type RuntimeErrorContext,
  type Settled,
  UndeclaredFailureError,
} from "./index";
import { run } from "./promise";
import { cmdEdgeOf } from "./pure/core";

type Http = { readonly get: (url: string) => Promise<unknown> };
type HttpCtx = { readonly http: Http };

const fetch = Cmd.define("fetch", {
  input: z.object({ url: z.string() }),
  ok: z.object({ body: z.string() }),
  err: ["not_found", "timeout"],
});

type FetchCmd = ReturnType<typeof fetch>;
type FetchSettled = Settled<typeof fetch>;

type Model = {
  readonly body: string | null;
  readonly errors: readonly FetchSettled["type"][];
  readonly lastError:
    | Extract<FetchSettled, { type: "fetch_err" }>["error"]
    | null;
  readonly ats: readonly number[];
};
type Msg = { readonly type: "go"; readonly url: string };

const initial: Model = { body: null, errors: [], lastError: null, ats: [] };

const update: Reducer<Model, Msg | FetchSettled, FetchCmd> = {
  go: (m, msg) => [m, [fetch({ url: msg.url })]],
  fetch_ok: (m, msg) => [
    { ...m, body: msg.value.body, ats: [...m.ats, msg.at] },
    [],
  ],
  fetch_err: (m, msg) => [
    {
      ...m,
      errors: [...m.errors, msg.type],
      lastError: msg.error,
      ats: [...m.ats, msg.at],
    },
    [],
  ],
};

/**
 * One machine; its handlers are parameterised on what the http "server"
 * answers, so each test picks the boundary case it is about. The handler
 * forwards whatever `http` returns as the `Ok` value — the interpret EDGE is
 * what decides whether that value is an `_ok` or a `malformed_result`.
 */
const machine = defineMachine({
  types: { model: {} as Model, msg: {} as Msg, ctx: {} as HttpCtx },
  cmds: [fetch],
  init: (_loaded) => [initial, []],
  update,
});

function interpretOver(
  work: (cmd: FetchCmd, http: Http) => Promise<unknown>,
): Interpret<Msg | FetchSettled, FetchCmd, HttpCtx> {
  return {
    fetch: async (cmd, { http, ok }) =>
      // Deliberately unparsed: `work` may answer with a shape the schema
      // rejects, and that reaching the reducer is the corruption under test.
      ok((await work(cmd, http)) as { body: string }),
  };
}

const fixedClock = (at: number) => () => at;

describe("Cmd.define — the emitted Cmd is still a plain record", () => {
  it("builds `{ type, ...input }` and survives a JSON round-trip unchanged", () => {
    const cmd = fetch({ url: "/users" });
    expect(cmd).toEqual({ type: "fetch", url: "/users" });
    expect(JSON.parse(JSON.stringify(cmd))).toEqual(cmd);
    // The channels are phantoms: nothing rides on the value.
    expect(Object.keys(cmd).sort()).toEqual(["type", "url"]);
  });

  it("carries its declaration for the runtime edge", () => {
    expect(fetch.cmdType).toBe("fetch");
    expect(fetch.okType).toBe("fetch_ok");
    expect(fetch.errType).toBe("fetch_err");
    expect(fetch.errTags).toEqual(["not_found", "timeout"]);
  });

  it("mints the settled Msgs, leaving `at` to the runtime unless handed one", () => {
    const cmd = fetch({ url: "/" });
    expect(fetch.ok(cmd, { body: "x" })).toEqual({
      type: "fetch_ok",
      cmd,
      value: { body: "x" },
    });
    expect(fetch.err(cmd, { _tag: "timeout" }, 42)).toEqual({
      type: "fetch_err",
      cmd,
      error: { _tag: "timeout" },
      at: 42,
    });
  });
});

describe("the interpret edge parses a handler's `_ok` value (invariant 8)", () => {
  it("a value that passes the `ok` schema folds into Model, stamped with `at`", async () => {
    const rt = await run(machine, {
      interpret: interpretOver(async () => ({ body: "hello" })),
      ctx: { http: { get: async () => "unused" } },
      clock: fixedClock(1_000),
    }).ready;
    const seen: string[] = [];
    rt.observe((msg) => {
      seen.push(msg.type);
    });

    await rt.dispatch({ type: "go", url: "/" });

    expect(rt.getState().body).toBe("hello");
    expect(rt.getState().ats).toEqual([1_000]);
    // `fetch_ok` reached the reducer though `Msg` never names it.
    expect(seen).toEqual(["go", "fetch_ok"]);
  });

  it("a value that FAILS the schema becomes the minted `_err` with a `_tag`; Model is unchanged", async () => {
    const rt = await run(
      // The "server" answers a number where the schema wants `{ body }`.
      machine,
      {
        interpret: interpretOver(async () => ({ body: 42 })),
        ctx: { http: { get: async () => "unused" } },
        clock: fixedClock(7),
      },
    ).ready;
    const seen: (Msg | FetchSettled)[] = [];
    rt.observe((msg) => {
      seen.push(msg);
    });

    await rt.dispatch({ type: "go", url: "/" });

    const state = rt.getState();
    // The corrupt value never reached the `_ok` cell.
    expect(state.body).toBe(initial.body);
    // The reducer saw the typed `_err` instead, with the kernel's tag.
    expect(state.errors).toEqual(["fetch_err"]);
    expect(state.lastError?._tag).toBe("malformed_result");
    const malformed = state.lastError as MalformedResult;
    expect(malformed.issues).toHaveLength(1);
    expect(malformed.issues[0]?.path).toBe("body");
    expect(state.ats).toEqual([7]);
    // And it is a settled-value error (ADR 0011): plain data, JSON round-trip equal.
    expect(malformed).not.toBeInstanceOf(Error);
    expect(JSON.parse(JSON.stringify(malformed))).toEqual(malformed);
    expect(seen.map((m) => m.type)).toEqual(["go", "fetch_err"]);
    const errMsg = seen[1] as Extract<FetchSettled, { type: "fetch_err" }>;
    expect(errMsg.cmd).toEqual({ type: "fetch", url: "/" });
  });

  it("the parsed value is what lands (zod strips a key the schema does not name)", async () => {
    const rt = await run(machine, {
      interpret: interpretOver(async () => ({
        body: "kept",
        extra: "dropped",
      })),
      ctx: { http: { get: async () => "unused" } },
    }).ready;
    const seen: (Msg | FetchSettled)[] = [];
    rt.observe((msg) => {
      seen.push(msg);
    });

    await rt.dispatch({ type: "go", url: "/" });

    const okMsg = seen[1] as Extract<FetchSettled, { type: "fetch_ok" }>;
    expect(okMsg.value).toEqual({ body: "kept" });
  });

  it("defaults the clock to Date.now", async () => {
    const before = Date.now();
    const rt = await run(machine, {
      interpret: interpretOver(async () => ({ body: "t" })),
      ctx: { http: { get: async () => "unused" } },
    }).ready;
    await rt.dispatch({ type: "go", url: "/" });
    const [at] = rt.getState().ats;
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
  });
});

describe("the handler returns an outcome; the engine mints the Msg (ADR 0021)", () => {
  type Handler = (
    cmd: FetchCmd,
    helpers: {
      readonly http: Http;
      readonly ok: (value: {
        body: string;
      }) => Outcome<{ body: string }, never>;
      readonly err: (
        error: { _tag: "not_found" } | { _tag: "timeout" },
      ) => Outcome<never, { _tag: "not_found" } | { _tag: "timeout" }>;
    },
  ) => Promise<unknown>;

  /** Run one `go` through a machine whose `fetch` handler is `handler`. */
  async function goOnce(handler: Handler, clock = fixedClock(5)) {
    const reports: { error: unknown; context: RuntimeErrorContext }[] = [];
    const m = defineMachine({
      types: { model: {} as Model, msg: {} as Msg, ctx: {} as HttpCtx },
      cmds: [fetch],
      init: (_loaded) => [initial, []],
      update,
    });
    const rt = await run(m, {
      interpret: {
        // The cast lets a test return what the contract forbids; the edge is
        // what must refuse it.
        fetch: handler as never,
      },
      ctx: { http: { get: async (url) => `body of ${url}` } },
      clock,
      onError: (error, context) => {
        reports.push({ error, context });
      },
    }).ready;
    const seen: string[] = [];
    rt.observe((msg) => {
      seen.push(msg.type);
    });
    await rt.dispatch({ type: "go", url: "/a" });
    return { state: rt.getState(), seen, reports };
  }

  it("`ok(v)` dispatches `<name>_ok` carrying `value: v`", async () => {
    const { state, seen, reports } = await goOnce(async (_cmd, { ok }) =>
      ok({ body: "via ok" }),
    );
    expect(seen).toEqual(["go", "fetch_ok"]);
    expect(state.body).toBe("via ok");
    expect(state.ats).toEqual([5]);
    expect(reports).toEqual([]);
  });

  it("a declared `err({ _tag })` dispatches `<name>_err`, tag intact", async () => {
    const { state, seen, reports } = await goOnce(async (_cmd, { err }) =>
      err({ _tag: "not_found" }),
    );
    expect(seen).toEqual(["go", "fetch_err"]);
    expect(state.lastError).toEqual({ _tag: "not_found" });
    expect(state.ats).toEqual([5]);
    expect(reports).toEqual([]);
  });

  it("the handler reads the plain ctx handed to `run` beside the helpers", async () => {
    const { state } = await goOnce(async (cmd, { http, ok }) =>
      ok({ body: String(await http.get(cmd.url)) }),
    );
    expect(state.body).toBe("body of /a");
  });

  it("a thrown error reaches `onError` and dispatches no `_err` Msg", async () => {
    const boom = new Error("boom");
    const { state, seen, reports } = await goOnce(async () => {
      throw boom;
    });
    expect(seen).toEqual(["go"]);
    expect(state.errors).toEqual([]);
    expect(reports).toEqual([{ error: boom, context: { phase: "interpret" } }]);
  });

  it("an undeclared tag reaches `onError` and dispatches no `_err` Msg", async () => {
    const { state, seen, reports } = await goOnce(async () =>
      Outcome.err({ _tag: "teapot" }),
    );
    expect(seen).toEqual(["go"]);
    expect(state.errors).toEqual([]);
    expect(reports).toHaveLength(1);
    const [report] = reports;
    expect(report?.context).toEqual({ phase: "interpret" });
    expect(report?.error).toBeInstanceOf(UndeclaredFailureError);
    expect(report?.error).toMatchObject({
      cmdType: "fetch",
      failure: { _tag: "teapot" },
      declared: ["not_found", "timeout"],
    });
  });

  it("an `Err` with no `_tag` is undeclared too", async () => {
    const { seen, reports } = await goOnce(async () =>
      Outcome.err("not a tagged record"),
    );
    expect(seen).toEqual(["go"]);
    expect(reports[0]?.error).toBeInstanceOf(UndeclaredFailureError);
  });

  it("a handler returning its own `_ok` Msg is refused — the engine mints that", async () => {
    const { seen, reports } = await goOnce(async (cmd) =>
      fetch.ok(cmd, { body: "self-minted" }),
    );
    expect(seen).toEqual(["go"]);
    expect(reports[0]?.error).toBeInstanceOf(OutcomeContractError);
    expect(reports[0]?.context).toEqual({ phase: "interpret" });
  });

  it("a handler returning any other Msg is refused too — no pass-through", async () => {
    let calls = 0;
    const { state, seen, reports } = await goOnce(async () => {
      calls += 1;
      // Once only, so a regression that passes it through cannot loop.
      return calls === 1 ? { type: "go", url: "/follow-up" } : undefined;
    });
    expect(seen).toEqual(["go"]);
    expect(state.errors).toEqual([]);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.error).toBeInstanceOf(OutcomeContractError);
    expect(reports[0]?.error).toMatchObject({ cmdType: "fetch" });
    expect(reports[0]?.context).toEqual({ phase: "interpret" });
  });

  it("returning nothing dispatches nothing", async () => {
    const { seen, reports } = await goOnce(async () => undefined);
    expect(seen).toEqual(["go"]);
    expect(reports).toEqual([]);
  });

  it("a failure is contained: the next Cmd of the transition still runs", async () => {
    const reports: unknown[] = [];
    const m = defineMachine({
      types: { model: {} as Model, msg: {} as Msg, ctx: {} as HttpCtx },
      cmds: [fetch],
      init: (_loaded) => [initial, []],
      update: {
        ...update,
        go: (m, msg) => [m, [fetch({ url: "/boom" }), fetch({ url: msg.url })]],
      },
    });
    const rt = await run(m, {
      interpret: {
        fetch: async (cmd, { ok }) => {
          if (cmd.url === "/boom") throw new Error("boom");
          return ok({ body: cmd.url });
        },
      },
      ctx: { http: { get: async () => "unused" } },
      onError: (error) => {
        reports.push(error);
      },
    }).ready;
    await rt.dispatch({ type: "go", url: "/after" });
    expect(rt.getState().body).toBe("/after");
    expect(reports).toHaveLength(1);
  });
});

describe("`Cmd.define` takes any Standard Schema", () => {
  it("a hand-written Standard Schema parses the `Ok` value", async () => {
    const upper: StandardSchemaV1<unknown, { readonly shout: string }> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value) =>
          typeof value === "string"
            ? { value: { shout: value.toUpperCase() } }
            : { issues: [{ message: "not a string", path: [{ key: "raw" }] }] },
      },
    };
    const shout = Cmd.define("shout", {
      input: z.object({ text: z.string() }),
      ok: upper,
      err: [],
    });
    type S = { readonly got: string | null; readonly issue: string | null };
    const m = defineMachine({
      types: { model: {} as S, msg: {} as { type: "say"; text: unknown } },
      cmds: [shout],
      init: () => [{ got: null, issue: null }, []],
      update: {
        say: (s, msg) => [s, [shout({ text: String(msg.text) })]],
        shout_ok: (s, msg) => [{ ...s, got: msg.value.shout }, []],
        shout_err: (s, msg) => [
          {
            ...s,
            issue:
              msg.error._tag === "malformed_result"
                ? (msg.error.issues[0]?.path ?? null)
                : null,
          },
          [],
        ],
      },
    });
    const rt = await run(m, {
      interpret: {
        // `ok` is typed to what the schema outputs; the raw input goes in
        // unchecked on purpose so the schema is what transforms it.
        shout: async (cmd, { ok }) =>
          ok((cmd.text === "42" ? 42 : cmd.text) as never),
      },
    }).ready;
    await rt.dispatch({ type: "say", text: "hi" });
    expect(rt.getState().got).toBe("HI");
    await rt.dispatch({ type: "say", text: "42" });
    expect(rt.getState().issue).toBe("raw");
  });

  it("an `ok` schema that validates asynchronously reaches `onError` as a contract breach", async () => {
    const later = Cmd.define("later", {
      input: z.object({}),
      ok: z.string().refine(async () => true),
      err: [],
    });
    const reports: unknown[] = [];
    const m = defineMachine({
      types: { model: {} as { n: number }, msg: {} as { type: "go" } },
      cmds: [later],
      init: () => [{ n: 0 }, []],
      update: {
        go: (s) => [s, [later({})]],
        later_ok: (s) => [{ n: s.n + 1 }, []],
        later_err: (s) => [{ n: s.n - 1 }, []],
      },
    });
    const rt = await run(m, {
      interpret: { later: async (_cmd, { ok }) => ok("x") },
      onError: (error) => {
        reports.push(error);
      },
    }).ready;
    await rt.dispatch({ type: "go" });
    expect(rt.getState().n).toBe(0);
    expect(reports[0]).toBeInstanceOf(AsyncSchemaError);
  });
});

describe("a machine of hand-written Cmds is untouched", () => {
  it("runs with no `cmds`, no parse, no stamp", async () => {
    type S = { readonly n: number };
    type M = { readonly type: "bump" } | { readonly type: "bumped" };
    type C = { readonly type: "later" };
    const m = defineMachine({
      types: { model: {} as S, msg: {} as M, cmd: {} as C, ctx: {} as NoCtx },
      init: (_loaded) => [{ n: 0 }, []],
      update: {
        bump: (s) => [s, [{ type: "later" }]],
        bumped: (s) => [{ n: s.n + 1 }, []],
      },
    });
    const seen: M[] = [];
    const rt = await run(m, {
      interpret: { later: async (_cmd) => ({ type: "bumped" }) },
    }).ready;
    rt.observe((msg) => {
      seen.push(msg);
    });
    await rt.dispatch({ type: "bump" });
    expect(rt.getState().n).toBe(1);
    // No `at` was grafted onto a Msg the kernel does not own.
    expect(seen[1]).toEqual({ type: "bumped" });
  });
});

describe("a handler's own `dispatch` (ADR 0021, #298)", () => {
  type Progress = { readonly type: "progress"; readonly note: string };
  type Kick = { readonly type: "kick" };
  type PokeOk = { readonly type: "poke_ok" };
  type PokeCmd = { readonly type: "poke" };
  type DMsg = Msg | Kick | Progress | PokeOk;

  // A hand-written `cmd` beside `cmds` takes the `types`-only overload, which
  // derives no settled half, so `FetchSettled` is named in `msg` by hand.
  const dispatchMachine = defineMachine({
    types: {
      model: {} as Model,
      msg: {} as DMsg | FetchSettled,
      cmd: {} as FetchCmd | PokeCmd,
      ctx: {} as HttpCtx,
    },
    cmds: [fetch],
    init: (_loaded) => [initial, []],
    update: {
      ...update,
      kick: (m) => [m, [{ type: "poke" }]],
      progress: (m) => [m, []],
      poke_ok: (m) => [m, []],
    },
  });

  type Handlers = Interpret<DMsg | FetchSettled, FetchCmd | PokeCmd, HttpCtx>;

  /** Dispatch `msg` through `handlers`, wait for quiet, report what folded. */
  async function send(handlers: Handlers, msg: DMsg) {
    const reports: { error: unknown; context: RuntimeErrorContext }[] = [];
    const rt = await run(dispatchMachine, {
      interpret: handlers,
      ctx: { http: { get: async (url) => `body of ${url}` } },
      clock: fixedClock(5),
      onError: (error, context) => {
        reports.push({ error, context });
      },
    }).ready;
    const seen: string[] = [];
    rt.observe((m) => {
      seen.push(m.type);
    });
    await rt.dispatch(msg);
    await rt.idle();
    return { state: rt.getState(), seen, reports };
  }

  const noPoke: Handlers["poke"] = async () => undefined;

  it.each([
    ["fetch_ok", (cmd: FetchCmd) => fetch.ok(cmd, { body: "self-minted" })],
    ["fetch_err", (cmd: FetchCmd) => fetch.err(cmd, { _tag: "timeout" })],
  ] as const)("a defined handler dispatching its own `%s` is refused", async (own, mintOwn) => {
    const { state, seen, reports } = await send(
      {
        fetch: async (cmd, _ctx, dispatch) => {
          dispatch?.(mintOwn(cmd));
        },
        poke: noPoke,
      },
      { type: "go", url: "/a" },
    );
    expect(seen).toEqual(["go"]);
    expect(state).toEqual(initial);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.error).toBeInstanceOf(OutcomeContractError);
    expect(reports[0]?.error).toMatchObject({ cmdType: "fetch" });
    expect((reports[0]?.error as Error).message).toContain(
      `dispatched its own "${own}" Msg`,
    );
    expect(reports[0]?.context).toEqual({ phase: "interpret" });
  });

  it("a detached handler may dispatch the `_ok` the engine's edge minted (ADR 0018 fan-out)", async () => {
    const { state, seen, reports } = await send(
      {
        fetch: async (cmd, ctx, dispatch) => {
          dispatch?.(
            cmdEdgeOf(ctx)(cmd, ctx.ok({ body: "via edge" })) as FetchSettled,
          );
        },
        poke: noPoke,
      },
      { type: "go", url: "/a" },
    );
    expect(seen).toEqual(["go", "fetch_ok"]);
    expect(state.body).toBe("via edge");
    expect(state.ats).toEqual([5]);
    expect(reports).toEqual([]);
  });

  it("a defined handler's other Msgs are delivered as before", async () => {
    const { state, seen, reports } = await send(
      {
        fetch: async (_cmd, { ok }, dispatch) => {
          dispatch?.({ type: "progress", note: "half way" });
          return ok({ body: "done" });
        },
        poke: noPoke,
      },
      { type: "go", url: "/a" },
    );
    expect(seen).toEqual(["go", "progress", "fetch_ok"]);
    expect(state.body).toBe("done");
    expect(reports).toEqual([]);
  });

  it("a hand-written Cmd's handler may dispatch any Msg, `_ok`-named or not", async () => {
    const { seen, reports } = await send(
      {
        fetch: async (_cmd, { ok }) => ok({ body: "unused" }),
        poke: async (_cmd, _ctx, dispatch) => {
          dispatch?.({ type: "poke_ok" });
          dispatch?.({ type: "progress", note: "poked" });
        },
      },
      { type: "kick" },
    );
    expect(seen).toEqual(["kick", "poke_ok", "progress"]);
    expect(reports).toEqual([]);
  });
});
