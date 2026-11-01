/**
 * Helpers for running child machines under a parent on the Effect engine
 * (#556, ruling R1.1 of #554).
 *
 * tea still runs one machine per `run` and keeps no table of runs (#312). A
 * host that builds a tree of runs keeps its own table, ids and Msg names, and
 * hands the steps that race to these functions: `spawn` starts a child and
 * enrols it as one step, `stop` stops one child, and `tell` puts a Msg on a
 * run's line without waiting for it.
 */

import { Effect, Exit, Scope } from "effect";
import type { TellAnswer } from "../internal/engine/loop";
import { tellRun } from "../internal/engine/tell";
import type { Cmd, Machine, Sub } from "../pure/core";
import type { EffectBootingRun } from "./handle";

/**
 * Put `msg` on a run's line and answer at once. The answer means queued, not
 * handled: the receiver's step has not run yet, and any result comes back later
 * as its own Msg. So two machines can tell each other from their Cmd handlers
 * and neither stops. `machine` is the machine `runtime` runs.
 *
 * The answer is `"queued"`, `"stopped"` for a run that is stopping or has
 * stopped, or `"no_cell"` when its current State has no cell for the Msg. Msgs
 * already in line have not folded yet, so a Msg that only a queued one makes
 * acceptable answers `"no_cell"`.
 *
 * `runtime` is what `run` yielded, what its `ready` succeeded with, or a spread of
 * either. Those carry the run's line, and the type asks for it, so an
 * `EffectRuntime` built by hand is a compile error. A handle still booting has no
 * State yet, so it answers `"no_cell"`.
 *
 * `tell` carries no failure in its type. A cast past the handle's type has no line
 * to put a Msg on, and `tell` dies with a defect there.
 *
 * What happens after `"queued"` is the receiver's. Two `tell`s from one sender
 * fold in the order they were sent. A failed save or a cell's failure goes to
 * the receiver's `onError`, never back to the sender. A Msg whose cell is gone
 * by its turn is dropped without a word, and a `stop()` that gives up drops
 * what is still in line and counts it, per Msg type, in its
 * `DrainTimeoutNotice`.
 *
 * Two hand-written waiting `runtime.dispatch(...)` calls into each other, one
 * from each machine's Cmd handler, still stop both machines: `dispatch` waits,
 * and tea has no lock-up detector. Use `tell` there.
 *
 * ```ts
 * const answer = yield* tell(parent, parentRun, { type: "child_stopped", id });
 * ```
 */
export const tell = <
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
  E extends { type: string } = never,
  Err = never,
>(
  machine: Machine<S, M, C, U, Ctx>,
  runtime: EffectBootingRun<S, M, E, Err>,
  msg: NoInfer<M>,
): Effect.Effect<TellAnswer> =>
  Effect.sync(() => tellRun<S, M>(machine, runtime, msg));

/**
 * The host's own steps of a {@link spawn}. The host owns the table of
 * children, their ids and the parent's Msg names; `spawn` owns the order the
 * steps run in and keeps an interrupt from landing between them.
 */
export interface SpawnSteps<A, E = never, R = never> {
  /**
   * Start the child and return what the host keeps for it. It runs with the
   * child's scope provided, so a `run(machine, opts)` in it belongs to that
   * scope, and so does anything else it acquires. `scope` is the same scope,
   * for a host that keeps it to stop the child with `stop`. A failure
   * closes the child's scope, which runs `remove` and `notify`.
   */
  readonly start: (scope: Scope.Closeable) => Effect.Effect<A, E, R>;
  /** Add the started child to the host's table. */
  readonly enrol: (child: A) => Effect.Effect<unknown>;
  /**
   * Take the child out of the host's table. It runs when the child's scope
   * closes, after its run has stopped, whether or not `enrol` ran, so it must
   * be safe on a child the table does not hold.
   */
  readonly remove: Effect.Effect<unknown>;
  /**
   * Say the child stopped, usually a {@link tell} to the parent. It runs
   * after `remove`, on a fiber of its own that the closing scope never waits
   * for, so even a step that does wait cannot hold the close.
   *
   * It cannot fail: nothing reads that fiber, so the step itself handles what
   * its notice can fail with. A `tell` has nothing to handle, and a parent handle
   * built by hand does not compile as its argument. A defect in this step, such
   * as a `tell` on a handle cast past that type, is not observed by `spawn` and
   * ends the fiber unseen.
   */
  readonly notify: Effect.Effect<unknown>;
}

