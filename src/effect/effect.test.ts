import {
  Context,
  Data,
  Effect,
  Fiber,
  Layer,
  ManagedRuntime,
  Stream,
} from "effect";
import { describe, expect, it } from "vitest";
import {
  defineMachine,
  type Interpret,
  type Reducer,
  run,
  type Cmd as TeaCmd,
} from "../index";
import {
  make,
  runToTerminal,
  type TeaDefect,
  TeaDispatchError,
  teaServices,
  toInterpret,
} from "./index";

// ───────────────────────────────────────────────────────────────────────────
// @demlik/tea/effect — the two-way bridge. Direction 1 lowers Effect-authored
// interpret cells into tea's `Interpret`; direction 2 hosts a running tea
// runtime as a scoped Effect resource.
// ───────────────────────────────────────────────────────────────────────────

// ── A fetch-user machine ────────────────────────────────────────────────────

type State = {
  readonly phase: "idle" | "loading" | "loaded" | "failed" | "exploded";
  readonly name: string | null;
  readonly reason: string | null;
};

type Msg =
  | { readonly type: "load"; readonly id: string }
  | { readonly type: "loaded"; readonly name: string }
  | { readonly type: "failed"; readonly reason: string }
  | { readonly type: "exploded"; readonly reason: string };

type Cmd = { readonly type: "fetchUser"; readonly id: string };

type Ctx = { readonly tag: string };

class UserNotFound extends Data.TaggedError("UserNotFound")<{
  readonly id: string;
}> {}

class Users extends Context.Service<
  Users,
  { readonly find: (id: string) => Effect.Effect<string, UserNotFound> }
>()("test/Users") {}

const UsersLive = Layer.effect(Users)(
  Effect.sync(() => ({
    find: (id: string) =>
      id === "u1"
        ? Effect.succeed("Ada")
        : Effect.fail(new UserNotFound({ id })),
  })),
);

const update: Reducer<State, Msg, Cmd> = {
  load: (_s, m) => [
    { phase: "loading", name: null, reason: null },
    [{ type: "fetchUser", id: m.id }],
  ],
  loaded: (_s, m) => [{ phase: "loaded", name: m.name, reason: null }, []],
  failed: (_s, m) => [{ phase: "failed", name: null, reason: m.reason }, []],
  exploded: (_s, m) => [
    { phase: "exploded", name: null, reason: m.reason },
    [],
  ],
};

const services = teaServices<Msg, Ctx>();
const { TeaCtx, TeaDispatch } = services;

function fetchUserMachine(interpret: Interpret<Msg, Cmd, Ctx>) {
  return defineMachine<State, Msg, Cmd, never, Ctx>({
    init: () => [{ phase: "idle", name: null, reason: null }, []],
    update,
    interpret,
  });
}

// ── Direction 1: Effect → tea ───────────────────────────────────────────────

