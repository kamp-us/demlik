/**
 * What a `stop()` that gave up threw away (ADR 0025, #698): its
 * `DrainTimeoutNotice` counts the Msgs queued behind the stuck handler, per Msg
 * type, so a host that did not wait on a Msg can still learn it was dropped.
 *
 * Both engines run one loop, so every case runs on both. It lives under
 * `src/effect/` because it imports `effect`, which only this entry may do.
 */

import { Cause, Effect, Exit, Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
  DispatchDiscardedError,
  DrainTimeoutNotice,
  defineMachine,
  type NoCtx,
  type RuntimeErrorContext,
  type Store,
  type Sub,
} from "../index";
import { memoryStore } from "../mem";
import { run as runPromise, tell as tellPromise } from "../promise";
import { run as runEffect, Stopped, tell as tellEffect } from "./index";

const SECRET = "a-host-secret";

type Model = { readonly folded: readonly string[] };
type ItemType = "alpha" | "beta" | "gamma";
type Msg =
  | { readonly type: "start" }
  | { readonly type: ItemType; readonly secret: string };
type Cmd = { readonly type: "work" };
type Feed = Sub<"feed", { readonly on: true }>;

const fold = (s: Model, msg: Msg): readonly [Model, readonly Cmd[]] => [
  { folded: [...s.folded, msg.type] },
  [],
];

const machine = defineMachine({
  types: {
    model: {} as Model,
    msg: {} as Msg,
    cmd: {} as Cmd,
    sub: {} as Feed,
    ctx: {} as NoCtx,
  },
  init: (loaded) => [loaded ?? { folded: [] }, []],
  update: {
    start: (s) => [s, [{ type: "work" }]],
    alpha: fold,
    beta: fold,
    gamma: fold,
  },
  subs: [{ type: "feed", deps: () => ({ on: true as const }) }],
});

const LIMIT_MS = 50;
const ENGINES = ["Promise", "Effect"] as const;
type Engine = (typeof ENGINES)[number];

/**
 * The handler of the `start` Msg's Cmd: one that never returns, one that returns
 * when the test says so, or (Effect only) one `stop()` can interrupt. The first
 * two cannot be interrupted on either engine.
 */
type Handler = "never" | "held" | "interruptible";

const item = (type: ItemType): Msg => ({ type, secret: SECRET });

/** The issue's 20 Msgs of three types, 10, 7 and 3, in a mixed order. */
function twentyItems(): readonly Msg[] {
  const counts = { alpha: 10, beta: 7, gamma: 3 };
  const items: Msg[] = [];
  while (items.length < 20) {
    for (const type of ["alpha", "beta", "gamma"] as const) {
      if (counts[type] > 0) {
        counts[type]--;
        items.push(item(type));
      }
    }
  }
  return items;
}

/** One run, with the Effect engine's verbs as Promises. */
interface Started {
  readonly reports: { error: unknown; phase: string }[];
  readonly saves: Model[];
  /** How the `work` handler's run is doing. */
  readonly work: { entered: boolean };
  /** Lets a `held` handler return. */
  release(): void;
  /** Settles with the error it was refused with, or `"folded"`. */
  dispatch(msg: Msg): Promise<unknown>;
  tell(msg: Msg): string;
  stop(): Promise<void>;
  state(): Model;
  /** Whatever a host does last. */
  close(): Promise<void>;
}

function hold(): { readonly released: Promise<void>; release(): void } {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { released, release };
}

/** A store that records every save, around `inner`. */
function recording(inner: Store<Model>, saves: Model[]): Store<Model> {
  return {
    load: () => inner.load(),
    migrate: (raw) => inner.migrate(raw),
    async save(state) {
      saves.push(state);
      await inner.save(state);
    },
  };
}

const outcome = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => "folded",
    (error: unknown) => error,
  );

const start: Record<
  Engine,
  (handler: Handler, store?: Store<Model>) => Promise<Started>
