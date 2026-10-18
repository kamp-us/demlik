import { setTimeout as delay } from "node:timers/promises";
import { Cause, Effect, Exit, Scope } from "effect";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  defineMachine,
  type Runtime,
  type Store,
  type TimerSub,
} from "../index";
import { memoryStore } from "../mem";
import { run as runPromise } from "../promise";
import { run as runEffect, StoreFailed } from "./index";

type State = { readonly type: "working" | "done" };
type Msg = { readonly type: "finish" };
type Cmd = { readonly type: "work" };

const machine = defineMachine({
  types: {
    model: {} as State,
    msg: {} as Msg,
    cmd: {} as Cmd,
    sub: {} as TimerSub<Msg>,
  },
  init: (loaded) => [loaded ?? { type: "working" }, []],
  update: {
    finish: (): readonly [State, readonly Cmd[]] => [
      { type: "done" },
      [{ type: "work" }],
    ],
  },
  subs: [
    {
      type: "timer",
      deps: (state: State) =>
        state.type === "working"
          ? { ms: 10, msg: { type: "finish" as const } }
          : null,
    },
  ],
});

function hold() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function settle<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}

type Handle = Pick<
  Runtime<State, Msg>,
  "getState" | "result" | "done" | "idle"
>;
interface Started {
  readonly rt: Handle;
  readonly reports: unknown[];
  readonly completionFailures: StoreFailed[];
  close(): Promise<void>;
}

const engines: Record<
  "Promise" | "Effect",
  (
    store?: Store<State>,
    work?: Promise<void>,
    init?: typeof machine.init,
  ) => Promise<Started>
> = {
  Promise: async (store, work = Promise.resolve(), init = machine.init) => {
    const reports: unknown[] = [];
    const booting = runPromise(
      { ...machine, init },
      {
        store,
        terminal: (state) => state.type === "done",
        onError: (error) => reports.push(error),
        interpret: { work: () => work },
      },
    );
    try {
      const rt = await booting.ready;
      return { rt, reports, completionFailures: [], close: () => rt.stop() };
    } catch (error) {
      await booting.stop();
      throw error;
    }
  },
  Effect: async (store, work = Promise.resolve(), init = machine.init) => {
    const reports: unknown[] = [];
    const completionFailures: StoreFailed[] = [];
    const scope = await Effect.runPromise(Scope.make());
    const rt = await settle(
      Scope.provide(scope)(
        Effect.flatMap(
          runEffect(
            { ...machine, init },
            {
              store,
              terminal: (state) => state.type === "done",
              onError: (error) => reports.push(error),
              interpret: { work: () => Effect.promise(() => work) },
            },
          ),
          (booting) => booting.ready,
        ),
      ),
    ).catch(async (error: unknown) => {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      throw error;
    });
    expectTypeOf(rt.done()).toEqualTypeOf<Effect.Effect<State, StoreFailed>>();
    return {
      rt: {
        getState: rt.getState,
        result: rt.result,
        done: () =>
          settle(
            rt.done().pipe(
              Effect.tapError((error) =>
                Effect.sync(() => {
                  completionFailures.push(error);
                }),
              ),
            ),
          ),
        idle: () => settle(rt.idle()),
      },
      reports,
      completionFailures,
      close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    };
  },
};

function slowStore(failure?: Error, loaded?: State) {
  const inner = memoryStore<State>(loaded);
  const entered = hold();
  const delayed = hold();
  const finish = hold();
  const durations: number[] = [];
  const store: Store<State> = {
    load: () => inner.load(),
    migrate: (raw) => inner.migrate(raw),
    async save(state) {
      if (state.type === "done") {
        const began = performance.now();
        entered.release();
        await delay(60);
        delayed.release();
        await finish.promise;
        if (failure !== undefined) throw failure;
        durations.push(performance.now() - began);
      }
      await inner.save(state);
    },
  };
  return { store, entered, delayed, finish, durations };
}

function outcome(promise: Promise<State>) {
  return promise.then(
    (state) => ({ type: "done" as const, state }),
    (error: unknown) => ({ type: "failed" as const, error }),
  );
}

