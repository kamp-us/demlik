/**
 * `Store.save` receives the Msg whose transition produced the State, and the
 * engine awaits that save before the transition's Cmds start. Both engines run
 * one loop, so every case runs on both. It lives under `src/effect/` because it
 * imports `effect`, which only this entry may do.
 *
 * The fenced wrapper and the Effect engine's failure wrapper are the real ones
 * the engines install; nothing here re-implements the transition loop.
 */

import { Cause, Effect, Exit, Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
  defineMachine,
  type FencedStore,
  type Reducer,
  type Store,
  type Sub,
  type Transitions,
} from "../index";
import { memoryStore } from "../mem";
import { run as runPromise } from "../promise";
import { run as runEffect, StoreFailed } from "./index";

type Model =
  | { readonly _tag: "idle" }
  | { readonly _tag: "sending"; readonly files: number }
  | { readonly _tag: "done" };
type Msg =
  | { readonly _tag: "send"; readonly files: number }
  | { readonly _tag: "finish" };
type Cmd = { readonly _tag: "notify"; readonly files: number };
type Feed = Sub<"feed", { readonly files: number }>;

const update: Transitions<Model, Msg, Cmd> = {
  idle: {
    send: (_s, m) => [
      { _tag: "sending", files: m.files },
      [{ _tag: "notify", files: m.files }],
    ],
  },
  sending: { finish: () => [{ _tag: "done" }, []] },
  done: {},
};

const uploader = defineMachine({
  types: {
    model: {} as Model,
    msg: {} as Msg,
    cmd: {} as Cmd,
    sub: {} as Feed,
  },
  init: (loaded) => [loaded ?? { _tag: "idle" }, []],
  update,
  subs: [
    {
      _tag: "feed",
      deps: (s: Model) => (s._tag === "sending" ? { files: s.files } : null),
    },
  ],
});

const send: Msg = { _tag: "send", files: 2 };
const finish: Msg = { _tag: "finish" };
const cause = new Error("storage refused");

const ENGINES = ["Promise", "Effect"] as const;
type Engine = (typeof ENGINES)[number];

/** One run, with the Effect engine's verbs as Promises. */
interface Started {
  /** What the handlers and Subs did, in order. */
  readonly seen: string[];
  /** Each State a listener was told about. */
  readonly heard: Model[];
  dispatch(msg: Msg): Promise<void>;
  stop(): Promise<void>;
}

async function settle<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}

/** The Effect engine's wrapper off a save failure, so both engines read alike. */
const saveFailureOf = (error: unknown): unknown =>
  error instanceof StoreFailed ? error.cause : error;

const start: Record<Engine, (store: Store<Model>) => Promise<Started>> = {
  Promise: async (store) => {
    const seen: string[] = [];
    const heard: Model[] = [];
    const rt = await runPromise(uploader, {
      store,
      onError: () => {},
      interpret: {
        notify: async (cmd) => {
          seen.push(`notify:${cmd.files}`);
        },
      },
      subscribe: {
        feed: (sub) => {
          seen.push(`feed:${sub.deps.files}`);
          return () => {};
        },
      },
    }).ready;
    rt.subscribe(() => heard.push(rt.getState()));
    return { seen, heard, dispatch: (msg) => rt.dispatch(msg), stop: rt.stop };
  },
  Effect: async (store) => {
    const seen: string[] = [];
    const heard: Model[] = [];
    const scope = await Effect.runPromise(Scope.make());
    const rt = await settle(
      Scope.provide(scope)(
        Effect.flatMap(
          runEffect(uploader, {
            store,
            onError: () => {},
            interpret: {
              notify: (cmd) =>
                Effect.sync(() => {
                  seen.push(`notify:${cmd.files}`);
                }),
            },
            subscribe: {
              feed: (sub) => {
                seen.push(`feed:${sub.deps.files}`);
                return Stream.never;
              },
            },
          }),
          (booting) => booting.ready,
        ),
      ),
    );
    rt.subscribe(() => heard.push(rt.getState()));
    return {
      seen,
      heard,
      dispatch: (msg) => settle(rt.dispatch(msg)),
      stop: async () => {
        await settle(rt.stop());
        await Effect.runPromise(Scope.close(scope, Exit.void));
      },
    };
  },
};