> = {
  Promise: async (handler, store = memoryStore<Model>(null)) => {
    const reports: Started["reports"] = [];
    const saves: Model[] = [];
    const work = { entered: false };
    const held = hold();
    const runtime = await runPromise(machine, {
      store: recording(store, saves),
      disposeTimeoutMs: LIMIT_MS,
      onError: (error: unknown, context: RuntimeErrorContext) => {
        reports.push({ error, phase: context.phase });
      },
      interpret: {
        work: async () => {
          work.entered = true;
          await (handler === "never"
            ? new Promise<void>(() => {})
            : held.released);
        },
      },
      subscribe: { feed: () => () => {} },
    }).ready;
    return {
      reports,
      saves,
      work,
      release: held.release,
      dispatch: (msg) => outcome(runtime.dispatchOnce(msg)),
      tell: (msg) => tellPromise(machine, runtime, msg),
      stop: () => runtime.stop(),
      state: () => runtime.getState(),
      close: () => runtime.stop(),
    };
  },
  Effect: async (handler, store = memoryStore<Model>(null)) => {
    const reports: Started["reports"] = [];
    const saves: Model[] = [];
    const work = { entered: false };
    const held = hold();
    const stuck: Record<Handler, Effect.Effect<void>> = {
      never: Effect.uninterruptible(Effect.never),
      held: Effect.uninterruptible(Effect.promise(() => held.released)),
      interruptible: Effect.never,
    };
    const scope = await Effect.runPromise(Scope.make());
    const booting = await Effect.runPromise(
      Scope.provide(scope)(
        runEffect(machine, {
          store: recording(store, saves),
          disposeTimeoutMs: LIMIT_MS,
          onError: (error: unknown, context: RuntimeErrorContext) => {
            reports.push({ error, phase: context.phase });
          },
          interpret: {
            work: () =>
              Effect.suspend(() => {
                work.entered = true;
                return stuck[handler];
              }),
          },
          subscribe: { feed: () => Stream.never },
        }),
      ),
    );
    const runtime = await Effect.runPromise(booting.ready);
    return {
      reports,
      saves,
      work,
      release: held.release,
      dispatch: (msg) =>
        Effect.runPromiseExit(runtime.dispatchOnce(msg)).then((exit) =>
          Exit.isSuccess(exit) ? "folded" : Cause.squash(exit.cause),
        ),
      tell: (msg) => Effect.runSync(tellEffect(machine, runtime, msg)),
      stop: () => Effect.runPromise(runtime.stop()),
      state: () => runtime.getState(),
      close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    };
  },
};

async function until(holds: () => boolean): Promise<void> {
  while (!holds()) await new Promise((resolve) => setTimeout(resolve, 1));
}

/** Long enough for a Msg the test handed over to reach the line, or settle. */
const settleWork = () => new Promise((resolve) => setTimeout(resolve, 30));

/** A run with `start` folded and its handler stuck, nothing else on the line. */
async function startStuck(
  engine: Engine,
  handler: Handler,
): Promise<Started & { readonly started: Promise<unknown> }> {
  const run = await start[engine](handler);
  const started = run.dispatch({ type: "start" });
  await until(() => run.work.entered);
  return { ...run, started };
}

const noticesOf = (run: {
  readonly reports: readonly { readonly error: unknown }[];
}): DrainTimeoutNotice[] =>
  run.reports.flatMap(({ error }) =>
    error instanceof DrainTimeoutNotice ? [error] : [],
  );

/** What `twentyItems` hands over, per Msg type. */
const COUNTS = { alpha: 10, beta: 7, gamma: 3 };