const spawnedScopes = new WeakMap<Scope.Scope, Scope.Closeable>();

/**
 * The child scope `spawn` forked, when `scope` is one: the host's unit of work,
 * so a run inside it that a Sub failure stops closes it, and `remove` and
 * `notify` run. Every other Scope belongs to whoever opened it.
 */
export const spawnedScope = (scope: Scope.Scope): Scope.Closeable | undefined =>
  spawnedScopes.get(scope);

/**
 * Start a child in a scope forked from `parentScope` and enrol it in the
 * host's table, as one uninterruptible step. Stop a child with `stop`,
 * or by closing its scope; closing `parentScope` stops every child spawned
 * under it.
 *
 * What it guarantees, with no guard in host code:
 *
 *   - the table never holds a child whose scope has closed. The fork, the
 *     removal finalizer, `start` and `enrol` all happen or none do, and a
 *     child whose scope closed before `enrol` is removed again;
 *   - closing a child never waits for the parent. `notify` runs on a detached
 *     fiber, so a parent Cmd handler can stop a child;
 *   - `remove` runs after the child's run has stopped.
 *
 * Nothing reads the fiber `notify` runs on, so `spawn` reports no failure of
 * it and `notify` is typed to have none. A `tell` carries no failure, and a
 * failed save of the parent reaches the parent's own `onError`. A defect in
 * `notify`, such as a `tell` on a handle cast past its type, ends that fiber
 * unseen.
 *
 * `child.run.stop()` is not one of the two ways to stop a child. It stops the
 * run and leaves the scope open, so the entry stays in the table and the
 * parent is not told.
 *
 * ```ts
 * const child = yield* spawn(parentScope, {
 *   start: (scope) =>
 *     Effect.map(run(worker, {}), (run) => ({ run, scope })),
 *   enrol: (child) => Effect.sync(() => children.set(id, child)),
 *   remove: Effect.sync(() => children.delete(id)),
 *   notify: tell(parent, parentRun, { type: "child_stopped", id }),
 * });
 * ```
 */
export const spawn = <A, E = never, R = never>(
  parentScope: Scope.Scope,
  steps: SpawnSteps<A, E, R>,
): Effect.Effect<A, E, Exclude<R, Scope.Scope>> =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      const scope = yield* Scope.fork(parentScope);
      spawnedScopes.set(scope, scope);
      // Added before `start`, so it runs after everything `start` put in the
      // scope has been released, the child's run included.
      yield* Scope.addFinalizer(
        scope,
        Effect.andThen(steps.remove, Effect.forkDetach(steps.notify)),
      );
      const child = yield* steps.start(scope).pipe(
        Scope.provide(scope),
        Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
      );
      yield* steps.enrol(child);
      // A scope that closed under `start` ran `remove` before `enrol`.
      if (scope.state._tag === "Closed") yield* steps.remove;
      return child;
    }),
  );

/**
 * Stop one child that `spawn` started. `scope` is the child's scope,
 * the one its `start` was handed.
 *
 * It closes that scope, so the child's run stops, `remove` takes the entry
 * out of the host's table and `notify` tells the parent. It does not wait for
 * `notify`, so a parent Cmd handler can call it. Stopping a child that has
 * already stopped succeeds and sends no second notice.
 *
 * ```ts
 * yield* stop(child.scope);
 * ```
 */
export const stop = (scope: Scope.Closeable): Effect.Effect<void> =>
  Scope.close(scope, Exit.void);
