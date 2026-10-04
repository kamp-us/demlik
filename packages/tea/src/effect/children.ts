/**
 * Helpers for running child machines under a parent on the Effect engine
 * (#556, ruling R1.1 of #554).
 *
 * tea still runs one machine per `run` and keeps no table of runs (#312). A
 * host that builds a tree of runs keeps its own table, ids and Msg names, and
 * hands the steps that race to these functions: `spawn` starts a child and
 * enrols it as one step, `stop` stops one child, and `tell` sends the parent a
 * notice it may no longer take.
 */

import { Effect, Exit, Scope } from "effect";
import type { Cmd, Machine, Sub } from "../pure/core";
import { acceptedTypes, NoCellError } from "../pure/core";
import type { StoreFailed } from "./failures";
import type { EffectRuntime } from "./handle";

/**
 * Hand `msg` to a run only when its State has a cell for it, and drop it when
 * the run no longer takes it.
 *
 * `machine` is the machine `runtime` runs. The dispatch lands a moment after
 * the check, so a State that changed in between refuses the Msg with a
 * `NoCellError`, and a run that stopped refuses it with `Stopped`. Both mean
 * the run no longer takes the notice, so both are dropped and `tell` succeeds.
 * A failed save stays a `StoreFailed`, and a hand-written cell's declared
 * failure stays that failure.
 *
 * ```ts
 * yield* tell(parent, parentRun, { type: "child_stopped", id });
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
  runtime: EffectRuntime<S, M, E, Err>,
  msg: NoInfer<M>,
): Effect.Effect<void, Err | StoreFailed> =>
  Effect.suspend(() =>
    acceptedTypes(machine, runtime.getState()).includes(msg.type)
      ? runtime.dispatch(msg)
      : Effect.void,
  ).pipe(
    Effect.catchTag("Stopped", () => Effect.void),
    Effect.catchDefect((defect) =>
      defect instanceof NoCellError ? Effect.void : Effect.die(defect),
    ),
  ) as Effect.Effect<void, Err | StoreFailed>;

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
   * for, so it may wait on the parent.
   */
  readonly notify: Effect.Effect<unknown, unknown>;
}

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
