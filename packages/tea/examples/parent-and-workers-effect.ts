import {
  type EffectBootingRuntime,
  type EffectRuntime,
  run,
  spawn,
  stop,
  tell,
} from "@demlik/tea/effect";
import { Effect, type Scope } from "effect";
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
 * Start a worker in a child scope of `parentScope` and enrol it in
 * `children`. `stopWorker` stops that worker. Closing the parent's scope
 * stops every worker spawned under it.
 */
export const spawnWorker = (
  parentScope: Scope.Scope,
  parentRun: EffectRuntime<ParentState, ParentMsg>,
  children: Children,
  id: string,
): Effect.Effect<Child> =>
  spawn(parentScope, {
    start: (scope) =>
      Effect.map(run(worker, {}), (run): Child => ({ run, scope })),
    enrol: (child) => Effect.sync(() => children.set(id, child)),
    remove: Effect.sync(() => children.delete(id)),
    notify: tell(parent, parentRun, { type: "child_stopped", id }),
  });

/** Stop one worker. An id not in the table is a no-op. */
export const stopWorker = (
  children: Children,
  id: string,
): Effect.Effect<void> =>
  Effect.suspend(() => {
    const child = children.get(id);
    return child === undefined ? Effect.void : stop(child.scope);
  });