describe.each(
  ENGINES,
)("%s engine: the Msgs a stop() that gave up dropped", (engine) => {
  it("a host can tell what was thrown away: 20 Msgs of three types behind a handler that never returns", async () => {
    const run = await startStuck(engine, "never");
    const settled: unknown[] = [];
    for (const msg of twentyItems()) {
      void run.dispatch(msg).then((result) => settled.push(result));
    }
    await settleWork();
    const savesBefore = run.saves.length;

    const began = performance.now();
    await run.stop();
    const elapsed = performance.now() - began;

    // The upper bound is loose so a slow machine does not flake; the handler
    // never returns at all.
    expect(elapsed).toBeGreaterThanOrEqual(LIMIT_MS - 5);
    expect(elapsed).toBeLessThan(LIMIT_MS + 1_000);

    const [notice, ...others] = noticesOf(run);
    expect(others).toEqual([]);
    expect(notice?.droppedMsgs).toEqual(COUNTS);
    expect(notice?.cmdTypes).toEqual(["work"]);
    expect(notice?.message).toContain('"alpha" x10, "beta" x7, "gamma" x3');

    await settleWork();
    // No promise settled and nothing folded, so the count is the only word.
    expect(settled).toEqual([]);
    expect(run.state().folded).toEqual([]);
    // stop()'s own final save, and nothing else.
    expect(run.saves.length).toBe(savesBefore + 1);
    await run.close();
  });

  it("counts Msgs handed over with `tell`, which holds no promise", async () => {
    const run = await startStuck(engine, "never");
    for (const msg of twentyItems()) expect(run.tell(msg)).toBe("queued");

    await run.stop();

    expect(noticesOf(run).map((n) => n.droppedMsgs)).toEqual([COUNTS]);
    expect(run.state().folded).toEqual([]);
    await run.close();
  });

  it("counts `dispatch` and `tell` together, and each of three runs stopped at once counts only its own", async () => {
    const lines: Record<ItemType, number>[] = [
      { alpha: 1000, beta: 1, gamma: 40 },
      { alpha: 3, beta: 500, gamma: 2 },
      { alpha: 7, beta: 7, gamma: 7 },
    ];
    const runs = await Promise.all(
      lines.map(() => startStuck(engine, "never")),
    );
    for (const [i, counts] of lines.entries()) {
      for (const [type, count] of Object.entries(counts)) {
        for (let n = 0; n < count; n++) {
          const msg = item(type as ItemType);
          if (n % 2 === 0) void runs[i]?.dispatch(msg);
          else runs[i]?.tell(msg);
        }
      }
    }
    await settleWork();

    await Promise.all(runs.map((run) => run.stop()));

    expect(runs.map((run) => noticesOf(run)[0]?.droppedMsgs)).toEqual(lines);
    for (const run of runs) expect(noticesOf(run)).toHaveLength(1);
    await Promise.all(runs.map((run) => run.close()));
  });

  it("counts a Msg queued while the store's load was still pending", async () => {
    const inner = memoryStore<Model>(null);
    const load = hold();
    const store: Store<Model> = {
      ...inner,
      load: async () => {
        await load.released;
        return inner.load();
      },
    };
    const reports: { readonly error: unknown }[] = [];
    const onError = (error: unknown) => void reports.push({ error });
    let stop: () => Promise<void>;
    if (engine === "Promise") {
      const booting = runPromise(machine, {
        store,
        disposeTimeoutMs: LIMIT_MS,
        onError,
        interpret: { work: async () => {} },
        subscribe: { feed: () => () => {} },
      });
      for (const msg of twentyItems()) void booting.dispatchOnce(msg);
      stop = () => booting.stop();
    } else {
      const scope = await Effect.runPromise(Scope.make());
      const booting = await Effect.runPromise(
        Scope.provide(scope)(
          runEffect(machine, {
            store,
            disposeTimeoutMs: LIMIT_MS,
            onError,
            interpret: { work: () => Effect.void },
            subscribe: { feed: () => Stream.never },
          }),
        ),
      );
      for (const msg of twentyItems()) {
        void Effect.runPromiseExit(booting.dispatchOnce(msg));
      }
      await settleWork();
      stop = () => Effect.runPromise(booting.stop());
    }

    await stop();

    expect(noticesOf({ reports }).map((n) => n.droppedMsgs)).toEqual([COUNTS]);
    load.release();
  });

  it("a handler returning late changes nothing in the notice, and each dropped Msg is counted once", async () => {
    const run = await startStuck(engine, "held");
    const held = twentyItems();
    // Half wait on a promise and half do not: 5/5, 4/3, 1/2 of the 10, 7 and 3.
    const waiting = held
      .filter((_, i) => i % 2 === 0)
      .map((m) => run.dispatch(m));
    for (const msg of held.filter((_, i) => i % 2 === 1)) run.tell(msg);
    await settleWork();

    await run.stop();
    const [notice] = noticesOf(run);
    const reportsAtStop = [...run.reports];
    const savesAtStop = run.saves.length;
    const stateAtStop = run.state();
    expect(notice?.droppedMsgs).toEqual(COUNTS);

    run.release();
    const refusals = await Promise.all(waiting);
    await settleWork();

    // The notice is the same object with the same counts, and it is still the
    // only one. No Msg it counted reached the sink again.
    expect(noticesOf(run)).toEqual([notice]);
    expect(notice?.droppedMsgs).toEqual(COUNTS);
    expect(run.reports).toEqual(reportsAtStop);
    // The holders still hear, as they did before the count.
    expect(refusals).toHaveLength(10);
    for (const refusal of refusals) {
      expect(refusal).toBeInstanceOf(
        engine === "Promise" ? DispatchDiscardedError : Stopped,
      );
    }
    expect(run.saves.length).toBe(savesAtStop);
    expect(run.state()).toBe(stateAtStop);
    await run.close();
  });

  it("a stop() that finishes inside the limit reports no notice, and every Msg folds", async () => {
    const run = await startStuck(engine, "held");
    const items = twentyItems();
    for (const msg of items) run.tell(msg);

    const stopped = run.stop();
    run.release();
    await stopped;

    expect(noticesOf(run)).toEqual([]);
    expect(run.state().folded).toEqual(items.map((m) => m.type));
    await run.close();
  });

  it("the notice carries Msg types and counts, and no payload", async () => {
    const run = await startStuck(engine, "never");
    for (const msg of twentyItems()) run.tell(msg);

    await run.stop();

    const [notice] = noticesOf(run);
    expect(notice).toBeDefined();
    for (const value of Object.values(notice?.droppedMsgs ?? {})) {
      expect(typeof value).toBe("number");
    }
    for (const read of [
      JSON.stringify(notice),
      notice?.message,
      String(notice),
      notice?.stack,
    ]) {
      expect(read).not.toContain(SECRET);
    }
    await run.close();
  });

  it("counts nothing when nothing waits behind the stuck handler", async () => {
    const run = await startStuck(engine, "never");

    await run.stop();

    expect(noticesOf(run).map((n) => n.droppedMsgs)).toEqual([{}]);
    await run.close();
  });
});

