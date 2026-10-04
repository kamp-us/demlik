/**
 * `spawn`, `stop` and `tell`: the helpers a host runs child machines under a
 * parent with (#556, #567).
 *
 * The host here keeps a table of children, hands `spawn` its four steps and
 * stops a child with `stop`. It holds no `Effect.uninterruptible`, no
 * `forkDetach`, no `NoCellError` handling and no `Scope.close` on a child's
 * scope of its own, so every guarantee below is the helpers'.
 */

import { Deferred, Effect, Exit, Fiber, Scope } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  type ParentState,
  parent,
  type WorkerMsg,
  type WorkerState,
  worker,
} from "../../examples/parent-and-workers";
import { defineMachine, type Store } from "../index";
import { memoryStore } from "../mem";
import {
  type EffectBootingRuntime,
  run,
  StoreFailed,
  spawn,
  stop,
  tell,
} from "./index";

// === The host ===

interface Child {
  readonly run: EffectBootingRuntime<WorkerState, WorkerMsg>;
  readonly scope: Scope.Closeable;
}

/** What each child's stop notice ended with, in the order they ended. */
type Notices = Array<{
  readonly id: string;
  readonly exit: Exit.Exit<unknown, unknown>;
}>;

/**
 * A host: its table of children, and a `start` that spawns a worker under
 * `parentScope`. `between` is host work between the child's run and its
 * enrolment, and `before` is host work ahead of the run.
 */
function hostOf(
  parentScope: Scope.Scope,
  notify: (id: string) => Effect.Effect<unknown, unknown> = () => Effect.void,
) {
  const table = new Map<string, Child>();
  const notices: Notices = [];
  const start = <E = never>(
    id: string,
    work: {
      readonly before?: Effect.Effect<unknown, E>;
      readonly between?: Effect.Effect<unknown>;
    } = {},
  ) =>
    spawn(parentScope, {
      start: (scope) =>
        Effect.gen(function* () {
          yield* work.before ?? Effect.void;
          const child: Child = { run: yield* run(worker, {}), scope };
          yield* work.between ?? Effect.void;
          return child;
        }),
      enrol: (child) => Effect.sync(() => table.set(id, child)),
      remove: Effect.sync(() => table.delete(id)),
      notify: Effect.exit(notify(id)).pipe(
        Effect.map((exit) => notices.push({ id, exit })),
      ),
    });
  const stopById = (id: string) =>
    Effect.suspend(() => {
      const child = table.get(id);
      return child === undefined ? Effect.void : stop(child.scope);
    });
  return { table, notices, start, stopById };
}

/** The ids whose worker still takes a job, out of `children`. */
const live = (children: ReadonlyMap<string, Child>) =>
  Effect.gen(function* () {
    const ids: string[] = [];
    for (const [id, child] of children) {
      const exit = yield* Effect.exit(
        Effect.flatMap(child.run.ready, (w) => w.dispatch({ type: "job" })),
      );
      if (Exit.isSuccess(exit)) ids.push(id);
    }
    return ids;
  });

const settled = (assertion: () => void) =>
  Effect.promise(() => vi.waitFor(assertion));

/** An error sink that keeps what it was handed. */
function sink() {
  const reports: unknown[] = [];
  return { reports, onError: (error: unknown) => void reports.push(error) };
}

/** A parent run in its own scope, and what its dispatches reported. */
const openParent = (store?: Store<ParentState>) =>
  Effect.gen(function* () {
    const parentScope = yield* Scope.make();
    const { reports, onError } = sink();
    const parentRun = yield* (yield* run(parent, { store, onError }).pipe(
      Scope.provide(parentScope),
    )).ready;
    const seen: string[] = [];
    parentRun.observe((msg) => void seen.push(msg.type));
    return { parentScope, parentRun, reports, seen };
  });

const stopped = (id: string) => ({ type: "child_stopped", id }) as const;

/** A parent whose `kill` Msg stops a child from its own Cmd handler. */
type BossState = { readonly stopped: readonly string[] };
type BossMsg =
  | { readonly type: "kill"; readonly id: string }
  | { readonly type: "child_stopped"; readonly id: string };
type BossCmd = { readonly type: "close_child"; readonly id: string };
const boss = defineMachine({
  types: {
    model: {} as BossState,
    msg: {} as BossMsg,
    cmd: {} as BossCmd,
  },
  init: (loaded) => [loaded ?? { stopped: [] }, []],
  update: {
    kill: (s, m) => [s, [{ type: "close_child", id: m.id }]],
    child_stopped: (s, m) => [{ stopped: [...s.stopped, m.id] }, []],
  },
});