describe("toInterpret — Effect-authored interpret cells (direction 1)", () => {
  it("threads a Layer-provided service and applies the follow-up Msg", async () => {
    const runtime = ManagedRuntime.make(UsersLive);
    const interpret = toInterpret<Msg, Cmd, Ctx, Users>(
      {
        fetchUser: (cmd) =>
          Effect.gen(function* () {
            const users = yield* Users;
            const ctx = yield* TeaCtx;
            expect(ctx.tag).toBe("test-ctx");
            const name = yield* users.find(cmd.id);
            return { type: "loaded", name } as const;
          }).pipe(
            Effect.catchTag("UserNotFound", (e) =>
              Effect.succeed({ type: "failed", reason: e.id } as const),
            ),
          ),
      },
      { runtime, services },
    );

    const rt = await run(fetchUserMachine(interpret), {
      ctx: { tag: "test-ctx" },
    }).ready;

    await rt.dispatch({ type: "load", id: "u1" });
    expect(rt.getState()).toEqual({
      phase: "loaded",
      name: "Ada",
      reason: null,
    });

    await rt.stop();
    await runtime.dispose();
  });

  it("folds a typed failure into a Msg the reducer sees", async () => {
    const runtime = ManagedRuntime.make(UsersLive);
    const interpret = toInterpret<Msg, Cmd, Ctx, Users>(
      {
        fetchUser: (cmd) =>
          Effect.gen(function* () {
            const users = yield* Users;
            const name = yield* users.find(cmd.id);
            return { type: "loaded", name } as const;
          }).pipe(
            Effect.catchTag("UserNotFound", (e) =>
              Effect.succeed({
                type: "failed",
                reason: `no user ${e.id}`,
              } as const),
            ),
          ),
      },
      { runtime, services },
    );

    const rt = await run(fetchUserMachine(interpret), {
      ctx: { tag: "test-ctx" },
    }).ready;

    await rt.dispatch({ type: "load", id: "nope" });
    expect(rt.getState().phase).toBe("failed");
    expect(rt.getState().reason).toBe("no user nope");

    await rt.stop();
    await runtime.dispose();
  });

  it("rejects the dispatch on a defect when no onDefect is wired", async () => {
    const runtime = ManagedRuntime.make(Layer.empty);
    const interpret = toInterpret<Msg, Cmd, Ctx>(
      { fetchUser: () => Effect.die(new Error("boom")) },
      { runtime, services },
    );

    const rt = await run(fetchUserMachine(interpret), {
      ctx: { tag: "test-ctx" },
      onError: () => {},
    }).ready;

    await expect(rt.dispatch({ type: "load", id: "u1" })).rejects.toThrow(
      /boom/,
    );

    await rt.stop();
    await runtime.dispose();
  });

  it("folds a defect into a Msg when onDefect IS wired", async () => {
    const runtime = ManagedRuntime.make(Layer.empty);
    const interpret = toInterpret<Msg, Cmd, Ctx>(
      { fetchUser: () => Effect.die(new Error("boom")) },
      {
        runtime,
        services,
        onDefect: (defect) => ({
          type: "exploded" as const,
          reason: String(defect),
        }),
      },
    );

    const rt = await run(fetchUserMachine(interpret), {
      ctx: { tag: "test-ctx" },
    }).ready;

    await rt.dispatch({ type: "load", id: "u1" });
    expect(rt.getState().phase).toBe("exploded");
    expect(rt.getState().reason).toContain("boom");

    await rt.stop();
    await runtime.dispose();
  });

  it("hands the kernel-injected dispatch through TeaDispatch", async () => {
    const runtime = ManagedRuntime.make(Layer.empty);
    const interpret = toInterpret<Msg, Cmd, Ctx>(
      {
        fetchUser: () =>
          Effect.gen(function* () {
            const { dispatch } = yield* TeaDispatch;
            expect(typeof dispatch).toBe("function");
            dispatch({ type: "loaded", name: "detached" });
          }),
      },
      { runtime, services },
    );

    const rt = await run(fetchUserMachine(interpret), {
      ctx: { tag: "test-ctx" },
    }).ready;

    await rt.dispatch({ type: "load", id: "u1" });
    await rt.idle();
    expect(rt.getState().name).toBe("detached");

    await rt.stop();
    await runtime.dispose();
  });
});

// ── Direction 2: tea → Effect ───────────────────────────────────────────────

type CountState = { readonly n: number; readonly done: boolean };
type CountMsg = { readonly type: "bump" } | { readonly type: "finish" };

const counter = defineMachine<CountState, CountMsg, never, never, undefined>({
  init: () => [{ n: 0, done: false }, []],
  update: {
    bump: (s) => [{ ...s, n: s.n + 1 }, []],
    finish: (s) => [{ ...s, done: true }, []],
  } satisfies Reducer<CountState, CountMsg, never>,
  interpret: {} as Interpret<CountMsg, never, undefined>,
});

