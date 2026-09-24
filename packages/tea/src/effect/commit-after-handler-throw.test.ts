/**
 * Commit callbacks fire even when a Cmd handler throws (#311).
 *
 * A transition installs its State, saves it, reconciles the Subs, runs its
 * Cmds, and then calls the commit callbacks — `subscribe`, `observe`, `on`,
 * `done()` and the telemetry sink. A hand-written Cmd handler that throws (or,
 * on the Effect engine, fails) still fails the dispatch with its own error,
 * but the State it left saved
 * reaches every one of those. Both engines share the loop, so each case runs
 * on both.
 */

import { Cause, Effect, Exit, Scope as ScopeModule, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
  type BootingRuntime,
  defineMachine,
  type NoCtx,
  type Store,
  type Sub,
  type TelemetryEvent,
} from "../index";
import { memoryStore } from "../mem";
import { run as runPromise } from "../promise";
import { type EffectRuntime, run as runEffect } from "./index";

type Model = { readonly armed: boolean; readonly done: boolean };
type Msg = { readonly type: "go"; readonly fail: boolean };
type Work = { readonly type: "work"; readonly fail: boolean };
type Watch = Sub<"watch", { readonly on: true }>;
type Went = { readonly type: "went" };

// `go` installs a terminal State, arms the `watch` Sub and emits one `work`
// Cmd, so a single transition touches every step whose order is pinned here.
const machine = defineMachine({
  types: {
    model: {} as Model,
    msg: {} as Msg,
    cmd: {} as Work,
    sub: {} as Watch,
    ctx: {} as NoCtx,
  },
  init: (loaded) => [loaded ?? { armed: false, done: false }, []],
  update: {
    go: (_s, msg) => [
      { armed: true, done: true },
      [{ type: "work", fail: msg.fail }],
    ],
  },
  subs: [
    {
      type: "watch",
      deps: (s: Model) => (s.armed ? { on: true as const } : null),
    },
  ],
});

const boom = new Error("handler boom");

/** The members each case drives, with the Effect engine's run as Promises. */
type Runtime = Pick<
  Awaited<BootingRuntime<Model, Msg, Went>["ready"]>,
  "subscribe" | "observe" | "on" | "getState"
> & {
  dispatch(msg: Msg): Promise<void>;
  done(): Promise<Model>;
};

/** Run an Effect, rejecting with its failure or defect as it stands. */
async function settle<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}

interface Harness {
  readonly rt: Runtime;
  readonly log: string[];
  readonly telemetry: TelemetryEvent[];
  readonly stop: () => Promise<void>;
}

/** The options both engines take the same way; `log` records each step. */
function shared(log: string[], telemetry: TelemetryEvent[]) {
  const inner = memoryStore<Model>();
  const store: Store<Model> = {
    load: () => inner.load(),
    save: async (state) => {
      log.push("save");
      await inner.save(state);
    },
    migrate: (raw) => inner.migrate(raw),
  };
  return {
    store,
    onError: () => {},
    terminal: (s: Model) => s.done,
    events: (msg: Msg): readonly Went[] =>
      msg.type === "go" ? [{ type: "went" }] : [],
    telemetry: (event: TelemetryEvent) => {
      telemetry.push(event);
    },
  };
}

const engines: Record<"promise" | "effect", () => Promise<Harness>> = {
  promise: async () => {
    const log: string[] = [];
    const telemetry: TelemetryEvent[] = [];
    const rt = await runPromise(machine, {
      ...shared(log, telemetry),
      interpret: {
        work: async (cmd) => {
          log.push("cmd");
          if (cmd.fail) throw boom;
        },
      },
      subscribe: {
        watch: () => {
          log.push("sub");
          return () => {};
        },
      },
    }).ready;
    return { rt, log, telemetry, stop: () => rt.stop() };
  },
  effect: async () => {
    const log: string[] = [];
    const telemetry: TelemetryEvent[] = [];
    const scope = await Effect.runPromise(ScopeModule.make());
    const booted = await Effect.runPromise(
      ScopeModule.provide(scope)(
        Effect.flatMap(
          runEffect(machine, {
            ...shared(log, telemetry),
            interpret: {
              // The cell's failure is typed: the dispatch fails with it.
              work: (cmd) =>
                Effect.sync(() => {
                  log.push("cmd");
                }).pipe(
                  Effect.andThen(cmd.fail ? Effect.fail(boom) : Effect.void),
                ),
            },
            subscribe: {
              watch: () => {
                log.push("sub");
                return Stream.never;
              },
            },
          }),
          (booting) => booting.ready,
        ),
      ) as Effect.Effect<EffectRuntime<Model, Msg, Went, Error>, Error>,
    );
    const rt: Runtime = {
      subscribe: booted.subscribe,
      observe: booted.observe,
      on: booted.on,
      getState: booted.getState,
      dispatch: (msg) => settle(booted.dispatch(msg)),
      done: () => settle(booted.done()),
    };
    return {
      rt,
      log,
      telemetry,
      stop: () => Effect.runPromise(ScopeModule.close(scope, Exit.void)),
    };
  },
};

describe.each(Object.entries(engines))("on the %s engine", (_name, start) => {
  it("orders save → subs → Cmds → commit callbacks when the handler succeeds", async () => {
    const { rt, log, stop } = await start();
    log.length = 0; // drop boot's save
    rt.subscribe(() => log.push("commit"));

    await rt.dispatch({ type: "go", fail: false });

    expect(log).toEqual(["save", "sub", "cmd", "commit"]);
    await stop();
  });

  it("keeps that order when the handler throws, and rejects with its error", async () => {
    const { rt, log, stop } = await start();
    log.length = 0;
    rt.subscribe(() => log.push("commit"));

    await expect(rt.dispatch({ type: "go", fail: true })).rejects.toBe(boom);

    expect(log).toEqual(["save", "sub", "cmd", "commit"]);
    await stop();
  });

  it("hands subscribe and observe the new State when the handler throws", async () => {
    const { rt, stop } = await start();
    const heard: Model[] = [];
    const observed: [string, Model][] = [];
    rt.subscribe(() => heard.push(rt.getState()));
    rt.observe((msg, state) => observed.push([msg.type, state]));

    await expect(rt.dispatch({ type: "go", fail: true })).rejects.toBe(boom);

    const next = { armed: true, done: true };
    expect(heard).toEqual([next]);
    expect(observed).toEqual([["go", next]]);
    await stop();
  });

  it("resolves done() with a terminal State even though the handler threw", async () => {
    const { rt, stop } = await start();
    const done = rt.done();

    await expect(rt.dispatch({ type: "go", fail: true })).rejects.toBe(boom);

    await expect(done).resolves.toEqual({ armed: true, done: true });
    await stop();
  });

  it("hands on() its events and the telemetry sink its event when the handler throws", async () => {
    const { rt, telemetry, stop } = await start();
    const events: Went[] = [];
    rt.on("went", (event) => events.push(event));

    await expect(rt.dispatch({ type: "go", fail: true })).rejects.toBe(boom);

    expect(events).toEqual([{ type: "went" }]);
    expect(telemetry.map((event) => event.msgType)).toEqual(["go"]);
    await stop();
  });
});