// === tell ===

describe("tell", () => {
  it("sends nothing when the State has no cell for the Msg", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { parentScope, parentRun, reports, seen } = yield* openParent();
        yield* parentRun.dispatch({ type: "close" });

        yield* tell(parent, parentRun, stopped("a"));

        expect(seen).toEqual(["close"]);
        expect(parentRun.getState()).toEqual({ type: "closed", stopped: [] });
        expect(reports).toEqual([]);
        yield* Scope.close(parentScope, Exit.void);
      }),
    );
  });

  it("delivers a Msg the State has a cell for", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { parentScope, parentRun } = yield* openParent();
        yield* tell(parent, parentRun, stopped("a"));
        expect(parentRun.getState()).toEqual({ type: "open", stopped: ["a"] });
        yield* Scope.close(parentScope, Exit.void);
      }),
    );
  });

  it("drops a `NoCellError` raised after the check", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { parentScope, parentRun } = yield* openParent();
        // `close` is queued, not folded, so the check still reads `open`.
        const closing = yield* Effect.forkChild(
          parentRun.dispatch({ type: "close" }),
          { startImmediately: true },
        );
        yield* tell(parent, parentRun, stopped("a"));
        yield* Fiber.await(closing);
        expect(parentRun.getState()).toEqual({ type: "closed", stopped: [] });
        yield* Scope.close(parentScope, Exit.void);
      }),
    );
  });

  it("drops `Stopped`", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { parentScope, parentRun } = yield* openParent();
        yield* Scope.close(parentScope, Exit.void);
        const refused = yield* Effect.flip(parentRun.dispatch(stopped("a")));
        expect(refused._tag).toBe("Stopped");

        yield* tell(parent, parentRun, stopped("a"));
      }),
    );
  });

  it("still fails with `StoreFailed` when the save fails", async () => {
    const disk = new Error("disk full");
    const inner = memoryStore<ParentState>();
    let full = false;
    const store: Store<ParentState> = {
      load: () => inner.load(),
      save: async (state) => {
        if (full) throw disk;
        await inner.save(state);
      },
      migrate: (raw) => inner.migrate(raw),
    };
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const { parentScope, parentRun } = yield* openParent(store);
        full = true;
        const failure = yield* Effect.flip(
          tell(parent, parentRun, stopped("a")),
        );
        full = false;
        yield* Scope.close(parentScope, Exit.void);
        return failure;
      }),
    );
    expect(failure).toBeInstanceOf(StoreFailed);
    expect(failure).toMatchObject({ operation: "save", cause: disk });
  });
});

// === spawn ===

describe("spawn", () => {
  it("an interrupt during a spawn waits for the whole step: the child runs and is enrolled", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const parentScope = yield* Scope.make();
        const { table, start } = hostOf(parentScope);
        const reached = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();

        // The child's run is up and its entry is not written yet.
        const spawning = yield* Effect.forkChild(
          start("a", {
            between: Effect.andThen(
              Deferred.succeed(reached, undefined),
              Deferred.await(gate),
            ),
          }),
        );
        yield* Deferred.await(reached);
        const interrupting = yield* Effect.forkChild(
          Fiber.interrupt(spawning),
          { startImmediately: true },
        );
        expect(table.size).toBe(0);

        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.await(interrupting);

        expect([...table.keys()]).toEqual(["a"]);
        expect(yield* live(table)).toEqual(["a"]);
        yield* Scope.close(parentScope, Exit.void);
        expect(table.size).toBe(0);
      }),
    );
  });

  it("an interrupt that lands in the host's own interruptible work leaves no entry and no run", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const parentScope = yield* Scope.make();
        const { table, notices, start } = hostOf(parentScope);
        const reached = yield* Deferred.make<void>();

        const spawning = yield* Effect.forkChild(
          start("a", {
            before: Effect.andThen(
              Deferred.succeed(reached, undefined),
              Effect.interruptible(Effect.never),
            ),
          }),
        );
        yield* Deferred.await(reached);
        yield* Fiber.interrupt(spawning);

        expect(table.size).toBe(0);
        yield* settled(() => expect(notices.map((n) => n.id)).toEqual(["a"]));
        yield* Scope.close(parentScope, Exit.void);
      }),
    );
  });

  it("a `start` that fails fails the spawn, closes the child's scope and leaves no entry", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const parentScope = yield* Scope.make();
        const { table, notices, start } = hostOf(parentScope);

        const failure = yield* Effect.flip(
          start("a", { before: Effect.fail("no terminal" as const) }),
        );

        expect(failure).toBe("no terminal");
        expect(table.size).toBe(0);
        yield* settled(() => expect(notices.map((n) => n.id)).toEqual(["a"]));
        yield* Scope.close(parentScope, Exit.void);
      }),
    );
  });

  it("a spawn under a parent scope that already closed enrols nothing", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const parentScope = yield* Scope.make();
        const { table, start } = hostOf(parentScope);
        yield* Scope.close(parentScope, Exit.void);

        const child = yield* start("a");

        expect(table.size).toBe(0);
        expect(yield* live(new Map([["a", child]]))).toEqual([]);
      }),
    );
  });

  it("removes the child only after its run has stopped", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const parentScope = yield* Scope.make();
        const order: string[] = [];
        yield* spawn(parentScope, {
          start: () =>
            Effect.andThen(
              Effect.addFinalizer(() =>
                Effect.sync(() => order.push("run stopped")),
              ),
              run(worker, {}),
            ),
          enrol: () => Effect.sync(() => order.push("enrolled")),
          remove: Effect.sync(() => order.push("removed")),
          notify: Effect.void,
        });

        yield* Scope.close(parentScope, Exit.void);

        expect(order).toEqual(["enrolled", "run stopped", "removed"]);
      }),
    );
  });
});