describe("TeaMachine — tea as a scoped Effect resource (direction 2)", () => {
  it("boots, dispatches, reads state, and awaits the terminal State", async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const tea = yield* make(counter, {
          ctx: undefined,
          terminal: (s: CountState) => s.done,
        });
        yield* tea.dispatch({ type: "bump" });
        expect((yield* tea.state).n).toBe(1);
        yield* tea.dispatch({ type: "finish" });
        return yield* tea.done;
      }),
    );

    const terminal = await Effect.runPromise(program);
    expect(terminal).toEqual({ n: 1, done: true });
  });

  it("closes the scope by stopping the runtime (drain, never kill)", async () => {
    const program = Effect.gen(function* () {
      const tea = yield* make(counter, { ctx: undefined });
      yield* tea.dispatch({ type: "bump" });
      return tea.runtime;
    });

    const rt = await Effect.runPromise(Effect.scoped(program));
    // Scope closed → stop() has already run. A raw dispatch on the underlying
    // runtime is now refused.
    await expect(rt.dispatch({ type: "bump" })).rejects.toThrow();
    expect(rt.getState().n).toBe(1);
  });

  it("streams state snapshots, current value first", async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const tea = yield* make(counter, { ctx: undefined });
        const collected = yield* Effect.forkChild(
          Stream.runCollect(Stream.take(tea.changes, 3)),
        );
        yield* Effect.sleep("10 millis");
        yield* tea.dispatch({ type: "bump" });
        yield* tea.dispatch({ type: "bump" });
        return yield* Fiber.join(collected);
      }),
    );

    const snapshots = await Effect.runPromise(program);
    expect(Array.from(snapshots).map((s) => s.n)).toEqual([0, 1, 2]);
  });

  it("routes an onError report to the defects stream", async () => {
    const boom = new Error("listener blew up");
    const program = Effect.scoped(
      Effect.gen(function* () {
        const tea = yield* make(counter, { ctx: undefined });
        const collected = yield* Effect.forkChild(
          Stream.runCollect(Stream.take(tea.defects, 1)),
        );
        yield* Effect.sleep("10 millis");
        // A throwing listener is reported to onError under phase "listener".
        tea.runtime.subscribe(() => {
          throw boom;
        });
        yield* tea.dispatch({ type: "bump" });
        return yield* Fiber.join(collected);
      }),
    );

    const defects = await Effect.runPromise(program);
    const first = Array.from(defects)[0] as TeaDefect;
    expect(first.phase).toBe("listener");
    expect(first.error).toBe(boom);
    expect(first.notice).toBe(false);
  });

  it("surfaces a reducer throw as TeaDispatchError", async () => {
    const exploding = defineMachine<
      CountState,
      CountMsg,
      never,
      never,
      undefined
    >({
      init: () => [{ n: 0, done: false }, []],
      update: {
        bump: () => {
          throw new Error("reducer blew up");
        },
        finish: (s) => [{ ...s, done: true }, []],
      } satisfies Reducer<CountState, CountMsg, never>,
      interpret: {} as Interpret<CountMsg, never, undefined>,
    });

    const program = Effect.scoped(
      Effect.gen(function* () {
        const tea = yield* make(exploding, { ctx: undefined });
        return yield* Effect.flip(tea.dispatch({ type: "bump" }));
      }),
    );

    const err = await Effect.runPromise(program);
    expect(err).toBeInstanceOf(TeaDispatchError);
    expect(err.msgType).toBe("bump");
  });

  it("runToTerminal boots, seeds, and returns the terminal State", async () => {
    const terminal = await Effect.runPromise(
      runToTerminal(counter, [{ type: "bump" }, { type: "finish" }], {
        ctx: undefined,
        terminal: (s: CountState) => s.done,
      }),
    );
    expect(terminal).toEqual({ n: 1, done: true });
  });
});

// ── Full circle ─────────────────────────────────────────────────────────────

describe("full circle — a TeaMachine hosting an Effect-authored interpret", () => {
  it("runs Effect handlers inside a tea machine hosted by Effect", async () => {
    const runtime = ManagedRuntime.make(UsersLive);
    const interpret = toInterpret<Msg, Cmd, Ctx, Users>(
      {
        fetchUser: (cmd) =>
          Effect.gen(function* () {
            const users = yield* Users;
            const name = yield* users.find(cmd.id);
            return { type: "loaded", name } as const;
          }).pipe(
            Effect.catchTag("UserNotFound", (e) =>
              Effect.succeed({ type: "failed", reason: e.id } as const),
            ),
          ),
      },
      { runtime, services },
    );

    const program = Effect.scoped(
      Effect.gen(function* () {
        const tea = yield* make(fetchUserMachine(interpret), {
          ctx: { tag: "test-ctx" },
          terminal: (s: State) => s.phase === "loaded" || s.phase === "failed",
        });
        yield* tea.dispatch({ type: "load", id: "u1" });
        return yield* tea.done;
      }),
    );

    const terminal = await Effect.runPromise(program);
    expect(terminal).toEqual({ phase: "loaded", name: "Ada", reason: null });

    await runtime.dispose();
  });
});

// Keeps the imported Cmd alias load-bearing: our Cmd union must satisfy tea's.
type _CmdIsTeaCmd = Cmd extends TeaCmd ? true : never;
const _cmdIsTeaCmd: _CmdIsTeaCmd = true;
void _cmdIsTeaCmd;