describe.each(
  Object.entries(engines),
)("terminal saves on %s", (engine, start) => {
  it.each([
    "done-first",
    "result-first",
  ])("waits for persistence before completion, %s, over three runs", async (order) => {
    for (let run = 0; run < 3; run++) {
      const slow = slowStore();
      const { rt, close } = await start(slow.store);
      const completed: State[] = [];
      const results: (State | undefined)[] = [];
      const pending: Promise<{ state: State; saved: unknown }>[] = [];
      const query = () => {
        const done = () => {
          pending.push(
            rt.done().then(async (state) => {
              completed.push(state);
              return { state, saved: await slow.store.load() };
            }),
          );
        };
        const result = () => results.push(rt.result());
        if (order === "done-first") {
          done();
          result();
        } else {
          result();
          done();
        }
      };
      try {
        expect(rt.getState().type).toBe("working");
        query();
        await slow.entered.promise;
        query();
        await vi.waitFor(() => expect(rt.getState().type).toBe("done"));
        query();
        await slow.delayed.promise;

        expect(results).toEqual([undefined, undefined, undefined]);
        expect(completed).toEqual([]);
        expect(await slow.store.load()).toEqual({ type: "working" });

        slow.finish.release();
        const readings = await Promise.all(pending);
        expect(readings).toEqual(
          Array.from({ length: 3 }, () => ({
            state: { type: "done" },
            saved: { type: "done" },
          })),
        );
        expect(rt.result()).toEqual(await slow.store.load());
        expect(await rt.done()).toEqual({ type: "done" });
        expect(slow.durations[0]).toBeGreaterThanOrEqual(50);
      } finally {
        slow.finish.release();
        await close();
      }
    }
  });

  it("rejects existing and later done() calls with a terminal save failure", async () => {
    const failure = new Error("terminal save refused");
    const slow = slowStore(failure);
    const { rt, reports, completionFailures, close } = await start(slow.store);
    try {
      const before = outcome(rt.done());
      await slow.entered.promise;
      const during = outcome(rt.done());
      slow.finish.release();
      await rt.idle();

      expect(rt.result()).toBeUndefined();
      const after = await outcome(rt.done());
      expect(after.type).toBe("failed");
      for (const result of await Promise.all([before, during, after])) {
        expect(result.type).toBe("failed");
        if (result.type !== "failed") throw new Error("done() resolved");
        if (engine === "Effect") {
          expect(result.error).toBeInstanceOf(StoreFailed);
          expect(result.error).toMatchObject({
            operation: "save",
            cause: failure,
          });
        } else {
          expect(result.error).toBe(failure);
        }
      }
      if (engine === "Effect") expect(completionFailures).toHaveLength(3);
      expect(reports).toEqual([failure]);
      expect(await slow.store.load()).toEqual({ type: "working" });
    } finally {
      slow.finish.release();
      await close();
    }
  });

  it("without a store answers as soon as State is set, before a held Cmd finishes", async () => {
    const work = hold();
    const { rt, close } = await start(undefined, work.promise);
    try {
      await vi.waitFor(() => expect(rt.getState().type).toBe("done"));
      expect(rt.result()).toEqual({ type: "done" });
      expect(await rt.done()).toEqual({ type: "done" });
    } finally {
      work.release();
      await close();
    }
  });

  it("holds restored terminal boot and its completion reads until the delayed save succeeds", async () => {
    const slow = slowStore(undefined, { type: "working" });
    const init = vi.fn(
      (loaded: State | null): readonly [State, readonly Cmd[]] => {
        expect(loaded).toEqual({ type: "working" });
        return [{ type: "done" }, []];
      },
    );
    const starting = start(slow.store, undefined, init);
    const readings: State[] = [];
    const completion = starting.then(async ({ rt }) => {
      const result = rt.result();
      if (result !== undefined) readings.push(result);
      readings.push(await rt.done());
      return slow.store.load();
    });
    try {
      await slow.entered.promise;
      await slow.delayed.promise;
      expect(readings).toEqual([]);
      expect(await slow.store.load()).toEqual({ type: "working" });
      slow.finish.release();
      expect(await completion).toEqual({ type: "done" });
      expect(readings).toEqual([{ type: "done" }, { type: "done" }]);
      expect(init).toHaveBeenCalledTimes(1);
    } finally {
      slow.finish.release();
      await (await starting).close();
    }
  });

  it("rejects restored terminal boot when its save fails", async () => {
    const failure = new Error("restored terminal save refused");
    const slow = slowStore(failure, { type: "working" });
    const init: typeof machine.init = (loaded) => {
      expect(loaded).toEqual({ type: "working" });
      return [{ type: "done" }, []];
    };
    const starting = start(slow.store, undefined, init).then(
      async ({ close }) => {
        await close();
        return undefined;
      },
      (error: unknown) => error,
    );
    try {
      await slow.entered.promise;
      await slow.delayed.promise;
      expect(await slow.store.load()).toEqual({ type: "working" });
      slow.finish.release();
      const error = await starting;
      if (engine === "Effect") {
        expect(error).toBeInstanceOf(StoreFailed);
        expect(error).toMatchObject({ operation: "save", cause: failure });
      } else {
        expect(error).toBe(failure);
      }
      expect(await slow.store.load()).toEqual({ type: "working" });
    } finally {
      slow.finish.release();
      await starting;
    }
  });

  it("a terminal rehydrate completes at boot with the terminal State saved", async () => {
    const store = memoryStore<State>({ type: "done" });
    const { rt, close } = await start(store);
    try {
      expect(rt.result()).toEqual({ type: "done" });
      expect(await rt.done()).toEqual(await store.load());
    } finally {
      await close();
    }
  });
});