// === stop ===

describe("stop", () => {
  it("a parent and six children: three are stopped one by one, one from a parent Cmd handler and one twice, and the table and the parent follow each stop", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const parentScope = yield* Scope.make();
        // The notice names the boss's run, which is booted after the host.
        const host = hostOf(parentScope, (id) =>
          tell(boss, bossRun, { type: "child_stopped", id }),
        );
        const bossRun = yield* (yield* run(boss, {
          interpret: { close_child: (cmd) => host.stopById(cmd.id) },
        }).pipe(Scope.provide(parentScope))).ready;
        const ids = ["a", "b", "c", "d", "e", "f"];
        for (const id of ids) yield* host.start(id);
        const all = new Map(host.table);
        const scopeOf = (id: string) => (all.get(id) as Child).scope;

        const stops: ReadonlyArray<readonly [string, Effect.Effect<unknown>]> =
          [
            ["b", stop(scopeOf("b"))],
            // Folds `kill`, runs the handler, and returns once the child
            // stopped: the stop did not wait for the boss to take the notice.
            ["e", Effect.orDie(bossRun.dispatch({ type: "kill", id: "e" }))],
            ["a", Effect.andThen(stop(scopeOf("a")), stop(scopeOf("a")))],
          ];
        const gone: string[] = [];
        for (const [id, stopping] of stops) {
          yield* stopping;
          gone.push(id);
          const left = ids.filter((each) => !gone.includes(each));
          expect([...host.table.keys()]).toEqual(left);
          expect(yield* live(all)).toEqual(left);
          yield* settled(() =>
            expect(bossRun.getState()).toEqual({ stopped: gone }),
          );
          yield* settled(() =>
            expect(host.notices.map((n) => n.id)).toEqual(gone),
          );
        }

        // A stop long after the first one: still one notice for that child.
        yield* stop(scopeOf("a"));
        yield* Scope.close(parentScope, Exit.void);

        expect(host.table.size).toBe(0);
        yield* settled(() => expect(host.notices).toHaveLength(ids.length));
        expect(host.notices.map((n) => n.id).sort()).toEqual(ids);
        expect(host.notices.filter((n) => Exit.isFailure(n.exit))).toEqual([]);
      }),
    );
  });

  it("`child.run.stop()` is not a stop of the child: the run stops, the entry stays and the parent is not told until `stop`", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { parentScope, parentRun } = yield* openParent();
        const { table, notices, start } = hostOf(parentScope, (id) =>
          tell(parent, parentRun, stopped(id)),
        );
        const a = yield* start("a");
        yield* start("b");

        yield* a.run.stop();

        expect(yield* live(table)).toEqual(["b"]);
        expect([...table.keys()]).toEqual(["a", "b"]);
        yield* parentRun.idle();
        expect(notices).toEqual([]);
        expect(parentRun.getState()).toEqual({ type: "open", stopped: [] });

        yield* stop(a.scope);

        expect([...table.keys()]).toEqual(["b"]);
        yield* settled(() =>
          expect(parentRun.getState()).toEqual({
            type: "open",
            stopped: ["a"],
          }),
        );
        expect(notices.map((n) => n.id)).toEqual(["a"]);
        yield* Scope.close(parentScope, Exit.void);
      }),
    );
  });
});

