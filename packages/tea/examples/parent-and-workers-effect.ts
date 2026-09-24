import { acceptedTypes, NoCellError } from "@demlik/tea";
import {
  type EffectBootingRuntime,
  type EffectRuntime,
  run,
  type StoreFailed,
} from "@demlik/tea/effect";
import { Effect, Exit, Scope } from "effect";
import {
  type ParentMsg,
  type ParentState,
  parent,
  type WorkerMsg,
  type WorkerState,
  worker,
} from "./parent-and-workers";

/** A running child: its handle, and the scope that stops it. */
export interface Child {
  readonly run: EffectBootingRuntime<WorkerState, WorkerMsg>;
  readonly scope: Scope.Closeable;
}

/** The host's own table of live children, by id. tea keeps none. */
export type Children = Map<string, Child>;

/**
 * Hand `msg` to the parent only when its State has a cell for it. The dispatch
 * lands a moment after the check, so a State that changed in between refuses
 * it with a `NoCellError`, and a parent that stopped refuses it with
 * `Stopped`. Both mean the parent no longer takes the notice, so both drop it.
 * A failed save of the parent's State is a real failure, so it stays one.
 */
export const tell = (
  to: EffectRuntime<ParentState, ParentMsg>,
  msg: ParentMsg,
): Effect.Effect<void, StoreFailed> =>
  Effect.suspend(() =>
    acceptedTypes(parent, to.getState()).includes(msg.type)
      ? to.dispatch(msg)
      : Effect.void,
  ).pipe(
    Effect.catchTag("Stopped", () => Effect.void),
    Effect.catchDefect((defect) =>
      defect instanceof NoCellError ? Effect.void : Effect.die(defect),
    ),
  );

/**
 * Start a worker in a child scope of `parentScope` and enrol it in
 * `children`. Closing the child's scope stops that worker. Closing the
 * parent's scope stops every worker spawned under it.
 */
export const spawn = (
  parentScope: Scope.Scope,
  parentRun: EffectRuntime<ParentState, ParentMsg>,
  children: Children,
  id: string,
): Effect.Effect<Child> =>
  // No interrupt lands between the steps below, so there is never a running
  // child without an entry, nor an entry with no finalizer to remove it.
  Effect.uninterruptible(
    Effect.gen(function* () {
      const scope = yield* Scope.fork(parentScope);
      // Added before the run, so it runs after the run has stopped.
      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => children.delete(id)).pipe(
          // Forked and never awaited: this is the child's teardown fiber.
          Effect.andThen(
            Effect.forkDetach(tell(parentRun, { type: "child_stopped", id })),
          ),
        ),
      );
      const child: Child = {
        run: yield* run(worker, {}).pipe(Scope.provide(scope)),
        scope,
      };
      children.set(id, child);
      return child;
    }),
  );

/** Stop one worker by closing its scope. An id not in the table is a no-op. */
export const stop = (children: Children, id: string): Effect.Effect<void> =>
  Effect.suspend(() => {
    const child = children.get(id);
    return child === undefined
      ? Effect.void
      : Scope.close(child.scope, Exit.void);
  });
