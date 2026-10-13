/**
 * What `stop()` promises about the store once it has given up at
 * `disposeTimeoutMs` (ADR 0025, #656): tea starts no store call after `stop()`
 * has returned. A store call already under way is not cancelled and can still
 * land; a fenced store refuses it once a newer run has saved, a plain store
 * takes it.
 *
 * Both engines run one loop, so every case runs on both. It lives under
 * `src/effect/` because it imports `effect`, which only this entry may do.
 */

import { Cause, Effect, Exit, Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
  DrainTimeoutNotice,
  defineMachine,
  type FencedStore,
  type NoCtx,
  type RuntimeErrorContext,
  type Store,
  StoreConflictError,
  type Sub,
} from "../index";
import { memoryStore } from "../mem";
import { run as runPromise } from "../promise";
import { run as runEffect, StoreFailed } from "./index";

type Model = { readonly asked: number };
type Msg = { readonly type: "ask" };
type Cmd = { readonly type: "warm" } | { readonly type: "work" };
type Feed = Sub<"feed", { readonly gen: number }>;

// `init` returns a Cmd and the machine declares a Sub, so a boot that went on
// as if the run were live would start both. The Sub's id follows `asked`, so a
// step that went on would start a fresh one too.
const machine = defineMachine({
  types: {
    model: {} as Model,
    msg: {} as Msg,
    cmd: {} as Cmd,
    sub: {} as Feed,
    ctx: {} as NoCtx,
  },
  init: (loaded) => [loaded ?? { asked: 0 }, [{ type: "warm" }]],
  update: {
    ask: (s) => [{ asked: s.asked + 1 }, [{ type: "work" }]],
  },
  subs: [{ type: "feed", deps: (s: Model) => ({ gen: s.asked }) }],
});

const LIMIT_MS = 40;
const ENGINES = ["Promise", "Effect"] as const;
type Engine = (typeof ENGINES)[number];

/** What one run did, as the test reads it. */
interface Probe {
  readonly reports: { error: unknown; phase: string }[];
  /** The Cmd of each handler that started, in order. */
  readonly handlers: string[];
  /** How many Sub runners started. */
  subs: number;
}

/** One run, with the Effect engine's verbs as Promises. */
interface Started {
  readonly probe: Probe;
  stop(): Promise<void>;
  /** Settles as the run's `ready` does. */
  ready(): Promise<{ getState(): Model }>;
  dispatch(msg: Msg): Promise<void>;
  /** What a host does last: a second `stop()`, or closing the run's Scope. */
  close(): Promise<void>;
}

/** Run an Effect, rejecting with its failure or defect as it stands. */
async function settle<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}

const start: Record<Engine, (store: Store<Model>) => Promise<Started>> = {
  Promise: async (store) => {
    const probe: Probe = { reports: [], handlers: [], subs: 0 };
    const booting = runPromise(machine, {
      store,
      disposeTimeoutMs: LIMIT_MS,
      onError: (error: unknown, context: RuntimeErrorContext) => {
        probe.reports.push({ error, phase: context.phase });
      },
      interpret: {
        warm: async () => {
          probe.handlers.push("warm");
        },
        work: async () => {
          probe.handlers.push("work");
        },
      },
      subscribe: {
        feed: () => {
          probe.subs++;
          return () => {};
        },
      },
    });
    return {
      probe,
      stop: () => booting.stop(),
      ready: () => booting.ready,
      dispatch: async (msg) => (await booting.ready).dispatchOnce(msg),
      close: () => booting.stop(),
    };
  },
  Effect: async (store) => {
    const probe: Probe = { reports: [], handlers: [], subs: 0 };
    const scope = await Effect.runPromise(Scope.make());
    const booting = await Effect.runPromise(
      Scope.provide(scope)(
        runEffect(machine, {
          store,
          disposeTimeoutMs: LIMIT_MS,
          onError: (error: unknown, context: RuntimeErrorContext) => {
            probe.reports.push({ error, phase: context.phase });
          },
          interpret: {
            warm: () =>
              Effect.sync(() => {
                probe.handlers.push("warm");
              }),
            work: () =>
              Effect.sync(() => {
                probe.handlers.push("work");
              }),
          },
          subscribe: {
            feed: () => {
              probe.subs++;
              return Stream.never;
            },
          },
        }),
      ),
    );
    return {
      probe,
      stop: () => Effect.runPromise(booting.stop()),
      ready: () => settle(booting.ready),
      dispatch: (msg) =>
        settle(Effect.flatMap(booting.ready, (rt) => rt.dispatchOnce(msg))),
      close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    };
  },
};