// === A parent and its children, end to end ===

describe("a parent and six children on the helpers", () => {
  it("the table holds only live children after every stop, and no notice dies", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { parentScope, parentRun, reports } = yield* openParent();
        const { table, notices, start, stopById } = hostOf(parentScope, (id) =>
          tell(parent, parentRun, stopped(id)),
        );
        const ids = ["a", "b", "c", "d", "e", "f"];
        for (const id of ids) yield* start(id);
        const all = new Map(table);
        expect(yield* live(all)).toEqual(ids);

        const gone: string[] = [];
        for (const id of ["b", "e", "a"]) {
          yield* stopById(id);
          gone.push(id);
          const left = ids.filter((each) => !gone.includes(each));
          expect([...table.keys()]).toEqual(left);
          expect(yield* live(all)).toEqual(left);
        }
        yield* settled(() =>
          expect(parentRun.getState()).toEqual({
            type: "open",
            stopped: ["b", "e", "a"],
          }),
        );

        yield* Scope.close(parentScope, Exit.void);

        expect(table.size).toBe(0);
        expect(yield* live(all)).toEqual([]);
        yield* settled(() => expect(notices).toHaveLength(ids.length));
        expect(notices.filter((n) => Exit.isFailure(n.exit))).toEqual([]);
        expect(reports).toEqual([]);
      }),
    );
  });

  it("a parent whose every save fails: three children stop, and the handler each `notify` carries is the one place the three failed notices are seen", async () => {
    const disk = new Error("disk full");
    const inner = memoryStore<ParentState>();
    let full = false;
    const store: Store<ParentState> = {
      load: () => inner.load(),
      save: async (state) => {
        if (full) throw disk;
        await inner.save(state);
      },
      migrate: (raw) => inner.migrate(raw),
    };
    await Effect.runPromise(
      Effect.gen(function* () {
        const { parentScope, parentRun, reports } = yield* openParent(store);
        const table = new Map<string, Child>();
        const failed: Array<{ id: string; failure: StoreFailed }> = [];
        const ids = ["a", "b", "c"];
        for (const id of ids) {
          yield* spawn(parentScope, {
            start: (scope) =>
              Effect.map(run(worker, {}), (run): Child => ({ run, scope })),
            enrol: (child) => Effect.sync(() => table.set(id, child)),
            remove: Effect.sync(() => table.delete(id)),
            notify: tell(parent, parentRun, stopped(id)).pipe(
              Effect.catch((failure) =>
                Effect.sync(() => failed.push({ id, failure })),
              ),
            ),
          });
        }
        const all = new Map(table);
        full = true;

        // Each stop succeeds: the failed notice is not the stop's failure.
        for (const id of ids) yield* stop((all.get(id) as Child).scope);

        expect(table.size).toBe(0);
        yield* settled(() => expect(failed).toHaveLength(ids.length));
        expect(failed.map((f) => f.id).sort()).toEqual(ids);
        for (const { failure } of failed) {
          expect(failure).toBeInstanceOf(StoreFailed);
          expect(failure).toMatchObject({ operation: "save", cause: disk });
        }
        // The parent's own sink was handed none of them.
        expect(reports).toEqual([]);
        full = false;
        yield* Scope.close(parentScope, Exit.void);
      }),
    );
  });

  it("a parent whose State has no cell for the notice: a child stops, nothing dies and nothing is logged", async () => {
    const logged = [
      vi.spyOn(console, "error").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
    ];
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const { parentScope, parentRun, reports, seen } = yield* openParent();
          const { table, notices, start, stopById } = hostOf(
            parentScope,
            (id) => tell(parent, parentRun, stopped(id)),
          );
          yield* start("a");
          yield* start("b");
          yield* parentRun.dispatch({ type: "close" });

          yield* stopById("a");

          expect([...table.keys()]).toEqual(["b"]);
          yield* settled(() => expect(notices).toHaveLength(1));
          expect(notices.filter((n) => Exit.isFailure(n.exit))).toEqual([]);
          expect(seen).toEqual(["close"]);
          expect(parentRun.getState()).toEqual({ type: "closed", stopped: [] });
          expect(reports).toEqual([]);
          yield* Scope.close(parentScope, Exit.void);
        }),
      );
      for (const spy of logged) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of logged) spy.mockRestore();
    }
  });
});
