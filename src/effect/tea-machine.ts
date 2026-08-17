/**
 * @packageDocumentation
 * Direction 2 — tea → Effect. A running tea `Runtime` as a scoped Effect
 * resource: `Effect.acquireRelease` where acquire boots the runtime and
 * release drains it via `stop()`.
 *
 * Three decided semantics, implemented exactly:
 *   1. A `DispatchDiscardedError` rejection is a QUIET SUCCESS. It means the
 *      runtime was already stopping when the Msg arrived — a shutdown race,
 *      not a caller error. Making every `dispatch` need a catch for the normal
 *      teardown path would be noise.
 *   2. A `QuiescenceTimeoutError` out of a plain `dispatch` routes to the
 *      `defects` stream and the dispatch SUCCEEDS. `dispatch`'s error channel
 *      stays `TeaDispatchError` only; a livelock is an observability fact, not
 *      a per-call failure.
 *   3. Everything else becomes `TeaDispatchError`.
 */

import type { Context, Scope } from "effect";
import { Data, Effect, Layer, Queue, Stream } from "effect";
import type { Cmd, Machine, Sub } from "../pure/core";
import { run } from "../run";
import {
  type CtxArg,
  DispatchDiscardedError,
  type DispatchSettle,
  type OnError,
  QuiescenceTimeoutError,
  type Runtime,
  RuntimeDiscardNotice,
  type RuntimeErrorPhase,
  type Store,
  type Supervision,
} from "../runtime-types";

/** Boot failed — `run(...).ready` rejected. */
export class TeaBootError extends Data.TaggedError("TeaBootError")<{
  readonly cause: unknown;
}> {}

/** A dispatch rejected for a reason that is not a shutdown race. */
export class TeaDispatchError extends Data.TaggedError("TeaDispatchError")<{
  readonly msgType: string;
  readonly cause: unknown;
}> {}

/** `idle()` hit its iteration cap — the machine is livelocking. */
export class TeaQuiescenceError extends Data.TaggedError("TeaQuiescenceError")<{
  readonly cause: unknown;
}> {}

/**
 * One report off tea's `onError` sink, as stream data. `notice` is `true` for
 * the lossy-but-legal teardown facts (`RuntimeDiscardNotice` subclasses), which
 * tea itself treats as warn-only.
 */
export interface TeaDefect {
  readonly phase: RuntimeErrorPhase;
  readonly error: unknown;
  readonly notice: boolean;
}

/** A booted tea runtime, addressed through Effect. */
export interface TeaMachine<S, M extends { type: string }, E = never> {
  /** The current State. Never fails — the runtime is booted by construction. */
  readonly state: Effect.Effect<S>;
  /**
   * Dispatch to quiescence. Fails only with `TeaDispatchError`; a shutdown-race
   * discard succeeds quietly and a quiescence timeout routes to `defects`.
   */
  readonly dispatch: (
    msg: M,
    opts?: { readonly settle?: DispatchSettle },
  ) => Effect.Effect<void, TeaDispatchError>;
  /** Single-step dispatch — follow-ups are left on the tail. */
  readonly dispatchOnce: (msg: M) => Effect.Effect<void, TeaDispatchError>;
  /** Wait for quiescence. Fails with `TeaQuiescenceError` on a livelock. */
  readonly idle: Effect.Effect<void, TeaQuiescenceError>;
  /**
   * Resolves with the terminal State per `run`'s `terminal` predicate. NEVER
   * fails and, with no predicate, never completes — compose with
   * `Effect.timeout` when you need a bound.
   */
  readonly done: Effect.Effect<S>;
  /** State snapshots, current value first. */
  readonly changes: Stream.Stream<S>;
  /** Runtime failures fed from tea's `onError` sink. */
  readonly defects: Stream.Stream<TeaDefect>;
  /** The underlying tea handle, for anything this facade does not cover. */
  readonly runtime: Runtime<S, M, E extends { type: string } ? E : never>;
}

/** `run`'s options, minus the `onError` this module composes with. */
export type TeaRunOptions<S, M extends { type: string }, Ctx> = CtxArg<Ctx> & {
  readonly store?: Store<S>;
  readonly onError?: OnError;
  readonly supervision?: Supervision<S, M>;
  readonly terminal?: (state: S) => boolean;
  readonly disposeTimeoutMs?: number;
};

const DEFAULT_DEFECT_CAPACITY = 256;

/** Extra knobs on `make` beyond what `run` takes. */
export interface TeaMakeOptions {
  /** Sliding capacity for the `defects` queue. Defaults to 256. */
  readonly defectCapacity?: number;
}

