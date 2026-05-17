import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  type Cmd,
  defineMachine,
  type Machine,
  replay,
  type Sub,
  tryInterpret,
} from "../src/index";

/**
 * Task 3: `replay()` + `tryInterpret()` — pure helpers exported from @b8e/tea.
 *
 * Each test maps to a single AC line from
 *   projects/binclusive/features/elm-package/tasks.md (task 3).
 */

// ---------- replay() ----------

describe("replay()", () => {
  it("returns { state, cmds, subs }: state is reducer applied in order; cmds is init++each update; subs is subscriptions(final) when defined", () => {
    type S = { n: number; tag: string };
    type M = { type: "inc" } | { type: "tag"; value: string };
    type C = { type: "log_inc" } | { type: "log_tag"; with: string };
    type U = Sub<"timer">;
    type Ctx = { initialTag: string };

    const machine: Machine<S, M, C, U, Ctx> = {
      init: (loaded, ctx) => [loaded ?? { n: 0, tag: ctx.initialTag }, [{ type: "log_inc" }]],
      update: (state, msg) => {
        if (msg.type === "inc") return [{ ...state, n: state.n + 1 }, [{ type: "log_inc" }]];
        return [{ ...state, tag: msg.value }, [{ type: "log_tag", with: msg.value }]];
      },
      interpret: {
        log_inc: async () => undefined,
        log_tag: async () => undefined,
      },
      subscriptions: (state) => (state.n > 0 ? [{ id: "t-1", type: "timer" }] : []),
      subscribe: {
        timer: () => () => {},
      },
    };

    const msgs: readonly M[] = [{ type: "inc" }, { type: "inc" }, { type: "tag", value: "x" }];
    const out = replay(machine, { msgs, ctx: { initialTag: "start" } });

    // state: init then inc, inc, tag "x"
    expect(out.state).toEqual({ n: 2, tag: "x" });

    // cmds: init's log_inc, then per-msg cmds in order: log_inc, log_inc, log_tag "x"
    expect(out.cmds).toEqual([
      { type: "log_inc" },
      { type: "log_inc" },
      { type: "log_inc" },
      { type: "log_tag", with: "x" },
    ]);

    // subs: subscriptions(final) — n=2 so timer is desired
    expect(out.subs).toEqual([{ id: "t-1", type: "timer" }]);
  });

  it("`subs` is [] when machine.subscriptions is not defined", () => {
    type S = { n: number };
    type M = { type: "inc" };
    type C = Cmd<never>;
    type U = Sub<never>;

    const machine: Machine<S, M, C, U, undefined> = {
      init: () => [{ n: 0 }, []],
      update: (state, _msg) => [{ n: state.n + 1 }, []],
      interpret: {} as Record<never, never>,
    };

    const msgs: readonly M[] = [{ type: "inc" }];
    const out = replay(machine, { msgs, ctx: undefined });

    expect(out.state).toEqual({ n: 1 });
    expect(out.cmds).toEqual([]);
    expect(out.subs).toEqual([]);
  });

  it("`loaded: undefined` calls init(null, ctx); `loaded: state` calls init(state, ctx)", () => {
    type S = { n: number; from: "fresh" | "loaded" };
    type M = { type: "inc" };
    type C = Cmd<never>;
    type U = Sub<never>;
    type Ctx = { tag: "ctx" };

    const initSpy = vi.fn((loaded: S | null, _ctx: Ctx): readonly [S, readonly C[]] => {
      if (loaded === null) return [{ n: 0, from: "fresh" }, []];
      return [{ n: loaded.n + 100, from: "loaded" }, []];
    });

    const machine: Machine<S, M, C, U, Ctx> = {
      init: initSpy,
      update: (state, _msg) => [{ ...state, n: state.n + 1 }, []],
      interpret: {} as Record<never, never>,
    };

    // loaded: undefined → init(null, ctx)
    const out1 = replay(machine, { msgs: [], ctx: { tag: "ctx" }, loaded: undefined });
    expect(initSpy).toHaveBeenCalledWith(null, { tag: "ctx" });
    expect(out1.state).toEqual({ n: 0, from: "fresh" });

    initSpy.mockClear();

    // loaded: someState → init(someState, ctx)
    const seed: S = { n: 7, from: "loaded" };
    const out2 = replay(machine, { msgs: [], ctx: { tag: "ctx" }, loaded: seed });
    expect(initSpy).toHaveBeenCalledWith(seed, { tag: "ctx" });
    expect(out2.state).toEqual({ n: 107, from: "loaded" });
  });

  it("does NOT invoke any `interpret` handler (spy-verified on a machine whose interpret throws)", () => {
    type S = { n: number };
    type M = { type: "fire" };
    type C = { type: "boom" } | { type: "boom2" };
    type U = Sub<never>;

    const boom = vi.fn(async (): Promise<M | void> => {
      throw new Error("interpret was called — replay violated the contract");
    });
    const boom2 = vi.fn(async (): Promise<M | void> => {
      throw new Error("interpret.boom2 was called — replay violated the contract");
    });

    const machine: Machine<S, M, C, U, undefined> = {
      init: () => [{ n: 0 }, [{ type: "boom" }]],
      update: (state, _msg) => [{ n: state.n + 1 }, [{ type: "boom" }, { type: "boom2" }]],
      interpret: {
        boom,
        boom2,
      },
    };

    const msgs: readonly M[] = [{ type: "fire" }, { type: "fire" }];
    // Should not throw — replay never executes interpret.
    const out = replay(machine, { msgs, ctx: undefined });

    expect(boom).toHaveBeenCalledTimes(0);
    expect(boom2).toHaveBeenCalledTimes(0);
    expect(out.state).toEqual({ n: 2 });
    // cmds collected, not executed: init's boom + per-msg (boom + boom2) × 2
    expect(out.cmds).toEqual([
      { type: "boom" },
      { type: "boom" },
      { type: "boom2" },
      { type: "boom" },
      { type: "boom2" },
    ]);
  });

  // Sanity check: defineMachine + replay round-trip on a typed-narrowing machine.
  it("works through defineMachine() (identity) with narrowed cmd/sub types", () => {
    type M = { type: "inc" };
    const machine = defineMachine<{ n: number }, M, Cmd<never>, Sub<never>, undefined>({
      init: () => [{ n: 0 }, []],
      update: (state, _msg) => [{ n: state.n + 1 }, []],
      interpret: {} as Record<never, never>,
    });

    const msgs: readonly M[] = [{ type: "inc" }, { type: "inc" }];
    const out = replay(machine, { msgs, ctx: undefined });
    expect(out.state.n).toBe(2);
  });
});