/** A promise the test holds and releases. */
function hold(): { readonly released: Promise<void>; release(): void } {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { released, release };
}

/**
 * `call`, with its second invocation held until `release`. On a run's store
 * that is the first step's save: boot makes the first call.
 */
function holdSecondCall<A extends unknown[], R>(
  call: (...args: A) => Promise<R>,
) {
  const held = hold();
  let calls = 0;
  return {
    calls: () => calls,
    release: held.release,
    call: async (...args: A): Promise<R> => {
      calls++;
      if (calls === 2) await held.released;
      return call(...args);
    },
  };
}

/** Long enough for any store call a released run would start to be recorded. */
const settleLateWork = () => new Promise((resolve) => setTimeout(resolve, 30));

async function until(holds: () => boolean): Promise<void> {
  while (!holds()) await new Promise((resolve) => setTimeout(resolve, 1));
}

/** The Effect engine's wrapper off a save failure, so both engines read alike. */
const saveFailureOf = (error: unknown): unknown =>
  error instanceof StoreFailed ? error.cause : error;

describe.each(
  ENGINES,
)("%s engine: store calls around a stop() that gave up", (engine) => {
  /** A run on a store that already holds `saved` and whose load is held. */
  async function startLoading(saved: Model) {
    const inner = memoryStore<Model>(saved);
    const held = hold();
    const read: unknown[] = [];
    const saves: Model[] = [];
    const store: Store<Model> = {
      async load() {
        const raw = await inner.load();
        read.push(raw);
        await held.released;
        return raw;
      },
      migrate: (raw) => inner.migrate(raw),
      async save(state) {
        saves.push(state);
        await inner.save(state);
      },
    };
    const run = await start[engine](store);
    await until(() => read.length === 1);
    return { run, inner, saves, release: held.release };
  }

  /**
   * A booted run with its `ask` step under way: the step's save has been
   * called and `slow` is holding it. `asked` settles with the step's failure,
   * or with nothing.
   */
  async function startStep(
    store: Store<Model>,
    slow: { calls(): number },
  ): Promise<{ run: Started; asked: Promise<unknown> }> {
    const run = await start[engine](store);
    await run.ready();
    const asked = run.dispatch({ type: "ask" }).then(
      () => undefined,
      (error: unknown) => error,
    );
    await until(() => slow.calls() === 2);
    return { run, asked };
  }

  /** A newer run boots from `store` and saves two steps of its own. */
  async function takeOver(store: Store<Model>): Promise<Started> {
    const newer = await start[engine](store);
    await newer.ready();
    await newer.dispatch({ type: "ask" });
    await newer.dispatch({ type: "ask" });
    expect(await store.load()).toEqual({ asked: 3 });
    return newer;
  }

  it("three runs stopped mid-load never write over what a newer run saved", async () => {
    const saved: Model[] = [{ asked: 7 }, { asked: 8 }, { asked: 9 }];
    const runs = await Promise.all(saved.map(startLoading));

    const began = performance.now();
    await Promise.all(runs.map((r) => r.run.stop()));
    const elapsed = performance.now() - began;
    // One limit, side by side. The upper bound is loose so a slow machine does
    // not flake; the loads are still held.
    expect(elapsed).toBeGreaterThanOrEqual(LIMIT_MS - 5);
    expect(elapsed).toBeLessThan(LIMIT_MS + 1_000);

    // The store now goes to something else, which saves its own State.
    const takenOver: Model[] = [{ asked: 107 }, { asked: 108 }, { asked: 109 }];
    for (const [i, r] of runs.entries()) {
      expect(r.saves).toEqual([]);
      await r.inner.save(takenOver[i] as Model);
    }

    for (const r of runs) r.release();
    const booted = await Promise.all(runs.map((r) => r.run.ready()));
    await settleLateWork();

    for (const [i, r] of runs.entries()) {
      expect(await r.inner.load()).toEqual(takenOver[i]);
      expect(r.saves).toEqual([]);
      // `ready` resolved, with the State the load read installed and unsaved.
      expect(booted[i]?.getState()).toEqual(saved[i]);
      expect(r.run.probe.handlers).toEqual([]);
      expect(r.run.probe.subs).toBe(0);
      expect(r.run.probe.reports).toEqual([
        { error: expect.any(DrainTimeoutNotice), phase: "discard" },
      ]);
    }

    // A host that stops again, or closes the run's Scope, saves nothing either.
    await Promise.all(runs.map((r) => r.run.close()));
    await settleLateWork();
    for (const [i, r] of runs.entries()) {
      expect(r.saves).toEqual([]);
      expect(await r.inner.load()).toEqual(takenOver[i]);
    }
  });

  it("three runs stopped with a step's save held start nothing once it is released", async () => {
    const runs = await Promise.all(
      [0, 1, 2].map(async () => {
        const inner = memoryStore<Model>(null);
        const slow = holdSecondCall(inner.save);
        const saves: Model[] = [];
        const store: Store<Model> = {
          ...inner,
          save(state) {
            saves.push(state);
            return slow.call(state);
          },
        };
        return { ...(await startStep(store, slow)), saves, slow };
      }),
    );

    await Promise.all(runs.map((r) => r.run.stop()));
    for (const r of runs) {
      // Boot's save, the held one, and stop()'s final save.
      expect(r.saves).toEqual([{ asked: 0 }, { asked: 1 }, { asked: 1 }]);
      expect(r.run.probe.handlers).toEqual(["warm"]);
      expect(r.run.probe.subs).toBe(1);
    }

    for (const r of runs) r.slow.release();
    expect(await Promise.all(runs.map((r) => r.asked))).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    await settleLateWork();
    await Promise.all(runs.map((r) => r.run.close()));
    await settleLateWork();

    for (const r of runs) {
      expect(r.saves).toHaveLength(3);
      expect(r.run.probe.handlers).toEqual(["warm"]);
      expect(r.run.probe.subs).toBe(1);
    }
  });

  it("a fenced store refuses the save that lands late, so the newer run's State stays", async () => {
    const inner = memoryStore<Model>(null, undefined, { fenced: true });
    // A run reaches a fenced store through `saveFenced`, so hold it there.
    const slow = holdSecondCall(inner.saveFenced);
    const slowed: FencedStore<Model> = { ...inner, saveFenced: slow.call };
    const stopped = await startStep(slowed, slow);
    await stopped.run.stop();
    const newer = await takeOver(inner);

    slow.release();
    expect(saveFailureOf(await stopped.asked)).toBeInstanceOf(
      StoreConflictError,
    );
    await settleLateWork();
    expect(await inner.load()).toEqual({ asked: 3 });

    await stopped.run.close();
    await newer.stop();
    expect(await inner.load()).toEqual({ asked: 3 });
  });

  it("a plain store takes that late save, over what the newer run saved", async () => {
    const inner = memoryStore<Model>(null);
    const slow = holdSecondCall(inner.save);
    const stopped = await startStep({ ...inner, save: slow.call }, slow);
    await stopped.run.stop();
    const newer = await takeOver(inner);

    slow.release();
    // Nothing refused it: the stopped run's State is back in the store.
    expect(await stopped.asked).toBeUndefined();
    await settleLateWork();
    expect(await inner.load()).toEqual({ asked: 1 });

    await stopped.run.close();
    await newer.stop();
  });
});
