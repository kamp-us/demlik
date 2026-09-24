/**
 * The Effect engine's own contract (#283): interruption on stop, services from
 * the caller's Layers, the error sink for defects and undeclared failures, the
 * built-in `timer` and its override, the fenced-store check, and the Effect
 * handle whose verbs fail with typed errors (#308).
 */

import {
  Cause,
  Context,
  Data,
  Effect,
  Exit,
  Layer,
  type Scope,
  Scope as ScopeModule,
  Stream,
} from "effect";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { z } from "zod";
import {
  type BootingRuntime,
  Cmd,
  defineMachine,
  NoCellError,
  type NoCtx,
  type Runtime,
  type RuntimeErrorContext,
  type Settled,
  type Store,
  StoreConflictError,
  type Sub,
  UndeclaredFailureError,
} from "../index";
import { type LiveWorkProbe, liveWork } from "../internal/engine/loop";
import { memoryStore } from "../mem";
import {
  type EffectBootingRuntime,
  type EffectRuntime,
  run,
  Stopped,
  StoreFailed,
} from "./index";

const liveSubs = (rt: object): number => (rt as LiveWorkProbe)[liveWork]().subs;

const load = Cmd.define("load", {
  input: z.object({ id: z.string() }),
  ok: z.object({ name: z.string() }),
  err: ["missing"],
});

type Msg = { readonly type: "go"; readonly id: string } | Settled<typeof load>;
type Model = { readonly names: readonly string[]; readonly errs: number };

const machine = defineMachine({
  types: { model: {} as Model, msg: {} as Msg },
  cmds: [load],
  init: (loaded) => [loaded ?? { names: [], errs: 0 }, []],
  update: {
    go: (m, msg) => [m, [load({ id: msg.id })]],
    load_ok: (m, msg) => [{ ...m, names: [...m.names, msg.value.name] }, []],
    load_err: (m) => [{ ...m, errs: m.errs + 1 }, []],
  },
});

function sink() {
  const reports: { error: unknown; phase: string }[] = [];
  const onError = (error: unknown, context: RuntimeErrorContext) => {
    reports.push({ error, phase: context.phase });
  };
  return { reports, onError };
}

/** Open a scope by hand, so a test can close it mid-run. */
async function openScope<A>(
  effect: Effect.Effect<A, never, Scope.Scope>,
): Promise<{ value: A; close: () => Promise<void> }> {
  const scope = await Effect.runPromise(ScopeModule.make());
  const value = await Effect.runPromise(
    ScopeModule.provide(scope)(effect) as Effect.Effect<A>,
  );
  return {
    value,
    close: () => Effect.runPromise(ScopeModule.close(scope, Exit.void)),
  };
}