// ---------- tryInterpret() ----------

describe("tryInterpret()", () => {
  type FetchCmd = { type: "fetch"; url: string };
  type OkMsg = { type: "fetched"; url: string; body: string };
  type ErrMsg = { type: "fetch_failed"; url: string; reason: string };
  type Msg = OkMsg | ErrMsg;
  type Ctx = { token: string };

  it("returns a function with signature (cmd, ctx) => Promise<M>", () => {
    const handler = tryInterpret<FetchCmd, string, Msg, Ctx>(
      async (cmd, _ctx) => `body:${cmd.url}`,
      (body, cmd): OkMsg => ({ type: "fetched", url: cmd.url, body }),
      (err, cmd): ErrMsg => ({
        type: "fetch_failed",
        url: cmd.url,
        reason: err instanceof Error ? err.message : String(err),
      }),
    );

    expect(typeof handler).toBe("function");
    // The handler must be (cmd, ctx) — invoke it and verify the result is a Promise.
    const promise = handler({ type: "fetch", url: "/x" }, { token: "t" });
    expect(promise).toBeInstanceOf(Promise);
  });

  it("on work resolving: resolves with onOk(value, cmd)", async () => {
    const handler = tryInterpret<FetchCmd, string, Msg, Ctx>(
      async (cmd, _ctx) => `body:${cmd.url}`,
      (body, cmd): OkMsg => ({ type: "fetched", url: cmd.url, body }),
      (err, cmd): ErrMsg => ({
        type: "fetch_failed",
        url: cmd.url,
        reason: err instanceof Error ? err.message : String(err),
      }),
    );

    const out = await handler({ type: "fetch", url: "/users" }, { token: "t" });
    expect(out).toEqual({ type: "fetched", url: "/users", body: "body:/users" });
  });

  it("on work rejecting: resolves with onErr(error, cmd) — never rejects", async () => {
    const handler = tryInterpret<FetchCmd, string, Msg, Ctx>(
      async (_cmd, _ctx) => {
        throw new Error("offline");
      },
      (body, cmd): OkMsg => ({ type: "fetched", url: cmd.url, body }),
      (err, cmd): ErrMsg => ({
        type: "fetch_failed",
        url: cmd.url,
        reason: err instanceof Error ? err.message : String(err),
      }),
    );

    // Resolves (not rejects).
    const out = await handler({ type: "fetch", url: "/users" }, { token: "t" });
    expect(out).toEqual({ type: "fetch_failed", url: "/users", reason: "offline" });
  });

  it("the original error reaches onErr untouched (e.g. instanceof checks work)", async () => {
    class MyError extends Error {
      constructor(public code: number) {
        super(`code=${code}`);
        this.name = "MyError";
      }
    }

    const handler = tryInterpret<FetchCmd, string, Msg, Ctx>(
      async () => {
        throw new MyError(429);
      },
      (body, cmd): OkMsg => ({ type: "fetched", url: cmd.url, body }),
      (err, cmd): ErrMsg => {
        if (err instanceof MyError) {
          return { type: "fetch_failed", url: cmd.url, reason: `instance:${err.code}` };
        }
        return { type: "fetch_failed", url: cmd.url, reason: "unknown" };
      },
    );

    const out = await handler({ type: "fetch", url: "/x" }, { token: "t" });
    // If better-result wrapped the error, the instanceof check would fail and
    // the reason would be "unknown". Asserting "instance:429" confirms the
    // {try, catch: (e) => e} pass-through form is used internally.
    expect(out).toEqual({ type: "fetch_failed", url: "/x", reason: "instance:429" });
  });

  it("uses `better-result`'s Result.tryPromise() internally (import-check)", () => {
    // The AC explicitly allows verification by checking the import. Read the
    // source file and assert it imports `Result` from `better-result`.
    const srcPath = resolve(__dirname, "../src/index.ts");
    const src = readFileSync(srcPath, "utf8");
    expect(src).toMatch(/import\s*\{\s*Result\s*\}\s*from\s*"better-result"/);
    expect(src).toMatch(/Result\.tryPromise\(/);
  });
});
