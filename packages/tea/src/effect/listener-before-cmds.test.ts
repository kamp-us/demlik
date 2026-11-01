/**
 * `subscribe` is the view: it hears a new State after the save and before that
 * State's first Cmd's handler starts, as Elm's `view` never waits on a Cmd
 * (#695). `observe` and the other commit callbacks stay after the Cmds. Both
 * engines share the loop, so each case runs on both.
 */

import { Cause, Effect, Exit, Scope as ScopeModule } from "effect";
import { describe, expect, it } from "vitest";
import { defineMachine, type NoCtx, type Store } from "../index";
import { memoryStore } from "../mem";
import { run as runPromise } from "../promise";
import { type EffectRuntime, run as runEffect } from "./index";

type Model = { readonly phase: "idle" | "working" | "finished" };
type Msg = { readonly type: "go" } | { readonly type: "finish" };
type Work = { readonly type: "work" };

const machine = defineMachine({
  types: {
    model: {} as Model,
    msg: {} as Msg,
    cmd: {} as Work,
    ctx: {} as NoCtx,
  },
  init: (loaded) => [loaded ?? { phase: "idle" }, []],
  update: {
    go: () => [{ phase: "working" }, [{ type: "work" }]],
    finish: () => [{ phase: "finished" }, []],
  },
});

const boom = new Error("handler boom");
const saveBoom = new Error("save boom");

/** What each case arranges for one run. */
interface Setup {
  /** Called when the `work` handler starts; a throw fails the handler. */
  readonly onWork?: () => void;
  /** The save rejects while this holds. */
  readonly failSave?: () => boolean;
}

/** One run on either engine, with its verbs as Promises. */
interface Harness {
  subscribe(listener: () => void): () => void;
  observe(observer: (msg: Msg, state: Model) => void): () => void;
  getState(): Model;
  dispatch(msg: Msg): Promise<void>;
  readonly log: string[];
  readonly errors: { readonly phase: string; readonly error: unknown }[];
  stop(): Promise<void>;
}

function shared(setup: Setup, log: string[], errors: Harness["errors"]) {
  const inner = memoryStore<Model>();
  const store: Store<Model> = {
    load: () => inner.load(),
    save: async (state) => {
      if (setup.failSave?.()) throw saveBoom;
      await inner.save(state);
      log.push(`saved:${state.phase}`);
    },
    migrate: (raw) => inner.migrate(raw),
  };
  const onError = (error: unknown, context: { readonly phase: string }) => {
    errors.push({ phase: context.phase, error });
  };
  return { store, onError };
}

async function settle<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}

const engines: Record<"promise" | "effect", (s: Setup) => Promise<Harness>> = {
  promise: async (setup) => {
    const log: string[] = [];
    const errors: Harness["errors"] = [];
    const rt = await runPromise(machine, {
      ...shared(setup, log, errors),
      interpret: {
        work: async () => {
          log.push("handler");
          setup.onWork?.();
          return { type: "finish" as const };
        },
      },
    }).ready;
    return {
      subscribe: rt.subscribe,
      observe: rt.observe,
      getState: rt.getState,
      dispatch: (msg) => rt.dispatch(msg),
      log,
      errors,
      stop: () => rt.stop(),
    };
  },
  effect: async (setup) => {
    const log: string[] = [];
    const errors: Harness["errors"] = [];
    const scope = await Effect.runPromise(ScopeModule.make());
    const rt = await Effect.runPromise(
      ScopeModule.provide(scope)(
        Effect.flatMap(
          runEffect(machine, {
            ...shared(setup, log, errors),
            interpret: {
              work: () =>
                Effect.try({
                  try: () => {
                    log.push("handler");
                    setup.onWork?.();
                    return { type: "finish" as const };
                  },
                  catch: (error) => error as Error,
                }),
            },
          }),
          (booting) => booting.ready,
        ),
      ) as Effect.Effect<EffectRuntime<Model, Msg, never, Error>, Error>,
    );
    return {
      subscribe: rt.subscribe,
      observe: rt.observe,
      getState: rt.getState,
      dispatch: (msg) => settle(rt.dispatch(msg)),
      log,
      errors,
      stop: () => Effect.runPromise(ScopeModule.close(scope, Exit.void)),
    };
  },
};

describe.each(Object.entries(engines))("on the %s engine", (_name, start) => {
  it("tells a listener after the save and before the handler, with the new State", async () => {
    const rt = await start({});
    rt.log.length = 0;
    rt.subscribe(() => rt.log.push(`listener:${rt.getState().phase}`));
    rt.observe((_msg, state) => rt.log.push(`observer:${state.phase}`));

    await rt.dispatch({ type: "go" });

    expect(rt.log).toEqual([
      "saved:working",
      "listener:working",
      "handler",
      "observer:working",
      "saved:finished",
      "listener:finished",
      "observer:finished",
    ]);
    await rt.stop();
  });

  it("calls a listener once per transition, not again at the end of the step", async () => {
    const rt = await start({});
    const heard: string[] = [];
    rt.subscribe(() => heard.push(rt.getState().phase));

    await rt.dispatch({ type: "go" });

    expect(heard).toEqual(["working", "finished"]);
    await rt.stop();
  });

  it("tells a listener nothing about a State whose save failed", async () => {
    let failing = false;
    const rt = await start({ failSave: () => failing });
    const heard: string[] = [];
    const handled: string[] = [];
    rt.subscribe(() => heard.push(rt.getState().phase));
    rt.observe((msg) => handled.push(msg.type));

    failing = true;
    // The Effect engine wraps the store's error in its own `StoreFailed`.
    await expect(rt.dispatch({ type: "go" })).rejects.toBeInstanceOf(Error);

    expect(heard).toEqual([]);
    expect(handled).toEqual([]);
    expect(rt.log).not.toContain("handler");
    failing = false;
    await rt.stop();
  });

  it("has told a listener by the time a throwing handler rejects the dispatch", async () => {
    const rt = await start({
      onWork: () => {
        throw boom;
      },
    });
    const heard: string[] = [];
    rt.subscribe(() => heard.push(rt.getState().phase));

    await expect(rt.dispatch({ type: "go" })).rejects.toBe(boom);

    expect(heard).toEqual(["working"]);
    await rt.stop();
  });

  it("reports a throwing listener under `listener` and still runs the step's Cmds", async () => {
    const rt = await start({});
    const bad = new Error("listener boom");
    const later: string[] = [];
    rt.log.length = 0;
    rt.subscribe(() => {
      if (rt.getState().phase === "working") throw bad;
    });
    rt.subscribe(() => later.push(rt.getState().phase));

    await rt.dispatch({ type: "go" });

    expect(rt.errors).toEqual([{ phase: "listener", error: bad }]);
    expect(rt.log).toContain("handler");
    expect(later).toEqual(["working", "finished"]);
    expect(rt.getState()).toEqual({ phase: "finished" });
    await rt.stop();
  });
});