describe("closing the scope interrupts in-flight work", () => {
  it("interrupts a slow handler, runs its finalizer, and dispatches nothing after stop", async () => {
    let started = false;
    let finalized = false;
    let interrupted = false;
    const { reports, onError } = sink();
    const { value: rt, close } = await openScope(
      run(machine, {
        onError,
        interpret: {
          load: (cmd) =>
            Effect.sync(() => {
              started = true;
            }).pipe(
              Effect.andThen(Effect.sleep("1 hour")),
              Effect.as({ name: cmd.id }),
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  interrupted = true;
                }),
              ),
              Effect.ensuring(
                Effect.sync(() => {
                  finalized = true;
                }),
              ),
            ),
        },
      }),
    );
    const booted = await Effect.runPromise(rt.ready);
    const seen: string[] = [];
    rt.observe((msg) => seen.push(msg.type));

    const pending = Effect.runPromise(
      booted.dispatch({ type: "go", id: "slow" }),
    );
    await vi.waitFor(() => expect(started).toBe(true));
    await close();

    expect(interrupted).toBe(true);
    expect(finalized).toBe(true);
    // The dispatch that started the handler settles; nothing came of it.
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toEqual(["go"]);
    expect(booted.getState()).toEqual({ names: [], errs: 0 });
    // The runtime is stopped: a new Msg fails with `Stopped`, never folded.
    const refused = await Effect.runPromise(
      Effect.flip(booted.dispatch({ type: "go", id: "late" })),
    );
    expect(refused).toBeInstanceOf(Stopped);
    expect(seen).toEqual(["go"]);
    expect(reports.map((r) => r.phase)).toEqual(["discard"]);
  });

  it("interrupts a running sub's stream on stop", async () => {
    type Tick = Sub<"ticks", { readonly on: true }>;
    let released = false;
    const ticking = defineMachine({
      types: {
        model: {} as { readonly n: number },
        msg: {} as { readonly type: "tick" },
        sub: {} as Tick,
      },
      init: () => [{ n: 0 }, []],
      update: { tick: (m) => [{ n: m.n + 1 }, []] },
      subs: [{ type: "ticks", deps: () => ({ on: true as const }) }],
    });
    const { value: rt, close } = await openScope(
      run(ticking, {
        subscribe: {
          ticks: () =>
            Stream.fromEffect(Effect.succeed({ type: "tick" as const })).pipe(
              Stream.concat(Stream.never),
              Stream.ensuring(
                Effect.sync(() => {
                  released = true;
                }),
              ),
            ),
        },
      }),
    );
    const booted = await Effect.runPromise(rt.ready);
    await vi.waitFor(() => expect(booted.getState()).toEqual({ n: 1 }));
    expect(liveSubs(booted)).toBe(1);
    await close();
    expect(released).toBe(true);
    expect(liveSubs(booted)).toBe(0);
  });
});

describe("services flow from the caller's Layers", () => {
  class Directory extends Context.Service<
    Directory,
    { readonly nameOf: (id: string) => Effect.Effect<string> }
  >()("Directory") {}

  class Pulse extends Context.Service<Pulse, { readonly beats: number }>()(
    "Pulse",
  ) {}

  type Beat = Sub<"beat", { readonly on: true }>;
  const beating = defineMachine({
    types: {
      model: {} as Model & { readonly beats: number },
      msg: {} as Msg | { readonly type: "beat" },
      sub: {} as Beat,
    },
    cmds: [load],
    init: () => [{ names: [], errs: 0, beats: 0 }, []],
    update: {
      go: (m, msg) => [m, [load({ id: msg.id })]],
      beat: (m) => [{ ...m, beats: m.beats + 1 }, []],
      load_ok: (m, msg) => [{ ...m, names: [...m.names, msg.value.name] }, []],
      load_err: (m) => [{ ...m, errs: m.errs + 1 }, []],
    },
    subs: [{ type: "beat", deps: () => ({ on: true as const }) }],
  });

  const program = run(beating, {
    interpret: {
      load: (cmd) =>
        Effect.gen(function* () {
          const directory = yield* Directory;
          return { name: yield* directory.nameOf(cmd.id) };
        }),
    },
    subscribe: {
      beat: () =>
        Stream.unwrap(
          Effect.gen(function* () {
            const pulse = yield* Pulse;
            return Stream.range(1, pulse.beats).pipe(
              Stream.map(() => ({ type: "beat" as const })),
            );
          }),
        ),
    },
  });

  it("types R end to end: the run needs exactly the services its handlers read", () => {
    type Model2 = Model & { readonly beats: number };
    expectTypeOf(program).toEqualTypeOf<
      Effect.Effect<
        EffectBootingRuntime<Model2, Msg | { readonly type: "beat" }>,
        never,
        Scope.Scope | Directory | Pulse
      >
    >();
    // Without the Layers the program does not type as runnable.
    // @ts-expect-error — `Directory | Pulse` are still required
    const _unprovided: Effect.Effect<unknown, never, never> =
      Effect.scoped(program);
  });

  it("a handler and a runner get the services a Layer provides", async () => {
    const layer = Layer.merge(
      Layer.succeed(Directory, {
        nameOf: (id) => Effect.succeed(`user ${id}`),
      }),
      Layer.succeed(Pulse, { beats: 2 }),
    );
    const state = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const rt = yield* program;
          const booted = yield* rt.ready;
          yield* booted.dispatch({ type: "go", id: "7" });
          yield* Effect.promise(() =>
            vi.waitFor(() => expect(booted.getState().beats).toBe(2)),
          );
          return booted.getState();
        }),
      ).pipe(Effect.provide(layer)),
    );
    expect(state).toEqual({ names: ["user 7"], errs: 0, beats: 2 });
  });
});

