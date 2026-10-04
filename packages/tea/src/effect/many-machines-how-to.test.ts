/**
 * The run-many-machines how-to's gate (#312, #556).
 *
 * The page shows `examples/parent-and-workers.ts`,
 * `examples/parent-and-workers-effect.ts` and
 * `examples/process-tree-effect.ts` verbatim. This file drives them: a
 * worker's scope is a child of the parent's, closing it removes the worker's
 * entry and tells the parent, closing the parent stops every worker, and a
 * notice the parent's State has no cell for is dropped instead of failing.
 * The process tree does host work between the fork and the run, and an
 * interrupt or a failure there leaves no entry behind. `spawn` and `tell`
 * themselves are tested in `children.test.ts`.
 *
 * It lives under `src/effect/` because it imports `effect`, which only this
 * entry may do.
 */

import { Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect";
import { describe, expect, it, vi } from "vitest";
import { parent } from "../../examples/parent-and-workers";
import {
  type Children,
  spawnWorker,
  stopWorker,
} from "../../examples/parent-and-workers-effect";
import {
  type Processes,
  spawnProcess,
  stopProcess,
  Terminal,
} from "../../examples/process-tree-effect";
import { expectPageMirrors, fileMirror } from "../docs/page-mirrors";
import { run } from "./index";

/** The page's step 3: a parent in its own scope, and an empty table. */
const openParent = Effect.gen(function* () {
  const parentScope = yield* Scope.make();
  const parentRun = yield* (yield* run(parent, {}).pipe(
    Scope.provide(parentScope),
  )).ready;
  const children: Children = new Map();
  return { parentScope, parentRun, children };
});

describe("examples/parent-and-workers-effect.ts", () => {
  it("a spawned worker is in the table and runs in its own scope", async () => {
    const done = await Effect.runPromise(
      Effect.gen(function* () {
        const { parentScope, parentRun, children } = yield* openParent;
        const a = yield* spawnWorker(parentScope, parentRun, children, "a");
        const worker = yield* a.run.ready;
        yield* worker.dispatch({ type: "job" });
        expect([...children.keys()]).toEqual(["a"]);
        expect(children.get("a")).toBe(a);
        const count = worker.getState().done;
        yield* Scope.close(parentScope, Exit.void);
        return count;
      }),
    );
    expect(done).toBe(1);
  });

  it("stopping one worker removes its entry and tells the parent", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { parentScope, parentRun, children } = yield* openParent;
        const a = yield* spawnWorker(parentScope, parentRun, children, "a");
        yield* spawnWorker(parentScope, parentRun, children, "b");
        const worker = yield* a.run.ready;

        yield* stopWorker(children, "a");

        expect([...children.keys()]).toEqual(["b"]);
        const refused = yield* Effect.flip(worker.dispatch({ type: "job" }));
        expect(refused._tag).toBe("Stopped");
        yield* Effect.promise(() =>
          vi.waitFor(() =>
            expect(parentRun.getState()).toEqual({
              type: "open",
              stopped: ["a"],
            }),
          ),
        );
        yield* Scope.close(parentScope, Exit.void);
      }),
    );
  });

  it("stopping an id not in the table does nothing", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { parentScope, parentRun, children } = yield* openParent;
        yield* spawnWorker(parentScope, parentRun, children, "a");
        yield* stopWorker(children, "nope");
        expect([...children.keys()]).toEqual(["a"]);
        yield* Scope.close(parentScope, Exit.void);
      }),
    );
  });

  it("closing the parent's scope stops every worker and empties the table", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { parentScope, parentRun, children } = yield* openParent;
        const a = yield* spawnWorker(parentScope, parentRun, children, "a");
        const b = yield* spawnWorker(parentScope, parentRun, children, "b");
        const workers = [yield* a.run.ready, yield* b.run.ready];

        yield* Scope.close(parentScope, Exit.void);

        expect(children.size).toBe(0);
        for (const worker of workers) {
          const refused = yield* Effect.flip(worker.dispatch({ type: "job" }));
          expect(refused._tag).toBe("Stopped");
        }
      }),
    );
  });

  it("a closed parent has no cell for the notice, so the worker's stop drops it", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { parentScope, parentRun, children } = yield* openParent;
        yield* spawnWorker(parentScope, parentRun, children, "a");
        yield* parentRun.dispatch({ type: "close" });

        yield* stopWorker(children, "a");
        yield* parentRun.idle();

        expect(children.size).toBe(0);
        expect(parentRun.getState()).toEqual({ type: "closed", stopped: [] });
        yield* Scope.close(parentScope, Exit.void);
      }),
    );
  });

  it("closing a worker does not wait for the parent to take the notice", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { parentScope, parentRun, children } = yield* openParent;
        yield* spawnWorker(parentScope, parentRun, children, "a");
        let delivered = false;
        parentRun.observe((msg) => {
          if (msg.type === "child_stopped") delivered = true;
        });

        yield* stopWorker(children, "a");

        // The close returned before the forked notice was folded.
        expect(delivered).toBe(false);
        yield* Effect.promise(() =>
          vi.waitFor(() => expect(delivered).toBe(true)),
        );
        yield* Scope.close(parentScope, Exit.void);
      }),
    );
  });
});

