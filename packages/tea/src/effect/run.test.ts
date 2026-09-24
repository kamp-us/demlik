/**
 * The Effect engine's own contract (#283): interruption on stop, services from
 * the caller's Layers, the error sink for defects and undeclared failures, the
 * built-in `timer` and its override, and the fenced-store check.
 */

import {
  Context,
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
  type RuntimeErrorContext,
  type Settled,
  StoreConflictError,
  type Sub,
  UndeclaredFailureError,
} from "../index";
import { memoryStore } from "../mem";
import { run } from "./index";

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
    const booted = await rt.ready;
    const seen: string[] = [];
    rt.observe((msg) => seen.push(msg.type));

    const pending = booted.dispatch({ type: "go", id: "slow" });
    await vi.waitFor(() => expect(started).toBe(true));
    await close();

    expect(interrupted).toBe(true);
    expect(finalized).toBe(true);
    // The dispatch that started the handler settles; nothing came of it.
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seen).toEqual(["go"]);
    expect(booted.getState()).toEqual({ names: [], errs: 0 });
    // The runtime is stopped: a new Msg is refused, not folded.
    await expect(booted.dispatch({ type: "go", id: "late" })).rejects.toThrow(
      /stopped/,
    );
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
    const booted = await rt.ready;
    await vi.waitFor(() => expect(booted.getState()).toEqual({ n: 1 }));
    await close();
    expect(released).toBe(true);
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
        BootingRuntime<Model2, Msg | { readonly type: "beat" }, never>,
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
          return yield* Effect.promise(async () => {
            const booted = await rt.ready;
            await booted.dispatch({ type: "go", id: "7" });
            await vi.waitFor(() => expect(booted.getState().beats).toBe(2));
            return booted.getState();
          });
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
        Effect.flatMap(
          run(machine, { onError, interpret: { load: cell } }),
          (rt) =>
            Effect.promise(async () => {
              const booted = await rt.ready;
              await booted.dispatch({ type: "go", id: "x" });
              return booted.getState();
            }),
        ),
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
        Effect.flatMap(run(alarm, { terminal: (s) => s.rung === 1 }), (rt) =>
          Effect.promise(async () => (await rt.ready).done()),
        ),
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
          (rt) => Effect.promise(async () => (await rt.ready).done()),
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
        (rt) => Effect.promise(() => rt.ready),
      );
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const first = yield* bootOn("first");
          const second = yield* bootOn("second");
          // The second writer boots at the same version and saves first…
          yield* Effect.promise(() => second.dispatch({ type: "go", id: "a" }));
          // …so the first writer's next save is a stale compare-and-swap.
          return yield* Effect.promise(() =>
            first.dispatch({ type: "go", id: "b" }).then(
              () => "saved",
              (error: unknown) => error,
            ),
          );
        }),
      ),
    );
    expect(outcome).toBeInstanceOf(StoreConflictError);
    expect(reports.map((r) => r.phase)).toEqual(["stop-save"]);
    expect(reports[0]?.error).toBeInstanceOf(StoreConflictError);
  });
});