/**
 * Boot a tea machine as a scoped Effect resource. The scope owns the runtime:
 * closing it calls `stop()`, which DRAINS the tail (tea never kills).
 */
export function make<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  opts: TeaRunOptions<S, M, Ctx> & TeaMakeOptions,
): Effect.Effect<TeaMachine<S, M>, TeaBootError, Scope.Scope> {
  return Effect.gen(function* () {
    const defectQueue = yield* Queue.sliding<TeaDefect>(
      opts.defectCapacity ?? DEFAULT_DEFECT_CAPACITY,
    );

    const userOnError = opts.onError;
    const onError: OnError = (error, context) => {
      Queue.offerUnsafe(defectQueue, {
        phase: context.phase,
        error,
        notice: error instanceof RuntimeDiscardNotice,
      });
      userOnError?.(error, context);
    };

    const booted = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => run(machine, { ...opts, onError }).ready,
        catch: (cause) => new TeaBootError({ cause }),
      }),
      (rt) => Effect.promise(() => rt.stop()),
    );

    return teaMachineOf(booted, defectQueue);
  });
}

function teaMachineOf<S, M extends { type: string }>(
  rt: Runtime<S, M, never>,
  defectQueue: Queue.Queue<TeaDefect>,
): TeaMachine<S, M> {
  const routeDispatchFailure = (
    msg: M,
    error: unknown,
  ): Effect.Effect<void, TeaDispatchError> => {
    // Decided semantics 1: a shutdown race is a quiet success.
    if (error instanceof DispatchDiscardedError) return Effect.void;
    // Decided semantics 2: a livelock is observability, not a call failure.
    if (error instanceof QuiescenceTimeoutError) {
      return Effect.sync(() => {
        Queue.offerUnsafe(defectQueue, {
          phase: "follow-up",
          error,
          notice: false,
        });
      });
    }
    return Effect.fail(
      new TeaDispatchError({ msgType: msg.type, cause: error }),
    );
  };

  const dispatchWith =
    (fire: (msg: M) => Promise<void>) =>
    (msg: M): Effect.Effect<void, TeaDispatchError> =>
      Effect.flatMap(
        Effect.promise(() =>
          fire(msg).then(
            () => ({ ok: true }) as const,
            (error: unknown) => ({ ok: false, error }) as const,
          ),
        ),
        (outcome) =>
          outcome.ok ? Effect.void : routeDispatchFailure(msg, outcome.error),
      );

  const changes: Stream.Stream<S> = Stream.callback<S>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        Queue.offerUnsafe(queue, rt.getState());
        return rt.subscribe(() => {
          Queue.offerUnsafe(queue, rt.getState());
        });
      }),
      (unsubscribe) => Effect.sync(() => unsubscribe()),
    ),
  );

  return {
    state: Effect.sync(() => rt.getState()),
    dispatch: (msg, dispatchOpts) =>
      dispatchWith((m) => rt.dispatch(m, dispatchOpts))(msg),
    dispatchOnce: dispatchWith((m) => rt.dispatchOnce(m)),
    idle: Effect.tryPromise({
      try: () => rt.idle(),
      catch: (cause) => new TeaQuiescenceError({ cause }),
    }),
    done: Effect.promise(() => rt.done()),
    changes,
    defects: Stream.fromQueue(defectQueue),
    runtime: rt,
  };
}

/** `make` behind a `Layer`, for wiring a tea machine into an Effect app. */
export function layer<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
  I,
>(
  key: Context.Key<I, TeaMachine<S, M>>,
  machine: Machine<S, M, C, U, Ctx>,
  opts: TeaRunOptions<S, M, Ctx> & TeaMakeOptions,
): Layer.Layer<I, TeaBootError> {
  return Layer.effect(key)(make(machine, opts));
}

/**
 * Scoped one-shot: boot, seed, wait for the terminal State, tear down. The
 * value is the terminal State the run produced.
 *
 * `done` never completes without a `terminal` predicate on `opts` — compose
 * with `Effect.timeout` if the machine might not reach one.
 */
export function runToTerminal<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  seed: readonly M[],
  opts: TeaRunOptions<S, M, Ctx> & TeaMakeOptions,
): Effect.Effect<S, TeaBootError | TeaDispatchError> {
  return Effect.scoped(
    Effect.gen(function* () {
      const tea = yield* make(machine, opts);
      for (const msg of seed) yield* tea.dispatch(msg);
      return yield* tea.done;
    }),
  );
}
