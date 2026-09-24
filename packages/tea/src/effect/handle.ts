/**
 * The Effect engine's run handle (#308, ruling R4.1 of #325). Its members have
 * the Promise engine's names (the shared-handle ruling of #250); only the
 * return types differ. Each member that returns a Promise there returns an
 * Effect here, with a typed error channel a host reads with `Effect.catchTags`.
 * Members that neither wait nor fail — `getState`, `result` and the listener
 * registrations — are the same functions on both engines.
 */

import { Effect } from "effect";
import { type LiveWorkProbe, liveWork } from "../internal/engine/loop";
import type { Port } from "../pure/core";
import type { DispatchSettle, Runtime } from "../runtime-types";
import { exitOf, type Stopped, type StoreFailed } from "./failures";

/**
 * What the Effect engine's `run` yields while boot is in flight. `Err` is the
 * union of the declared failures of the run's hand-written cells: a dispatch
 * whose Cmd's cell fails with one fails with it. Reading State and waiting for
 * quiescence need boot to have run, so they live on the {@link EffectRuntime}
 * that `ready` succeeds with.
 */
export interface EffectBootingRuntime<
  S,
  M extends { type: string },
  E extends { type: string } = never,
  Err = never,
> {
  /**
   * Fold `msg` and run to quiescence, as the Promise engine's `dispatch` does.
   * Fails with `Stopped` once the run is stopping or stopped, `StoreFailed`
   * when the transition's save fails, and a hand-written cell's declared
   * failure when the transition's Cmd fails with one.
   */
  dispatch(
    msg: M,
    opts?: { readonly settle?: DispatchSettle },
  ): Effect.Effect<void, Err | Stopped | StoreFailed>;
  /** `dispatch(msg, { settle: "once" })`: one transition, no follow-up drain. */
  dispatchOnce(msg: M): Effect.Effect<void, Err | Stopped | StoreFailed>;
  /** A zero-arg change notifier, fired after each applied transition. */
  subscribe(listener: () => void): () => void;
  /** A `(msg, state)` hook, fired after each applied transition. */
  observe(observer: (msg: M, state: S) => void): () => void;
  /** Fires once with the initial State — at once if boot already ran. */
  onBoot(handler: (state: S) => void): () => void;
  /** Subscribe to the semantic event of `type` the run's `events` projects. */
  on<K extends E["type"]>(
    type: K,
    handler: (event: Extract<E, { type: K }>) => void,
  ): () => void;
  /** Subscribe to a typed Port. */
  subscribePort<T>(port: Port<T>, listener: (value: T) => void): () => void;
  /** Emit a value on a Port from outside a Cmd handler. */
  emitPort<T>(port: Port<T>, value: T): void;
  /**
   * Succeeds with the booted handle once boot completes. Fails with
   * `StoreFailed` when the saved state could not be restored (`"load"`) or the
   * initial save failed (`"save"`), and with a hand-written cell's declared
   * failure when a boot Cmd fails with one.
   */
  readonly ready: Effect.Effect<EffectRuntime<S, M, E, Err>, Err | StoreFailed>;
  /**
   * Stop the run: drain in-flight work, stop its Subs, flush the final State.
   * Closing the run's Scope does the same.
   */
  stop(): Effect.Effect<void>;
}

/** The Effect engine's booted handle — what `ready` succeeds with. */
export interface EffectRuntime<
  S,
  M extends { type: string },
  E extends { type: string } = never,
  Err = never,
> extends EffectBootingRuntime<S, M, E, Err> {
  /** The current State. Total. */
  getState(): S;
  readonly ready: Effect.Effect<EffectRuntime<S, M, E, Err>, Err | StoreFailed>;
  /** Succeeds once every dispatched Msg and its follow-ups are processed. */
  idle(): Effect.Effect<void>;
  /** The terminal State, or `undefined` while the run is in flight. */
  result(): S | undefined;
  /** Succeeds with the terminal State the first time the run reaches one. */
  done(): Effect.Effect<S>;
}

/** Run a loop call, ending with the typed Exit its rejection maps to. */
function settled<A, Err>(
  call: () => Promise<A>,
): Effect.Effect<A, Err | Stopped | StoreFailed> {
  return Effect.flatten(
    Effect.promise(() =>
      call().then(
        (value) => Effect.succeed(value),
        (error: unknown) => exitOf<Err>(error),
      ),
    ),
  );
}

/** Build the Effect handle over the loop's Promise one. */
export function effectHandle<
  S,
  M extends { type: string },
  E extends { type: string },
  Err,
>(
  loop: Runtime<S, M, E> & LiveWorkProbe,
): EffectRuntime<S, M, E, Err> & LiveWorkProbe {
  const handle: EffectRuntime<S, M, E, Err> & LiveWorkProbe = {
    [liveWork]: loop[liveWork],
    dispatch: (msg, opts) => settled(() => loop.dispatch(msg, opts)),
    dispatchOnce: (msg) => settled(() => loop.dispatchOnce(msg)),
    subscribe: (listener) => loop.subscribe(listener),
    observe: (observer) => loop.observe(observer),
    onBoot: (handler) => loop.onBoot(handler),
    on: (type, handler) => loop.on(type, handler),
    subscribePort: (port, listener) => loop.subscribePort(port, listener),
    emitPort: (port, value) => loop.emitPort(port, value),
    getState: () => loop.getState(),
    result: () => loop.result(),
    // Boot never passes the dispatch gate, so `ready` never fails `Stopped`.
    // Suspended: `handle` is not built yet when this line runs.
    ready: Effect.suspend(() =>
      settled<unknown, Err>(() => loop.ready).pipe(Effect.as(handle)),
    ) as Effect.Effect<EffectRuntime<S, M, E, Err>, Err | StoreFailed>,
    // `idle` rejects only on a livelock, and `done` and `stop` never do: a
    // rejection here is a defect.
    idle: () => Effect.promise(() => loop.idle()),
    done: () => Effect.promise(() => loop.done()),
    stop: () => Effect.promise(() => loop.stop()),
  };
  return handle;
}
