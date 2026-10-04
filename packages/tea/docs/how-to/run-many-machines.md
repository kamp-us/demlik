# Run many machines under one parent

tea runs one machine per `run`. It has no supervisor and no registry of runs,
and Elm has none either. A tree of machines is built from Effect scopes, `run`
from `@demlik/tea/effect`, and three helpers from the same entry:
[`spawn`](../reference/effect.md#spawn) starts a child in a scope of its own,
[`stop`](../reference/effect.md#stop) stops one child, and
[`tell`](../reference/effect.md#tell) sends the parent a notice.

This page starts workers under a parent. Each worker runs in a child scope of
the parent's scope, the host keeps a table of live workers by id, and the
parent gets a `child_stopped` Msg when a worker stops. The table, the ids and
the Msg names are yours. The helpers run the steps that race.

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

## 2. Start each worker with `spawn`, and stop it with `stop`

This is host code, and it is yours to change.

```ts
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
```

`spawn` forks a scope from `parentScope` and takes the host's four steps:

- **`start`** starts the child and returns what you keep for it. It runs with
  the child's scope provided, so `run(worker, {})` belongs to that scope and
  stops when it closes. `start` is also handed the scope. Keep it: it is what
  you hand to `stop`.
- **`enrol`** writes the child to your table.
- **`remove`** takes it out again. It runs when the child's scope closes,
  after the worker has stopped.
- **`notify`** runs after `remove`. Here it is `tell(parent, parentRun, msg)`,
  which dispatches `msg` only when the parent's State has a cell for it.

`stop(child.scope)` stops that one worker: its run stops, `remove` takes its
entry out and `notify` tells the parent. The table lookup is yours, so
`stopWorker` does it and then calls `stop`. Closing the parent's scope closes
every child forked from it, so the whole tree stops with it.

## 3. Use it

```ts
const program = Effect.gen(function* () {
  const parentScope = yield* Scope.make();
  const parentRun = yield* (yield* run(parent, {}).pipe(
    Scope.provide(parentScope),
  )).ready;
  const children: Children = new Map();

  const a = yield* spawnWorker(parentScope, parentRun, children, "a");
  yield* spawnWorker(parentScope, parentRun, children, "b");
  yield* (yield* a.run.ready).dispatch({ type: "job" });

  // Stops worker "a". The parent soon reads { type: "open", stopped: ["a"] }.
  yield* stopWorker(children, "a");

  // Stops worker "b", then the parent.
  yield* Scope.close(parentScope, Exit.void);
});
```

## 4. Do your own work between the fork and the run

A host often does more than start a run. This one gives every process its own
`Terminal` service, and its table says whether a process is `starting` or
`running`. That work goes in `start`, ahead of the run.

```ts
import { Cmd, defineMachine } from "@demlik/tea";
import { type EffectRuntime, run, spawn, stop, tell } from "@demlik/tea/effect";
import { Context, Effect, Layer, type Scope } from "effect";
import { z } from "zod";
import { type ParentMsg, type ParentState, parent } from "./parent-and-workers";

/** Write one line to the process's terminal. */
export const writeLine = Cmd.define("write_line", {
  input: z.object({ text: z.string() }),
  ok: z.object({}),
  err: ["closed"],
});

/** A child: counts the lines it wrote. */
export interface ProcessState {
  readonly written: number;
}

export type ProcessMsg = { readonly type: "input"; readonly text: string };

export const proc = defineMachine({
  types: { model: {} as ProcessState, msg: {} as ProcessMsg },
  cmds: [writeLine],
  init: (loaded) => [loaded ?? { written: 0 }, []],
  update: {
    input: (s, m) => [s, [writeLine({ text: m.text })]],
    write_line_ok: (s) => [{ written: s.written + 1 }, []],
    write_line_err: (s) => [s, []],
  },
});

/** One process's terminal. Every process gets its own. */
export class Terminal extends Context.Service<
  Terminal,
  {
    readonly write: (text: string) => Effect.Effect<void, { _tag: "closed" }>;
  }
>()("Terminal") {}

/** Boot one process. Needs a Scope and that process's Terminal. */
export const runProcess = run(proc, {
  interpret: {
    write_line: (cmd) =>
      Effect.gen(function* () {
        const terminal = yield* Terminal;
        yield* terminal.write(cmd.text);
        return {};
      }),
  },
});

/**
 * A child in the host's table. It is `starting` from the moment its scope is
 * forked until its run is up, so a lookup can tell the two apart.
 */
export type Process =
  | { readonly lifecycle: "starting" }
  | {
      readonly lifecycle: "running";
      readonly run: Effect.Success<typeof runProcess>;
      readonly scope: Scope.Closeable;
    };

/** The host's own table of processes, by id. tea keeps none. */
export type Processes = Map<string, Process>;

/**
 * Start a process under the parent with its own `terminal`. The host's work
 * between the fork and the run is in `start`: it marks the process
 * `starting`, then builds the process's services in the child's scope. A
 * build that fails or is interrupted closes that scope, which removes the
 * entry and tells the parent.
 */
export const spawnProcess = <E>(
  parentScope: Scope.Scope,
  parentRun: EffectRuntime<ParentState, ParentMsg>,
  processes: Processes,
  id: string,
  terminal: Layer.Layer<Terminal, E>,
): Effect.Effect<Process, E> =>
  spawn(parentScope, {
    start: (scope) =>
      Effect.gen(function* () {
        processes.set(id, { lifecycle: "starting" });
        const services = yield* Layer.build(terminal);
        const run = yield* Effect.provide(runProcess, services);
        return { lifecycle: "running", run, scope } satisfies Process;
      }),
    enrol: (process) => Effect.sync(() => processes.set(id, process)),
    remove: Effect.sync(() => processes.delete(id)),
    notify: tell(parent, parentRun, { type: "child_stopped", id }),
  });

/** Stop one running process. Any other id is a no-op. */
export const stopProcess = (
  processes: Processes,
  id: string,
): Effect.Effect<void> =>
  Effect.suspend(() => {
    const process = processes.get(id);
    return process?.lifecycle === "running" ? stop(process.scope) : Effect.void;
  });
```

`Layer.build(terminal)` builds the process's services in the child's scope, so
they are released when the process stops. If the build fails, `spawnProcess`
fails with the same error. If it is interrupted, the spawn ends there. Either
way `spawn` closes the child's scope, so `remove` deletes the `starting` entry
and `notify` tells the parent.

## What the helpers guarantee

You do not guard any of these in host code.

- **The table never holds a child whose scope has closed.** `spawn` runs the
  fork, the removal finalizer, `start` and `enrol` as one uninterruptible
  step. An interrupt waits for the step to finish, unless your own `start`
  marks a part of itself interruptible. A child whose scope closed before
  `enrol` is removed again. Tuval wrote these as separate steps and looked up
  dead children
  ([phoenix #7898](https://github.com/kamp-us/phoenix/issues/7898)).
- **Stopping a child never waits for the parent.** `notify` runs on a fiber of
  its own that the closing scope does not wait for. So a parent's Cmd handler
  can call `stop`, even though the parent's `dispatch` waits for that handler.
- **Stopping a child twice is safe.** The second `stop` succeeds and sends no
  second notice.
- **A notice the parent no longer takes is dropped.** `tell` sends nothing
  when the parent's State has no cell for the Msg. It also drops the
  `NoCellError` of a State that changed after the check, and the `Stopped` of
  a parent that stopped. Tuval sent the notice anyway and logged an error per
  spawn ([phoenix #8927](https://github.com/kamp-us/phoenix/issues/8927)).
- **A failed save is still a failure.** `tell` fails with `StoreFailed` when
  the parent's save fails.

Stop a child with `stop`, or by closing its scope. `child.run.stop()` is not
one of them: it stops the run and leaves the scope open, so the entry stays in
your table and the parent is not told.

`remove` also runs for a child that never reached `enrol`, so write it to be
safe on an id the table does not hold. `Map.delete` is.

The page's examples are `examples/parent-and-workers.ts`,
`examples/parent-and-workers-effect.ts` and `examples/process-tree-effect.ts`.