describe("a handler's Effect settles through Effect.result", () => {
  async function settleWith(
    cell: (cmd: {
      readonly id: string;
    }) => Effect.Effect<{ name: string }, { readonly _tag: "missing" }, never>,
  ) {
    const { reports, onError } = sink();
    const state = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const rt = yield* run(machine, {
            onError,
            interpret: { load: cell },
          });
          const booted = yield* rt.ready;
          yield* booted.dispatch({ type: "go", id: "x" });
          return booted.getState();
        }),
      ),
    );
    return { state, reports };
  }

  it("a success settles `_ok`", async () => {
    const { state } = await settleWith(() => Effect.succeed({ name: "Ada" }));
    expect(state).toEqual({ names: ["Ada"], errs: 0 });
  });

  it("a declared failure settles `_err`", async () => {
    const { state, reports } = await settleWith(() =>
      Effect.fail({ _tag: "missing" as const }),
    );
    expect(state).toEqual({ names: [], errs: 1 });
    expect(reports).toEqual([]);
  });

  it("a defect goes to the error sink, never `_err`", async () => {
    const boom = new Error("boom");
    const { state, reports } = await settleWith(() => Effect.die(boom));
    expect(state).toEqual({ names: [], errs: 0 });
    expect(reports).toEqual([{ error: boom, phase: "interpret" }]);
  });

  it("an undeclared failure goes to the error sink, never `_err`", async () => {
    const { state, reports } = await settleWith(
      () =>
        Effect.fail({ _tag: "gone" }) as unknown as Effect.Effect<
          { name: string },
          { readonly _tag: "missing" }
        >,
    );
    expect(state).toEqual({ names: [], errs: 0 });
    expect(reports[0]?.error).toBeInstanceOf(UndeclaredFailureError);
  });
});

describe("the built-in timer", () => {
  type Phase = { readonly rung: number };
  const alarm = defineMachine({
    types: { model: {} as Phase, msg: {} as { readonly type: "ring" } },
    init: () => [{ rung: 0 }, []],
    update: { ring: (m) => [{ rung: m.rung + 1 }, []] },
    subs: [
      {
        type: "timer",
        deps: (m) => (m.rung === 0 ? { ms: 5, msg: { type: "ring" } } : null),
      },
    ],
  });

  it("fires `msg` after `ms` through Effect.sleep", async () => {
    const state = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const rt = yield* run(alarm, { terminal: (s) => s.rung === 1 });
          return yield* (yield* rt.ready).done();
        }),
      ),
    );
    expect(state).toEqual({ rung: 1 });
  });

  it("a user `timer` runner overrides the built-in", async () => {
    const asked: number[] = [];
    const state = await Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(
          run(alarm, {
            terminal: (s) => s.rung === 1,
            subscribe: {
              timer: (sub) => {
                asked.push(sub.deps.ms);
                return Stream.succeed(sub.deps.msg);
              },
            },
          }),
          (rt) => Effect.flatMap(rt.ready, (booted) => booted.done()),
        ),
      ),
    );
    expect(state).toEqual({ rung: 1 });
    expect(asked).toEqual([5]);
  });
});

