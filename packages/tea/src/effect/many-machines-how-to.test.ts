/**
 * The run-many-machines how-to's gate (#312, ruling R7.1 of #325).
 *
 * The page shows `examples/parent-and-workers.ts` and
 * `examples/parent-and-workers-effect.ts` verbatim. This file drives them: a
 * worker's scope is a child of the parent's, closing it removes the worker's
 * entry and tells the parent, closing the parent stops every worker, and a
 * notice the parent's State has no cell for is dropped instead of failing.
 *
 * It lives under `src/effect/` because it imports `effect`, which only this
 * entry may do.
 */

import { Effect, Exit, Fiber, Scope } from "effect";
import { describe, expect, it, vi } from "vitest";
import { parent } from "../../examples/parent-and-workers";
import {
  type Children,
  spawn,
  stop,
  tell,
} from "../../examples/parent-and-workers-effect";
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
        const a = yield* spawn(parentScope, parentRun, children, "a");
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
        const a = yield* spawn(parentScope, parentRun, children, "a");
        yield* spawn(parentScope, parentRun, children, "b");
        const worker = yield* a.run.ready;

        yield* stop(children, "a");

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
        yield* spawn(parentScope, parentRun, children, "a");
        yield* stop(children, "nope");
        expect([...children.keys()]).toEqual(["a"]);
        yield* Scope.close(parentScope, Exit.void);
      }),
    );
  });

  it("closing the parent's scope stops every worker and empties the table", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { parentScope, parentRun, children } = yield* openParent;
        const a = yield* spawn(parentScope, parentRun, children, "a");
        const b = yield* spawn(parentScope, parentRun, children, "b");
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
        yield* spawn(parentScope, parentRun, children, "a");
        yield* parentRun.dispatch({ type: "close" });

        yield* stop(children, "a");
        yield* parentRun.idle();

        expect(children.size).toBe(0);
        expect(parentRun.getState()).toEqual({ type: "closed", stopped: [] });
        yield* Scope.close(parentScope, Exit.void);
      }),
    );
  });

  it("`tell` succeeds without delivering to a closed parent or a stopped one", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { parentScope, parentRun } = yield* openParent;
        const notice = { type: "child_stopped", id: "a" } as const;

        yield* parentRun.dispatch({ type: "close" });
        yield* tell(parentRun, notice);
        expect(parentRun.getState()).toEqual({ type: "closed", stopped: [] });

        yield* Scope.close(parentScope, Exit.void);
        yield* tell(parentRun, notice);
      }),
    );
  });

  it("`tell` drops a notice the State stopped accepting after the check", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { parentScope, parentRun } = yield* openParent;
        // `close` is queued, not folded, so the check still reads `open`.
        const closing = yield* Effect.forkChild(
          parentRun.dispatch({ type: "close" }),
          { startImmediately: true },
        );
        yield* tell(parentRun, { type: "child_stopped", id: "a" });
        yield* Fiber.await(closing);
        expect(parentRun.getState()).toEqual({ type: "closed", stopped: [] });
        yield* Scope.close(parentScope, Exit.void);
      }),
    );
  });

  it("closing a worker does not wait for the parent to take the notice", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { parentScope, parentRun, children } = yield* openParent;
        yield* spawn(parentScope, parentRun, children, "a");
        let delivered = false;
        parentRun.observe((msg) => {
          if (msg.type === "child_stopped") delivered = true;
        });

        yield* stop(children, "a");

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

describe("the run-many-machines how-to", () => {
  it("the page shows both example files verbatim", async () => {
    await expectPageMirrors(
      new URL("../../docs/how-to/run-many-machines.md", import.meta.url),
      [
        "../../examples/parent-and-workers.ts",
        "../../examples/parent-and-workers-effect.ts",
      ].map((file) => fileMirror(new URL(file, import.meta.url))),
    );
  });
});
