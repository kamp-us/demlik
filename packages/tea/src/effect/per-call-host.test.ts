import { Effect, Exit, Scope, Stream } from "effect";
import { vi } from "vitest";
import { type LiveWorkProbe, liveWork } from "../internal/engine/loop";
import {
  type Boot,
  complete,
  machine,
  observeFiber,
  perCallHostTests,
} from "../internal/persistence/per-call-host.fixture";
import { run } from "./index";

// Observe the actual engine fibers through Effect's runtime callbacks, only
// in this test module. No observer or global patch ships in either engine.
vi.mock("effect", async (importOriginal) => {
  const actual = await importOriginal<typeof import("effect")>();
  const { observeFiber } = await import(
    "../internal/persistence/per-call-host.fixture"
  );
  const runForkWith: typeof actual.Effect.runForkWith = (context) => {
    const fork = actual.Effect.runForkWith(context);
    return (effect, options) => {
      const fiber = fork(effect, options);
      observeFiber(fiber);
      return fiber;
    };
  };
  const runPromiseExitWith: typeof actual.Effect.runPromiseExitWith = (
    context,
  ) => {
    const run = actual.Effect.runPromiseExitWith(context);
    return (effect, options) =>
      run(effect, {
        ...options,
        onFiberStart: (fiber) => {
          observeFiber(fiber);
          options?.onFiberStart?.(fiber);
        },
      });
  };
  const runPromise: typeof actual.Effect.runPromise = (effect, options) =>
    actual.Effect.runPromise(effect, {
      ...options,
      onFiberStart: (fiber) => {
        observeFiber(fiber);
        options?.onFiberStart?.(fiber);
      },
    });
  return {
    ...actual,
    Effect: { ...actual.Effect, runForkWith, runPromiseExitWith, runPromise },
  };
});

const settle = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect, { onFiberStart: observeFiber });

const boot: Boot = async (store, options = {}) => {
  const scope = Scope.makeUnsafe();
  const booting = await settle(
    run(machine(options.timer), {
      store,
      disposeTimeoutMs: 40,
      onError: (error) => options.errors?.push(error),
      interpret: {
        complete: (cmd) =>
          Effect.promise(() => (options.handle ?? complete)(cmd)),
      },
      subscribe: {
        deadline: () =>
          options.dispose
            ? Stream.never.pipe(
                Stream.ensuring(Effect.promise(options.dispose)),
              )
            : Stream.empty,
      },
    }).pipe(Scope.provide(scope)),
  );
  const host = await settle(booting.ready);
  return {
    dispatch: (msg, opts) => settle(host.dispatch(msg, opts)),
    getState: () => host.getState(),
    stop: async () => {
      await settle(host.stop());
      await settle(Scope.close(scope, Exit.void));
    },
    live: () => (host as typeof host & LiveWorkProbe)[liveWork](),
  };
};

perCallHostTests("effect", boot);
