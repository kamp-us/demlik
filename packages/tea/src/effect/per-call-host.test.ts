import { Effect, Exit, Scope, Stream } from "effect";
import { vi } from "vitest";
import { type LiveWorkProbe, liveWork } from "../internal/engine/loop";
import {
  type AnswerBoot,
  answerHostTests,
  answerMachine,
  type Boot,
  complete,
  type JobBoot,
  type JobHandler,
  jobMachine,
  machine,
  observeFiber,
  owedHostTests,
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

const bootJob: JobBoot = async (store, handle, errors) => {
  const scope = Scope.makeUnsafe();
  const booting = await settle(
    run(jobMachine(), {
      store,
      onError: (error, { phase }) => errors?.push({ error, phase }),
      interpret: {
        job: (cmd, ctx) =>
          Effect.promise(() =>
            handle(cmd, ctx as Parameters<JobHandler>[1]),
          ).pipe(
            Effect.flatMap((answer) => {
              if (answer === undefined) return Effect.void;
              if (answer._tag === "Ok") return Effect.succeed(answer.value);
              if (answer._tag === "Err") return Effect.fail(answer.error);
              return Effect.succeed(answer);
            }),
          ),
      },
    }).pipe(Scope.provide(scope)),
  );
  const host = await settle(booting.ready);
  return {
    dispatch: (msg) => settle(host.dispatch(msg)),
    getState: () => host.getState(),
    stop: async () => {
      await settle(host.stop());
      await settle(Scope.close(scope, Exit.void));
    },
    live: () => (host as typeof host & LiveWorkProbe)[liveWork](),
  };
};

owedHostTests("effect", bootJob);

const bootAnswer: AnswerBoot = async (store, handle, reject) => {
  const scope = Scope.makeUnsafe();
  const booting = await settle(
    run(answerMachine(reject), {
      store,
      onError: () => {},
      interpret: {
        job: (cmd, ctx) =>
          Effect.promise(() =>
            handle(cmd, ctx as Parameters<JobHandler>[1]),
          ).pipe(
            Effect.flatMap((answer) => {
              if (answer === undefined) return Effect.void;
              if (answer._tag === "Ok") return Effect.succeed(answer.value);
              if (answer._tag === "Err") return Effect.fail(answer.error);
              return Effect.succeed(answer);
            }),
          ),
      },
      subscribe: { deadline: () => Stream.empty },
    }).pipe(Scope.provide(scope)),
  );
  const host = await settle(booting.ready).catch(async (error) => {
    await settle(Scope.close(scope, Exit.void));
    throw error;
  });
  return {
    dispatch: (msg, options) => settle(host.dispatch(msg, options)),
    getState: () => host.getState(),
    stop: async () => {
      await settle(host.stop());
      await settle(Scope.close(scope, Exit.void));
    },
    live: () => (host as typeof host & LiveWorkProbe)[liveWork](),
  };
};

answerHostTests("effect", bootAnswer);