/** One `save` call as the store received it: its State and every argument. */
interface Saved {
  readonly state: Model;
  readonly args: readonly unknown[];
}

/**
 * A plain store that records each save with the arguments it was handed. The
 * save call numbered `holdAt` (0 is boot) waits for `release`; the one numbered
 * `failAt` rejects with `cause`.
 */
function recording(options: { holdAt?: number; failAt?: number } = {}) {
  const inner = memoryStore<Model>();
  const saves: Saved[] = [];
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const store: Store<Model> = {
    load: () => inner.load(),
    async save(state, ...rest) {
      const call = saves.length;
      saves.push({ state, args: [state, ...rest] });
      if (call === options.holdAt) await released;
      if (call === options.failAt) throw cause;
      await inner.save(state);
    },
    migrate: (raw) => inner.migrate(raw),
  };
  return { store, saves, release, load: () => inner.load() };
}

const msgOf = (saved: Saved | undefined): unknown => saved?.args[1];

const until = async (holds: () => boolean) => {
  while (!holds()) await new Promise((resolve) => setTimeout(resolve, 1));
};

describe.each(
  ENGINES,
)("%s engine: Store.save receives the applied message", (engine) => {
  it("hands the save the Msg the transition applied, and starts no Cmd until it resolves", async () => {
    const { store, saves, release } = recording({ holdAt: 1 });
    const run = await start[engine](store);

    const sending = run.dispatch(send);
    await until(() => saves.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(msgOf(saves[1])).toBe(send);
    expect(saves[1]?.state).toEqual({ _tag: "sending", files: 2 });
    expect(run.seen).toEqual([]);
    expect(run.heard).toEqual([]);

    release();
    await sending;
    expect(run.seen).toEqual(["feed:2", "notify:2"]);
    expect(run.heard).toEqual([{ _tag: "sending", files: 2 }]);
    await run.stop();
  });

  it("gives boot and the final flush no Msg, and each later save the Msg of its own transition", async () => {
    const { store, saves } = recording();
    const run = await start[engine](store);
    await run.dispatch(send);
    await run.dispatch(finish);
    await run.stop();

    expect(saves.map(msgOf)).toEqual([undefined, send, finish, undefined]);
    expect(saves.map((s) => s.state._tag)).toEqual([
      "idle",
      "sending",
      "done",
      "done",
    ]);
  });

  it("saves nothing for a Msg the State has no cell for", async () => {
    const { store, saves } = recording();
    const run = await start[engine](store);
    await run.dispatch(send);
    const before = saves.length;

    await expect(run.dispatch(send)).rejects.toBeInstanceOf(Error);

    expect(saves).toHaveLength(before);
    await run.stop();
  });

  it("runs no Cmd, starts no Sub and tells no listener when the save rejects, and keeps the cause", async () => {
    const { store, saves, load } = recording({ failAt: 1 });
    const run = await start[engine](store);

    const failure = await run.dispatch(send).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(saveFailureOf(failure)).toBe(cause);
    expect(msgOf(saves[1])).toBe(send);
    expect(run.seen).toEqual([]);
    expect(run.heard).toEqual([]);
    expect(await load()).toEqual({ _tag: "idle" });
    await run.stop();
  });

  it("forwards the Msg through the fencing wrapper, after the version it swaps on", async () => {
    const inner = memoryStore<Model>(null, undefined, { fenced: true });
    const calls: { expected: number; args: readonly unknown[] }[] = [];
    const store: FencedStore<Model> = {
      ...inner,
      async saveFenced(state, expected, ...rest) {
        calls.push({ expected, args: [state, expected, ...rest] });
        return inner.saveFenced(state, expected);
      },
    };
    const run = await start[engine](store);
    await run.dispatch(send);
    await run.dispatch(finish);
    await run.stop();

    expect(calls.map((c) => c.expected)).toEqual([0, 1, 2, 3]);
    expect(calls.map((c) => c.args[2])).toEqual([
      undefined,
      send,
      finish,
      undefined,
    ]);
  });
});

describe.each(
  ENGINES,
)("%s engine: Store.save receives the boundary", (engine) => {
  it("tells each save which boundary it is, with the Cmds that boundary starts", async () => {
    const { store, saves } = recording();
    const run = await start[engine](store);
    await run.dispatch(send);
    await run.dispatch(finish);
    await run.stop();

    expect(saves.map((s) => s.args[2])).toEqual([
      { _tag: "init", cmds: [] },
      { _tag: "step", cmds: [{ _tag: "notify", files: 2 }] },
      { _tag: "step", cmds: [] },
      { _tag: "stop" },
    ]);
  });
});

describe("the boot save's boundary carries the Cmds the engine starts", () => {
  type Greeter = { readonly n: number };
  type Hello = { readonly _tag: "hello" };
  type Tick = { readonly _tag: "tick" };
  const tick: Reducer<Greeter, Tick, Hello> = {
    tick: (s) => [{ n: s.n + 1 }, []],
  };
  const greeter = defineMachine({
    types: {
      model: {} as Greeter,
      msg: {} as Tick,
      cmd: {} as Hello,
      ctx: undefined,
    },
    init: (loaded) => [
      loaded === null ? { n: 0 } : { n: loaded.n + 1 },
      [{ _tag: "hello" }],
    ],
    update: tick,
  });

  function storeHolding(held: Greeter | null) {
    const saves: { readonly state: Greeter; readonly args: unknown[] }[] = [];
    const store: Store<Greeter> = {
      load: async () => held,
      save: async (state, ...rest) => {
        saves.push({ state, args: rest });
      },
      migrate: (raw) => raw as Greeter | null,
    };
    return { store, saves };
  }

  it("hands init's Cmds to the boot save of a fresh run, and the handler runs them", async () => {
    const { store, saves } = storeHolding(null);
    const hello: Hello[] = [];
    const rt = await runPromise(greeter, {
      ctx: undefined,
      store,
      interpret: {
        hello: async (cmd) => {
          hello.push(cmd);
        },
      },
    }).ready;
    await rt.stop();

    expect(saves[0]?.args).toEqual([
      undefined,
      { _tag: "init", cmds: [{ _tag: "hello" }] },
    ]);
    expect(hello).toEqual([{ _tag: "hello" }]);
  });

  it("hands none when the run wakes a restored State, because none of them start", async () => {
    const { store, saves } = storeHolding({ n: 5 });
    const hello: Hello[] = [];
    const rt = await runPromise(greeter, {
      ctx: undefined,
      store,
      boot: "restored",
      interpret: {
        hello: async (cmd) => {
          hello.push(cmd);
        },
      },
    }).ready;
    await rt.stop();

    expect(saves[0]?.state).toEqual({ n: 6 });
    expect(saves[0]?.args).toEqual([undefined, { _tag: "init", cmds: [] }]);
    expect(hello).toEqual([]);
  });
});

describe("stores written before the Msg was passed still satisfy the types", () => {
  it("a one-argument save and a two-argument saveFenced are assignable", async () => {
    const saved: Model[] = [];
    const old: Store<Model> = {
      load: async () => null,
      save: async (state: Model) => {
        saved.push(state);
      },
      migrate: (raw) => raw as Model | null,
    };
    const oldFenced: FencedStore<Model> = {
      ...old,
      fenced: true,
      loadFenced: async () => ({ raw: null, version: 0 }),
      saveFenced: async (_state: Model, expectedVersion: number) =>
        expectedVersion + 1,
    };

    for (const engine of ENGINES) {
      const run = await start[engine](old);
      await run.dispatch(send);
      await run.stop();
    }
    expect(saved.map((s) => s._tag)).toEqual([
      "idle",
      "sending",
      "sending",
      "idle",
      "sending",
      "sending",
    ]);
    expect(await oldFenced.saveFenced({ _tag: "idle" }, 4)).toBe(5);
  });
});
