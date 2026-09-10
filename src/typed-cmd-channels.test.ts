/**
 * Typed effect channels on Cmd constructors — the RUNTIME half (ADR 0014, #44).
 * The compile-time half (an `_err` cell must cover every `_tag`; `run` refuses
 * a ctx missing a Cmd's `R`) lives in `__tests__/typed-cmd-channels.test-d.ts`.
 *
 * What the runtime owes:
 *   - the emitted Cmd is still a plain `{ type, ...input }` record (JSON
 *     round-trip equal) — the channels are phantoms;
 *   - a handler's `_ok` value is parsed against the `ok` schema at the
 *     interpret edge: a value that fails becomes the minted `_err` carrying
 *     `malformed_result`, and Model never sees the corrupt value;
 *   - `fetch_ok` / `fetch_err` dispatch through a machine whose user-facing
 *     `Msg` never names them;
 *   - `at` is stamped from `run`'s clock on every settled Msg.
 */

import { Result } from "better-result";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  Cmd,
  defineMachine,
  type MalformedResult,
  type NoCtx,
  type Reducer,
  run,
  type Settled,
  settle,
} from "./index";

type Http = { readonly get: (url: string) => Promise<unknown> };
type HttpCtx = { readonly http: Http };

const fetch = Cmd.define("fetch", {
  input: z.object({ url: z.string() }),
  ok: z.object({ body: z.string() }),
  err: ["not_found", "timeout"],
  requires: Cmd.requires<HttpCtx>(),
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
 * One machine, parameterised on what the http "server" answers, so each test
 * picks the boundary case it is about. The handler forwards whatever `http`
 * returns as the `_ok` value — the interpret EDGE is what decides whether that
 * value is an `_ok` or a `malformed_result`.
 */
function machineOver(work: (cmd: FetchCmd, http: Http) => Promise<unknown>) {
  return defineMachine<Model, Msg, typeof fetch, never, NoCtx>({
    cmds: [fetch],
    init: () => [initial, []],
    update,
    interpret: {
      fetch: async (cmd, ctx) =>
        // Deliberately unparsed: `work` may answer with a shape the schema
        // rejects, and that reaching the reducer is the corruption under test.
        fetch.ok(cmd, (await work(cmd, ctx.http)) as { body: string }),
    },
  });
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
    const rt = await run(
      machineOver(async () => ({ body: "hello" })),
      {
        ctx: { http: { get: async () => "unused" } },
        clock: fixedClock(1_000),
      },
    ).ready;
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
      machineOver(async () => ({ body: 42 })),
      { ctx: { http: { get: async () => "unused" } }, clock: fixedClock(7) },
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
    const rt = await run(
      machineOver(async () => ({ body: "kept", extra: "dropped" })),
      { ctx: { http: { get: async () => "unused" } } },
    ).ready;
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
    const rt = await run(
      machineOver(async () => ({ body: "t" })),
      {
        ctx: { http: { get: async () => "unused" } },
      },
    ).ready;
    await rt.dispatch({ type: "go", url: "/" });
    const [at] = rt.getState().ats;
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
  });
});

describe("settle — the Result lives in the helper, the kernel sees a Msg", () => {
  function settledMachine(
    work: (
      cmd: FetchCmd,
    ) => Promise<
      Result<{ body: string }, { _tag: "not_found" } | { _tag: "timeout" }>
    >,
  ) {
    return defineMachine<Model, Msg, typeof fetch, never, NoCtx>({
      cmds: [fetch],
      init: () => [initial, []],
      update,
      interpret: { fetch: settle(fetch, (cmd) => work(cmd)) },
    });
  }

  it("maps `Ok` onto `<name>_ok`", async () => {
    const rt = await run(
      settledMachine(async () => Result.ok({ body: "via settle" })),
      { ctx: { http: { get: async () => "unused" } }, clock: fixedClock(3) },
    ).ready;
    await rt.dispatch({ type: "go", url: "/" });
    expect(rt.getState().body).toBe("via settle");
    expect(rt.getState().ats).toEqual([3]);
  });

  it("maps a declared `Err` onto `<name>_err`, tag intact", async () => {
    const rt = await run(
      settledMachine(async () => Result.err({ _tag: "not_found" as const })),
      { ctx: { http: { get: async () => "unused" } }, clock: fixedClock(4) },
    ).ready;
    await rt.dispatch({ type: "go", url: "/" });
    const state = rt.getState();
    expect(state.body).toBeNull();
    expect(state.lastError).toEqual({ _tag: "not_found" });
    expect(state.ats).toEqual([4]);
  });

  it("the handler's ctx carries the Cmd's `R` slice", async () => {
    const urls: string[] = [];
    const m = defineMachine<Model, Msg, typeof fetch, never, NoCtx>({
      cmds: [fetch],
      init: () => [initial, []],
      update,
      interpret: {
        fetch: settle(fetch, async (cmd, ctx) => {
          const body = await ctx.http.get(cmd.url);
          return Result.ok({ body: String(body) });
        }),
      },
    });
    const rt = await run(m, {
      ctx: {
        http: {
          get: async (url) => {
            urls.push(url);
            return `body of ${url}`;
          },
        },
      },
    }).ready;
    await rt.dispatch({ type: "go", url: "/a" });
    expect(urls).toEqual(["/a"]);
    expect(rt.getState().body).toBe("body of /a");
  });
});

describe("a machine of hand-written Cmds is untouched", () => {
  it("runs with no `cmds`, no parse, no stamp", async () => {
    type S = { readonly n: number };
    type M = { readonly type: "bump" } | { readonly type: "bumped" };
    type C = { readonly type: "later" };
    const m = defineMachine<S, M, C, never, NoCtx>({
      init: () => [{ n: 0 }, []],
      update: {
        bump: (s) => [s, [{ type: "later" }]],
        bumped: (s) => [{ n: s.n + 1 }, []],
      },
      interpret: { later: async () => ({ type: "bumped" }) },
    });
    const seen: M[] = [];
    const rt = await run(m, {}).ready;
    rt.observe((msg) => {
      seen.push(msg);
    });
    await rt.dispatch({ type: "bump" });
    expect(rt.getState().n).toBe(1);
    // No `at` was grafted onto a Msg the kernel does not own.
    expect(seen[1]).toEqual({ type: "bumped" });
  });
});
