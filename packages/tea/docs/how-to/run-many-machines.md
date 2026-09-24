# Run many machines under one parent

tea runs one machine per `run`. It has no supervisor, no registry of runs and
no spawn helper, and it will not grow one
([ADR 0022](../../../../.decisions/0022-no-battery-layer-plain-functions.md)).
Elm has none either. A tree of machines is built from two things you already
have: Effect scopes, and `run` from `@demlik/tea/effect`.

This page starts workers under a parent. Each worker runs in a child scope of
the parent's scope, the host keeps a table of live workers by id, and the
parent gets a `child_stopped` Msg when a worker stops. It then names three
mistakes that are easy to make here.

It needs the Effect engine: see
[Run a machine on the Effect engine](./run-on-the-effect-engine.md).

## 1. Write the machines

Both machines are plain tea and import nothing from Effect. The parent uses
the transitions form, so a `closed` parent has no cell for `child_stopped`.

```ts
import { defineMachine } from "@demlik/tea";

/** A child: counts the jobs it has done. */
export interface WorkerState {
  readonly done: number;
}

export type WorkerMsg = { readonly type: "job" };

export const worker = defineMachine({
  types: { model: {} as WorkerState, msg: {} as WorkerMsg },
  init: (loaded) => [loaded ?? { done: 0 }, []],
  update: {
    job: (s) => [{ done: s.done + 1 }, []],
  },
});

/** The parent: lists the children that stopped, until it closes. */
export type ParentState =
  | { readonly type: "open"; readonly stopped: readonly string[] }
  | { readonly type: "closed"; readonly stopped: readonly string[] };

export type ParentMsg =
  | { readonly type: "child_stopped"; readonly id: string }
  | { readonly type: "close" };

export const parent = defineMachine({
  types: { model: {} as ParentState, msg: {} as ParentMsg },
  init: (loaded) => [loaded ?? { type: "open", stopped: [] }, []],
  update: {
    open: {
      child_stopped: (s, m) => [{ ...s, stopped: [...s.stopped, m.id] }, []],
      close: (s) => [{ type: "closed", stopped: s.stopped }, []],
    },
    // A closed parent takes no Msg, so it has no cell for `child_stopped`.
    closed: {},
  },
});
```

## 2. Start each worker in a child scope

This is host code, and it is yours to change.

```ts
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
```

What each piece does:

- **`Scope.fork(parentScope)`** makes the worker's scope a child of the
  parent's. Closing the child stops that one worker. Closing the parent's scope
  closes every child forked from it, so the whole tree stops with it.
- **`run(worker, {}).pipe(Scope.provide(scope))`** puts the worker's run in
  its own scope. When that scope closes, the run stops, as any Effect engine
  run does.
- **The finalizer** removes the worker from the table, then forks `tell(...)`
  with `Effect.forkDetach` and does not wait for it. It is added before the
  run, and a scope runs its finalizers in reverse order, so it runs after the
  worker has stopped.

## 3. Use it

```ts
const program = Effect.gen(function* () {
  const parentScope = yield* Scope.make();
  const parentRun = yield* (yield* run(parent, {}).pipe(
    Scope.provide(parentScope),
  )).ready;
  const children: Children = new Map();

  const a = yield* spawn(parentScope, parentRun, children, "a");
  yield* spawn(parentScope, parentRun, children, "b");
  yield* (yield* a.run.ready).dispatch({ type: "job" });

  // Stops worker "a". The parent soon reads { type: "open", stopped: ["a"] }.
  yield* stop(children, "a");

  // Stops worker "b", then the parent.
  yield* Scope.close(parentScope, Exit.void);
});
```

## Three mistakes to avoid

Phoenix's Tuval app wrote this code by hand and hit each of these.

### Enrol the child and its removal together

If the table entry and the finalizer that removes it are two separate steps,
an interrupt between them leaves an entry for a worker that has stopped.
Anyone who looks up that id gets a dead worker
([phoenix #7898](https://github.com/kamp-us/phoenix/issues/7898)). `spawn` runs
the fork, the finalizer, the run and the table write as one
`Effect.uninterruptible` step, so all of them happen or none do.

### Never wait for the parent on the teardown fiber

The finalizer runs on the fiber that closes the worker's scope. That can be a
parent's Cmd handler that stops a worker. The parent's `dispatch` waits for
that handler to finish, so a finalizer that waited on the parent's `dispatch`
would wait on itself. Fork the notice and let the close return.

### Only send a notice the parent's State accepts

A parent with no cell for `child_stopped` in its current State refuses it. If
the host sends it anyway, the dispatch dies with a `NoCellError` on every
worker stop, from a parent that is working fine. Tuval logged an error line
per spawn this way
([phoenix #8927](https://github.com/kamp-us/phoenix/issues/8927)). `tell` asks
`acceptedTypes(parent, state)` first and sends nothing when the State has no
cell for the notice.

The check alone is not enough. The dispatch lands a moment after the check, so
the State can change in between, and the parent can stop. That is why `tell`
also drops a `NoCellError` and a `Stopped`. Closing the parent's scope hits the
second case every time: the workers stop first, and their notices reach a
parent that is already stopping.

The page's examples are `examples/parent-and-workers.ts` and
`examples/parent-and-workers-effect.ts`.
