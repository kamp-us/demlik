/**
 * `tell` on the Effect engine (#639): it queues and returns, so machines that
 * answer each other from Cmd handlers keep moving. `children.test.ts` holds
 * what `tell` does inside `spawn`'s `notify`; this file holds its own promise.
 */

import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  type LineMsg,
  type LineState,
  line,
  ping,
  type RingChildMsg,
  type RingChildState,
  type RingParentMsg,
  ringChild,
  ringParent,
} from "../__fixtures__/answering-machines";
import { replay, type Store } from "../index";
import { memoryStore } from "../mem";
import {
  type EffectBootingRuntime,
  type EffectRun,
  run,
  spawn,
  stop,
  tell,
} from "./index";

const ROUNDS = 100;

/** A macrotask later: past the default sink's `setTimeout(0)` rethrow. */
const nextMacrotask = Effect.promise(
  () => new Promise((resolve) => setTimeout(resolve, 5)),
);

/** A `line` run in its own scope, with a `wait` handler the test releases. */
const openLine = (store?: Store<LineState>) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const reports: unknown[] = [];
    const entered = yield* Deferred.make<void>();
    const gate = yield* Deferred.make<void>();
    const runtime = yield* (yield* run(line, {
      store,
      onError: (error) => void reports.push(error),
      interpret: {
        wait: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(gate)),
            Effect.as([] as readonly LineMsg[]),
          ),
      },
    }).pipe(Scope.provide(scope))).ready;
    return {
      scope,
      reports,
      entered,
      release: Deferred.succeed(gate, undefined),
      runtime,
    };
  });