describe("a fenced store on the Effect engine", () => {
  it("refuses a second writer", async () => {
    const store = memoryStore<Model>(null, undefined, { fenced: true });
    // The loser's final save on stop is refused too; it reaches the sink.
    const { reports, onError } = sink();
    const bootOn = (id: string) =>
      Effect.flatMap(
        run(machine, {
          store,
          onError,
          interpret: {
            load: (cmd) => Effect.succeed({ name: `${id}:${cmd.id}` }),
          },
        }),
        (rt) => rt.ready,
      );
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const first = yield* bootOn("first");
          const second = yield* bootOn("second");
          // The second writer boots at the same version and saves first…
          yield* second.dispatch({ type: "go", id: "a" });
          // …so the first writer's next save is a stale compare-and-swap.
          return yield* Effect.flip(first.dispatch({ type: "go", id: "b" }));
        }),
      ),
    );
    expect(outcome).toBeInstanceOf(StoreFailed);
    expect(outcome).toMatchObject({ _tag: "StoreFailed", operation: "save" });
    expect((outcome as StoreFailed).cause).toBeInstanceOf(StoreConflictError);
    // The sink is handed the store's own throw, as on the Promise engine.
    expect(reports.map((r) => r.phase)).toEqual(["stop-save"]);
    expect(reports[0]?.error).toBeInstanceOf(StoreConflictError);
  });
});

