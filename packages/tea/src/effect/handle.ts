/**
 * The Effect engine's run handle (#308, ruling R4.1 of #325). Its members have
 * the Promise engine's names (the shared-handle ruling of #250); only the
 * return types differ. Each member that returns a Promise there returns an
 * Effect here, with a typed error channel a host reads with `Effect.catchTags`.
 * Members that neither wait nor fail — `getState`, `result` and the listener
 * registrations — are the same functions on both engines.
 */

import { Effect } from "effect";
import {
  type InstalledStateRead,
  installedState,
} from "../internal/engine/installed-state";
import {
  type LiveWorkProbe,
  liveWork,
  type Postable,
  post,
} from "../internal/engine/loop";
import type { Port } from "../pure/core";
import type { DispatchSettle, Runtime } from "../runtime-types";
import {
  doneExitOf,
  exitOf,
  type Stopped,
  type StoreFailed,
  type SubFailed,
} from "./failures";

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
  /**
   * A zero-arg change notifier, fired for each applied transition after its
   * save and before its first Cmd's handler starts.
   */
  subscribe(listener: () => void): () => void;
  /** A `(msg, state)` hook, fired after each applied transition's Cmds. */
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
   * Stop the run: drain in-flight work, up to `disposeTimeoutMs`, stop its
   * Subs, flush the final State. `stop()` interrupts every handler still in
   * flight, so the limit is reached only by a handler that cannot be
   * interrupted. Closing the run's Scope stops the run the same way, and
   * `stop()` leaves that Scope open. So for a child under `spawn` the two
   * differ: `stop()` does not take the child out of the host's table or tell
   * the parent. Stop such a child with the `stop` helper.
   */
  stop(): Effect.Effect<void>;
}

/**
 * The Effect engine's booted handle. `ready` on a real run succeeds with an
 * {@link EffectRun}, which is one of these and carries what `tell` asks for.
 */
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
  /**
   * The saved terminal State, or `undefined` while its save is pending or failed.
   * Without a store, answers as soon as State is set. A run a failure closed
   * reads `undefined` here; `done()` says why.
   */
  result(): S | undefined;
  /**
   * Succeeds with the terminal State only once it is saved. When a failure
   * closes the run short of a terminal State, it fails with that failure, for
   * waiting and later callers: a failed terminal save with `StoreFailed`
   * (`operation: "save"`), a Sub failure with `SubFailed`, and a reducer throw
   * under the `stop` strategy with a defect, the thrown value itself. The defect
   * is outside the error channel, so `Effect.catchTags` does not see it and
   * `Effect.catchDefect` or the fiber's `Exit` does. The Msgs already in line
   * fold first, so one of them reaching a terminal State makes that State the
   * answer. A terminal State already saved keeps its answer whatever fails
   * after it. A `stop()` with no failure leaves this waiting. Without a store,
   * answers as soon as State is set.
   */
  done(): Effect.Effect<S, StoreFailed | SubFailed>;
}

/**
 * The handle `run` yields: an {@link EffectBootingRuntime} whose `ready` succeeds
 * with an {@link EffectRun}. It does not compile as `tell`'s argument: wait for
 * `ready`.
 */
export interface EffectBootingRun<
  S,
  M extends { type: string },
  E extends { type: string } = never,
  Err = never,
> extends EffectBootingRuntime<S, M, E, Err> {
  readonly ready: Effect.Effect<EffectRun<S, M, E, Err>, Err | StoreFailed>;
}

/**
 * What an {@link EffectBootingRun}'s `ready` succeeds with: a booted
 * {@link EffectRuntime} that also carries the run's line, which is what `tell`
 * asks for. A spread keeps the line. An object built by hand cannot have one,
 * because tea does not export its key, so an {@link EffectRuntime} that is not one
 * of these does not compile as `tell`'s argument. It fits anywhere an
 * `EffectRuntime` is asked for.
 */
export interface EffectRun<
  S,
  M extends { type: string },
  E extends { type: string } = never,
  Err = never,
> extends EffectRuntime<S, M, E, Err>,
    Postable<S, M> {
  readonly ready: Effect.Effect<EffectRun<S, M, E, Err>, Err | StoreFailed>;
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
  loop: Runtime<S, M, E> &
    LiveWorkProbe &
    Postable<S, M> &
    InstalledStateRead<S>,
): EffectRun<S, M, E, Err> & LiveWorkProbe & InstalledStateRead<S> {
  const handle: EffectRun<S, M, E, Err> &
    LiveWorkProbe &
    InstalledStateRead<S> = {
    [liveWork]: loop[liveWork],
    [post]: loop[post],
    [installedState]: loop[installedState],
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
    ) as Effect.Effect<EffectRun<S, M, E, Err>, Err | StoreFailed>,
    // `idle` rejects only on a livelock, and `stop` never does.
    idle: () => Effect.promise(() => loop.idle()),
    done: () =>
      Effect.flatten(
        Effect.promise(() =>
          loop.done().then((state) => Effect.succeed(state), doneExitOf),
        ),
      ),
    stop: () => Effect.promise(() => loop.stop()),
  };
  return handle;
}