// One timeout for the file: the ring test's `done()` limits are 10 seconds each.
describe("tell on the Effect engine", { timeout: 20_000 }, () => {
  it("one parent and three spawned children answering each other from Cmd handlers, 100 round trips each: all finish, and each log replays to the same State", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const parentScope = yield* Scope.make();
        const ids = ["a", "b", "c"];
        const parent = ringParent(ids, ROUNDS);
        const finished = (state: { readonly type: string }) =>
          state.type === "finished";

        interface Child {
          readonly machine: ReturnType<typeof ringChild>;
          readonly run: EffectRun<RingChildState, RingChildMsg>;
          readonly log: RingChildMsg[];
          readonly scope: Scope.Closeable;
        }
        const children = new Map<string, Child>();

        const parentLog: RingParentMsg[] = [];
        const parentRun = yield* (yield* run(parent, {
          terminal: finished,
          interpret: {
            answer_back: (cmd) =>
              Effect.suspend(() => {
                const child = children.get(cmd.id);
                if (child === undefined) return Effect.die(`no ${cmd.id}`);
                return tell(child.machine, child.run, {
                  type: "answer",
                  round: cmd.round,
                });
              }).pipe(Effect.as([] as readonly never[])),
          },
        }).pipe(Scope.provide(parentScope))).ready;
        parentRun.observe((msg) => void parentLog.push(msg));

        const stopNotices: string[] = [];
        for (const id of ids) {
          const machine = ringChild(id, ROUNDS);
          yield* spawn(parentScope, {
            start: (scope) =>
              Effect.gen(function* () {
                const booting = yield* run(machine, {
                  terminal: finished,
                  interpret: {
                    report: (cmd) =>
                      tell(parent, parentRun, {
                        type: "child_result",
                        id: cmd.id,
                        round: cmd.round,
                      }).pipe(Effect.as([] as readonly never[])),
                  },
                });
                const childRun = yield* booting.ready;
                const log: RingChildMsg[] = [];
                childRun.observe((msg) => void log.push(msg));
                return { machine, run: childRun, log, scope } satisfies Child;
              }),
            enrol: (child) => Effect.sync(() => children.set(id, child)),
            remove: Effect.sync(() => children.delete(id)),
            notify: Effect.sync(() => stopNotices.push(id)),
          });
        }

        const all = [...children.values()];
        for (const child of all) {
          expect(yield* tell(child.machine, child.run, { type: "begin" })).toBe(
            "queued",
          );
        }

        const parentFinal = yield* parentRun
          .done()
          .pipe(Effect.timeout("10 seconds"));
        const expected = { a: ROUNDS, b: ROUNDS, c: ROUNDS };
        expect(parentFinal).toEqual({ type: "finished", reports: expected });
        expect(replay(parent, { msgs: parentLog, ctx: {} }).state).toEqual(
          parentFinal,
        );

        for (const child of all) {
          const childFinal = yield* child.run
            .done()
            .pipe(Effect.timeout("10 seconds"));
          expect(childFinal).toEqual({ type: "finished", answered: ROUNDS });
          expect(child.log).toHaveLength(ROUNDS + 1);
          expect(
            replay(child.machine, { msgs: child.log, ctx: {} }).state,
          ).toEqual(childFinal);
          yield* stop(child.scope);
        }
        yield* Effect.promise(() =>
          vi.waitFor(() => expect(stopNotices.sort()).toEqual(ids)),
        );
        yield* Scope.close(parentScope, Exit.void);
      }),
    );
  });

  it("returns before the receiver's step runs: with its handler held, `tell` has answered and the Msg folds once it is released", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { scope, runtime, entered, release } = yield* openLine();
        const held = yield* Effect.forkChild(
          runtime.dispatch({ type: "hold" }),
          { startImmediately: true },
        );
        yield* Deferred.await(entered);

        expect(yield* tell(line, runtime, ping("a"))).toBe("queued");
        yield* nextMacrotask;
        expect(runtime.getState().folded).toEqual([]);

        yield* release;
        yield* Fiber.await(held);
        yield* runtime.idle();
        expect(runtime.getState().folded).toEqual(["a"]);
        yield* Scope.close(scope, Exit.void);
      }),
    );
  });

  it("tells from one sender fold in the order they were sent, behind a held handler", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { scope, runtime, entered, release } = yield* openLine();
        const held = yield* Effect.forkChild(
          runtime.dispatch({ type: "hold" }),
          { startImmediately: true },
        );
        yield* Deferred.await(entered);

        const names = Array.from({ length: 50 }, (_, i) => `n${i}`);
        for (const name of names) yield* tell(line, runtime, ping(name));

        yield* release;
        yield* Fiber.await(held);
        yield* runtime.idle();
        expect(runtime.getState().folded).toEqual(names);
        yield* Scope.close(scope, Exit.void);
      }),
    );
  });

  it("tells from inside one Cmd handler fold in the order the handler sent them", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const receiver = yield* (yield* run(line, {
          interpret: { wait: () => Effect.succeed([] as readonly LineMsg[]) },
        }).pipe(Scope.provide(scope))).ready;
        const names = ["first", "second", "third"];
        const sender = yield* (yield* run(line, {
          interpret: {
            wait: () =>
              Effect.forEach(names, (name) =>
                tell(line, receiver, ping(name)),
              ).pipe(Effect.as([] as readonly LineMsg[])),
          },
        }).pipe(Scope.provide(scope))).ready;

        yield* sender.dispatch({ type: "hold" });
        yield* receiver.idle();

        expect(receiver.getState().folded).toEqual(names);
        yield* Scope.close(scope, Exit.void);
      }),
    );
  });

  it("answers `stopped` for a run that has stopped, and for one that is stopping", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { scope, runtime, entered, release } = yield* openLine();
        yield* Effect.forkChild(runtime.dispatch({ type: "hold" }), {
          startImmediately: true,
        });
        yield* Deferred.await(entered);

        const stopping = yield* Effect.forkChild(runtime.stop(), {
          startImmediately: true,
        });
        expect(yield* tell(line, runtime, ping("while stopping"))).toBe(
          "stopped",
        );

        yield* release;
        yield* Fiber.await(stopping);
        expect(yield* tell(line, runtime, ping("after"))).toBe("stopped");
        expect(runtime.getState().folded).toEqual([]);
        yield* Scope.close(scope, Exit.void);
      }),
    );
  });

  it("answers `stopped` once the run's scope has closed, whatever its State", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { scope, runtime } = yield* openLine();
        yield* runtime.dispatch({ type: "close" });
        yield* Scope.close(scope, Exit.void);
        expect(yield* tell(line, runtime, ping("a"))).toBe("stopped");
      }),
    );
  });

  it("answers `no_cell` when the current State has no cell, and sends nothing", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { scope, runtime, reports } = yield* openLine();
        const seen: string[] = [];
        runtime.observe((msg) => void seen.push(msg.type));
        yield* runtime.dispatch({ type: "close" });

        expect(yield* tell(line, runtime, ping("a"))).toBe("no_cell");
        yield* runtime.idle();

        expect(seen).toEqual(["close"]);
        expect(reports).toEqual([]);
        yield* Scope.close(scope, Exit.void);
      }),
    );
  });

  it("a Msg whose cell is gone by its turn does not end the process when the host passed no `onError`, and nothing is logged", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const scope = yield* Scope.make();
          const runtime = yield* (yield* run(line, {
            interpret: { wait: () => Effect.succeed([] as readonly LineMsg[]) },
          }).pipe(Scope.provide(scope))).ready;
          // `close` is queued, not folded, so the check still reads `open`.
          const closing = yield* Effect.forkChild(
            runtime.dispatch({ type: "close" }),
            { startImmediately: true },
          );
          expect(yield* tell(line, runtime, ping("late"))).toBe("queued");
          yield* Fiber.await(closing);
          yield* runtime.idle();
          // The default sink rethrows on a macrotask: vitest fails on that throw.
          yield* nextMacrotask;

          expect(runtime.getState()).toEqual({ type: "closed", folded: [] });
          yield* Scope.close(scope, Exit.void);
        }),
      );
      expect(warned).not.toHaveBeenCalled();
    } finally {
      warned.mockRestore();
    }
  });

  it("a failed save of the receiver reaches its `onError`, and the sender only ever heard `queued`", async () => {
    const disk = new Error("disk full");
    const inner = memoryStore<LineState>();
    let full = false;
    const store: Store<LineState> = {
      load: () => inner.load(),
      save: async (state) => {
        if (full) throw disk;
        await inner.save(state);
      },
      migrate: (raw) => inner.migrate(raw),
    };
    await Effect.runPromise(
      Effect.gen(function* () {
        const { scope, runtime, reports } = yield* openLine(store);
        full = true;

        expect(yield* tell(line, runtime, ping("a"))).toBe("queued");
        yield* runtime.idle();

        expect(reports).toEqual([disk]);
        full = false;
        yield* Scope.close(scope, Exit.void);
      }),
    );
  });

  it("on a run with no store, the booting handle does not compile and `ready`'s handle queues", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const booting = yield* run(line, {
          interpret: { wait: () => Effect.succeed([] as readonly LineMsg[]) },
        }).pipe(Scope.provide(scope));
        void (() => {
          // @ts-expect-error a booting handle does not compile: wait for `ready`
          tell(line, booting, ping("early"));
        });

        const runtime = yield* booting.ready;
        expect(yield* tell(line, runtime, ping("a"))).toBe("queued");
        yield* runtime.idle();
        expect(runtime.getState().folded).toEqual(["a"]);
        yield* Scope.close(scope, Exit.void);
      }),
    );
  });

  it("on a run whose store is still loading, the booting handle does not compile and answers `no_cell`, and `ready`'s handle queues", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const loading = yield* Deferred.make<void>();
        const inner = memoryStore<LineState>();
        const store: Store<LineState> = {
          load: () =>
            Effect.runPromise(Deferred.await(loading)).then(() => inner.load()),
          save: (state) => inner.save(state),
          migrate: (raw) => inner.migrate(raw),
        };
        const booting = yield* run(line, {
          store,
          interpret: { wait: () => Effect.succeed([] as readonly LineMsg[]) },
        }).pipe(Scope.provide(scope));

        // @ts-expect-error a booting handle does not compile: wait for `ready`
        expect(yield* tell(line, booting, ping("early"))).toBe("no_cell");

        yield* Deferred.succeed(loading, undefined);
        const runtime = yield* booting.ready;
        expect(yield* tell(line, runtime, ping("a"))).toBe("queued");
        yield* runtime.idle();
        expect(runtime.getState().folded).toEqual(["a"]);
        yield* Scope.close(scope, Exit.void);
      }),
    );
  });

  it("dies with a defect on a handle cast past its type", async () => {
    const handBuilt = {} as EffectRun<LineState, LineMsg>;
    const exit = await Effect.runPromiseExit(tell(line, handBuilt, ping("a")));
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toEqual(
      expect.objectContaining({
        message: expect.stringMatching(/run handle from `run`/),
      }),
    );
  });

  it("takes a spread of a real handle, which keeps its line", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { scope, runtime } = yield* openLine();
        expect(yield* tell(line, { ...runtime }, ping("a"))).toBe("queued");
        yield* runtime.idle();
        expect(runtime.getState().folded).toEqual(["a"]);
        yield* Scope.close(scope, Exit.void);
      }),
    );
  });
});

// The handle `tell` takes is the booted one, as on the Promise engine.
declare const booting: EffectBootingRuntime<LineState, LineMsg>;
void (() => {
  // @ts-expect-error a booting handle does not compile: wait for `ready`
  tell(line, booting, ping("a"));
});