/** A terminal that keeps what was written to it. */
const terminalInto = (lines: string[]) =>
  Layer.succeed(Terminal, {
    write: (text) => Effect.sync(() => void lines.push(text)),
  });

describe("examples/process-tree-effect.ts", () => {
  it("each process writes to its own terminal, and stopping one tells the parent", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { parentScope, parentRun } = yield* openParent;
        const processes: Processes = new Map();
        const lines = { p1: [] as string[], p2: [] as string[] };
        for (const id of ["p1", "p2"] as const) {
          const process = yield* spawnProcess(
            parentScope,
            parentRun,
            processes,
            id,
            terminalInto(lines[id]),
          );
          if (process.lifecycle !== "running") throw new Error("not running");
          const runtime = yield* process.run.ready;
          yield* runtime.dispatch({ type: "input", text: `hello from ${id}` });
          expect(runtime.getState()).toEqual({ written: 1 });
        }
        expect(lines).toEqual({ p1: ["hello from p1"], p2: ["hello from p2"] });
        expect(processes.get("p1")?.lifecycle).toBe("running");

        yield* stopProcess(processes, "p1");

        expect([...processes.keys()]).toEqual(["p2"]);
        yield* Effect.promise(() =>
          vi.waitFor(() =>
            expect(parentRun.getState()).toEqual({
              type: "open",
              stopped: ["p1"],
            }),
          ),
        );
        yield* Scope.close(parentScope, Exit.void);
        expect(processes.size).toBe(0);
      }),
    );
  });

  it("an interrupt while a process's services are built removes its `starting` entry", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { parentScope, parentRun } = yield* openParent;
        const processes: Processes = new Map();
        const building = yield* Deferred.make<void>();
        // A terminal that never finishes opening, and can be interrupted.
        const stuck = Layer.effect(
          Terminal,
          Effect.andThen(
            Deferred.succeed(building, undefined),
            Effect.interruptible(Effect.never),
          ),
        );

        const spawning = yield* Effect.forkChild(
          spawnProcess(parentScope, parentRun, processes, "p1", stuck),
        );
        yield* Deferred.await(building);
        expect(processes.get("p1")).toEqual({ lifecycle: "starting" });

        yield* Fiber.interrupt(spawning);

        expect(processes.size).toBe(0);
        yield* Effect.promise(() =>
          vi.waitFor(() =>
            expect(parentRun.getState()).toEqual({
              type: "open",
              stopped: ["p1"],
            }),
          ),
        );
        yield* Scope.close(parentScope, Exit.void);
      }),
    );
  });

  it("a terminal that fails to open fails the spawn and leaves no entry", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { parentScope, parentRun } = yield* openParent;
        const processes: Processes = new Map();
        const broken = Layer.effect(Terminal, Effect.fail("no pty" as const));

        const failure = yield* Effect.flip(
          spawnProcess(parentScope, parentRun, processes, "p1", broken),
        );

        expect(failure).toBe("no pty");
        expect(processes.size).toBe(0);
        yield* Scope.close(parentScope, Exit.void);
      }),
    );
  });
});

describe("the run-many-machines how-to", () => {
  it("the page shows its example files verbatim", async () => {
    await expectPageMirrors(
      new URL("../../docs/how-to/run-many-machines.md", import.meta.url),
      [
        "../../examples/parent-and-workers.ts",
        "../../examples/parent-and-workers-effect.ts",
        "../../examples/process-tree-effect.ts",
      ].map((file) => fileMirror(new URL(file, import.meta.url))),
    );
  });
});