describe("the handle's verbs are Effects with a typed error channel (#308)", () => {
  class Offline extends Data.TaggedError("Offline")<{
    readonly host: string;
  }> {}

  type Ping = { readonly type: "ping"; readonly host: string };
  type Relay = { readonly type: "relay"; readonly host: string };
  type PingMsg =
    | { readonly type: "check"; readonly host: string }
    | { readonly type: "forward"; readonly host: string }
    | { readonly type: "pong" };
  type PingModel = { readonly checks: number; readonly pongs: number };

  // `check` pings a host; `forward` relays a `check` as a follow-up Msg.
  const pinger = defineMachine({
    types: {
      model: {} as PingModel,
      msg: {} as PingMsg,
      cmd: {} as Ping | Relay,
      ctx: {} as NoCtx,
    },
    init: (loaded) => [loaded ?? { checks: 0, pongs: 0 }, []],
    update: {
      check: (m, msg) => [
        { ...m, checks: m.checks + 1 },
        [{ type: "ping", host: msg.host }],
      ],
      forward: (m, msg) => [m, [{ type: "relay", host: msg.host }]],
      pong: (m) => [{ ...m, pongs: m.pongs + 1 }, []],
    },
  });

  // `ping` is a hand-written cell whose declared failure is `Offline`.
  const pingOn = (
    opts: {
      readonly store?: Store<PingModel>;
      readonly onError?: (error: unknown, context: RuntimeErrorContext) => void;
    } = {},
  ) =>
    run(pinger, {
      ...opts,
      interpret: {
        ping: (cmd) =>
          cmd.host === "down"
            ? Effect.fail(new Offline({ host: cmd.host }))
            : Effect.succeed({ type: "pong" as const }),
        relay: (cmd) =>
          Effect.succeed({ type: "check" as const, host: cmd.host }),
      },
    });

  type Booted = Effect.Success<
    Effect.Success<ReturnType<typeof pingOn>>["ready"]
  >;

  it("types each verb's error channel: Stopped, StoreFailed and the cell's declared failure", () => {
    expectTypeOf<Booted["dispatch"]>().returns.toEqualTypeOf<
      Effect.Effect<void, Offline | Stopped | StoreFailed>
    >();
    expectTypeOf<Booted["dispatchOnce"]>().returns.toEqualTypeOf<
      Effect.Effect<void, Offline | Stopped | StoreFailed>
    >();
    expectTypeOf<Effect.Error<Booted["ready"]>>().toEqualTypeOf<
      Offline | StoreFailed
    >();
    expectTypeOf<Booted["idle"]>().returns.toEqualTypeOf<Effect.Effect<void>>();
    expectTypeOf<Booted["stop"]>().returns.toEqualTypeOf<Effect.Effect<void>>();
    expectTypeOf<Booted["done"]>().returns.toEqualTypeOf<
      Effect.Effect<PingModel>
    >();
  });

  it("a `Cmd.define`d cell's declared failure settles `_err`, so it adds nothing", () => {
    const defined = run(machine, {
      interpret: { load: () => Effect.fail({ _tag: "missing" as const }) },
    });
    type DefinedBooted = Effect.Success<
      Effect.Success<typeof defined>["ready"]
    >;
    expectTypeOf<DefinedBooted["dispatch"]>().returns.toEqualTypeOf<
      Effect.Effect<void, Stopped | StoreFailed>
    >();
  });

  it("names every member as the Promise handle does; only the return types differ", () => {
    expectTypeOf<
      keyof EffectBootingRuntime<PingModel, PingMsg>
    >().toEqualTypeOf<keyof BootingRuntime<PingModel, PingMsg>>();
    expectTypeOf<keyof EffectRuntime<PingModel, PingMsg>>().toEqualTypeOf<
      keyof Runtime<PingModel, PingMsg>
    >();
  });

  it("a dispatch after stop fails with `Stopped`, caught by tag", async () => {
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const booted = yield* (yield* pingOn()).ready;
          yield* booted.stop();
          return yield* booted.dispatch({ type: "check", host: "up" }).pipe(
            Effect.as("folded"),
            Effect.catchTags({
              Stopped: (e) => Effect.succeed(`stopped ${e.msgType} ${e.when}`),
              StoreFailed: () => Effect.succeed("store failed"),
              Offline: () => Effect.succeed("offline"),
            }),
          );
        }),
      ),
    );
    expect(outcome).toBe("stopped check stopped");
  });

  it("a Msg that arrives while the run stops fails with `Stopped` while `stopping`", async () => {
    const { value: rt } = await openScope(pingOn());
    const booted = await Effect.runPromise(rt.ready);
    // `stop()` closes the gate at once, then drains; the dispatch lands inside.
    const stopped = Effect.runPromise(booted.stop());
    const refused = await Effect.runPromise(
      Effect.flip(booted.dispatch({ type: "check", host: "up" })),
    );
    await stopped;
    expect(refused).toBeInstanceOf(Stopped);
    expect(refused).toMatchObject({ msgType: "check", when: "stopping" });
    expect(booted.getState()).toEqual({ checks: 0, pongs: 0 });
  });

  it("a failing `save` fails the dispatch with `StoreFailed`, and the run goes on", async () => {
    const disk = new Error("disk full");
    const inner = memoryStore<PingModel>();
    let full = false;
    const store: Store<PingModel> = {
      load: () => inner.load(),
      save: async (state) => {
        if (full) throw disk;
        await inner.save(state);
      },
      migrate: (raw) => inner.migrate(raw),
    };
    const { reports, onError } = sink();
    const [failure, state] = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const booted = yield* (yield* pingOn({ store, onError })).ready;
          full = true;
          const failure = yield* Effect.flip(
            booted.dispatch({ type: "check", host: "up" }),
          );
          full = false;
          yield* booted.dispatch({ type: "check", host: "up" });
          return [failure, booted.getState()] as const;
        }),
      ),
    );
    expect(failure).toBeInstanceOf(StoreFailed);
    expect(failure).toMatchObject({ operation: "save", cause: disk });
    // Save runs before the Cmds, so the failed transition sent no ping.
    expect(state).toEqual({ checks: 2, pongs: 1 });
    expect(reports).toEqual([]);
  });

  it("a hand-written cell's declared failure fails the dispatch with that failure", async () => {
    const failure = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const booted = yield* (yield* pingOn()).ready;
          return yield* Effect.flip(
            booted.dispatch({ type: "check", host: "down" }),
          );
        }),
      ),
    );
    expect(failure).toBeInstanceOf(Offline);
    expect(failure).toMatchObject({ _tag: "Offline", host: "down" });
  });

  it("the sink is handed a follow-up's failure itself, as on the Promise engine", async () => {
    const { reports, onError } = sink();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const booted = yield* (yield* pingOn({ onError })).ready;
          yield* booted.dispatch({ type: "forward", host: "down" });
        }),
      ),
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]?.phase).toBe("follow-up");
    expect(reports[0]?.error).toBeInstanceOf(Offline);
  });

  it("a contract breach stays a defect, never a typed failure", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const booted = yield* (yield* pingOn()).ready;
          yield* booted.dispatch({ type: "nope" } as unknown as PingMsg);
        }),
      ),
    );
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toBeInstanceOf(NoCellError);
    }
  });
});