describe("Effect engine: a handler stop() can interrupt", () => {
  it("drops nothing: all 20 fold and save, and no count is reported", async () => {
    const run = await startStuck("Effect", "interruptible");
    const items = twentyItems();
    const waiting = items.map((msg) => run.dispatch(msg));
    await settleWork();
    const savesBefore = run.saves.length;

    await run.stop();

    expect(await Promise.all(waiting)).toEqual(items.map(() => "folded"));
    expect(noticesOf(run)).toEqual([]);
    const folded = items.map((m) => m.type);
    expect(run.state().folded).toEqual(folded);
    // A save per Msg, and stop()'s final one.
    expect(run.saves.length).toBe(savesBefore + 21);
    expect(run.saves.at(-1)?.folded).toEqual(folded);
    await run.close();
  });
});

describe("Promise engine: a Msg a handler or a Sub sent, on the line behind it", () => {
  it("is counted, and reaches the sink no second time when the handler returns late", async () => {
    const reports: unknown[] = [];
    const held = hold();
    let entered = false;
    let fromSub!: (msg: Msg) => void;
    const runtime = await runPromise(machine, {
      disposeTimeoutMs: LIMIT_MS,
      onError: (error: unknown) => void reports.push(error),
      interpret: {
        work: async (_cmd, _ctx, dispatch) => {
          dispatch?.(item("alpha"));
          entered = true;
          await held.released;
        },
      },
      subscribe: {
        feed: (_sub, _ctx, dispatch) => {
          fromSub = dispatch;
          return () => {};
        },
      },
    }).ready;
    void runtime.dispatchOnce({ type: "start" });
    await until(() => entered);
    fromSub(item("beta"));

    await runtime.stop();
    held.release();
    await settleWork();

    const notices = reports.filter((r) => r instanceof DrainTimeoutNotice);
    expect(notices.map((n) => n.droppedMsgs)).toEqual([{ alpha: 1, beta: 1 }]);
    expect(reports.filter((r) => r instanceof DispatchDiscardedError)).toEqual(
      [],
    );
  });
});
