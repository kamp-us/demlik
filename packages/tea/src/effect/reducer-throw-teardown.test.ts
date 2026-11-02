/**
 * A worker whose reducer throws stops by itself (#817, ADR 0033).
 *
 * The host here is the one `docs/how-to/run-many-machines.md` builds: three
 * workers spawned under one parent, each with a busy Sub and an `onError`. One
 * worker's reducer throws. With no call from the host, its Sub closes, it
 * leaves the table and the parent hears `child_stopped`, while the other two
 * keep folding Msgs.
 */

import { Cause, Effect, Exit, Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";
import {
  type ParentMsg,
  type ParentState,
  parent,
} from "../../examples/parent-and-workers";
import { defineMachine, type RuntimeErrorContext, type Sub } from "../index";
import {
  type EffectBootingRuntime,
  type EffectRun,
  type EffectRuntime,
  run,
  spawn,
  tell,
} from "./index";

// === The worker ===

type Beat = Sub<"beat", { readonly on: true }>;
type WorkerMsg =
  | { readonly type: "tick" }
  | { readonly type: "job" }
  | { readonly type: "explode" };
interface WorkerState {
  readonly ticks: number;
  readonly jobs: number;
}

const boom = new Error("worker reducer boom");

const worker = defineMachine({
  types: { model: {} as WorkerState, msg: {} as WorkerMsg, sub: {} as Beat },
  init: (loaded) => [loaded ?? { ticks: 0, jobs: 0 }, []],
  update: {
    tick: (s) => [{ ...s, ticks: s.ticks + 1 }, []],
    job: (s) => [{ ...s, jobs: s.jobs + 1 }, []],
    explode: () => {
      throw boom;
    },
  },
  // Always on: a Sub that keeps sending Msgs for as long as it runs.
  subs: [{ type: "beat", deps: () => ({ on: true as const }) }],
});

// === The host ===

interface Child {
  readonly run: EffectBootingRuntime<WorkerState, WorkerMsg>;
  readonly scope: Scope.Closeable;
}

/** What one worker's run did beside its State. */
interface Seen {
  closes: number;
  readonly phases: string[];
}

const spawnWorker = (
  parentScope: Scope.Scope,
  parentRun: EffectRun<ParentState, ParentMsg>,
  children: Map<string, Child>,
  seen: Map<string, Seen>,
  id: string,
): Effect.Effect<Child> => {
  const mine: Seen = { closes: 0, phases: [] };
  seen.set(id, mine);
  return spawn(parentScope, {
    start: (scope) =>
      Effect.map(
        run(worker, {
          onError: (_error: unknown, context: RuntimeErrorContext) => {
            mine.phases.push(context.phase);
          },
          subscribe: {
            beat: () =>
              Stream.tick("1 millis").pipe(
                Stream.map((): WorkerMsg => ({ type: "tick" })),
                Stream.ensuring(
                  Effect.sync(() => {
                    mine.closes++;
                  }),
                ),
              ),
          },
        }),
        (run): Child => ({ run, scope }),
      ),
    enrol: (child) => Effect.sync(() => children.set(id, child)),
    remove: Effect.sync(() => children.delete(id)),
    notify: tell(parent, parentRun, { type: "child_stopped", id }),
  });
};

/** Wait until `holds()` is true, or fail once the run has had ample time. */
const until = (what: string, holds: () => boolean): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let i = 0; i < 2_000; i++) {
      if (holds()) return;
      yield* Effect.sleep("1 millis");
    }
    return yield* Effect.die(new Error(`never saw: ${what}`));
  });

/** One pass of the fixture, reduced to what must be the same on every pass. */
const onePass = Effect.gen(function* () {
  const parentScope = yield* Scope.make();
  const parentRun = yield* (yield* run(parent, {}).pipe(
    Scope.provide(parentScope),
  )).ready;
  const children = new Map<string, Child>();
  const seen = new Map<string, Seen>();

  const ids = ["a", "b", "c"] as const;
  const runs: Record<string, EffectRuntime<WorkerState, WorkerMsg>> = {};
  for (const id of ids) {
    const child = yield* spawnWorker(
      parentScope,
      parentRun,
      children,
      seen,
      id,
    );
    runs[id] = yield* child.run.ready;
  }
  const runOf = (id: (typeof ids)[number]) =>
    runs[id] as EffectRuntime<WorkerState, WorkerMsg>;
  const seenOf = (id: (typeof ids)[number]) => seen.get(id) as Seen;

  for (const id of ids) yield* runOf(id).dispatch({ type: "job" });

  const thrown = yield* Effect.exit(runOf("b").dispatch({ type: "explode" }));
  const dead = yield* Effect.exit(runOf("b").done());

  // Nothing here stops "b": the reducer throw does it.
  yield* until("b's Sub close", () => seenOf("b").closes === 1);
  yield* until("b leave the table", () => !children.has("b"));
  yield* until(
    "the parent hear child_stopped",
    () => parentRun.getState().stopped.length === 1,
  );

  for (const id of ["a", "c"] as const) {
    for (let i = 0; i < 10; i++) yield* runOf(id).dispatch({ type: "job" });
  }

  const perWorker = <T>(read: (id: (typeof ids)[number]) => T) =>
    Object.fromEntries(ids.map((id) => [id, read(id)]));
  const summary = {
    thrown: Exit.isFailure(thrown) ? Cause.squash(thrown.cause) : "resolved",
    done: Exit.isFailure(dead) ? Cause.squash(dead.cause) : "resolved",
    table: [...children.keys()],
    parent: parentRun.getState(),
    jobs: perWorker((id) => runOf(id).getState().jobs),
    closes: perWorker((id) => seenOf(id).closes),
    reduceReports: perWorker(
      (id) => seenOf(id).phases.filter((p) => p === "reduce").length,
    ),
    // A tick the dead worker's Sub sent between the throw and its close is
    // refused, and its `onError` hears it under "follow-up". Nothing else
    // reaches any sink.
    otherPhases: ids.flatMap((id) =>
      seenOf(id)
        .phases.filter((p) => p !== "reduce" && p !== "follow-up")
        .map((p) => `${id}:${p}`),
    ),
    survivorsHeard: [...seenOf("a").phases, ...seenOf("c").phases],
  };

  yield* Scope.close(parentScope, Exit.void);
  return summary;
});

describe("three workers under one parent, one of whose reducers throws", () => {
  it("the dead worker stops by itself, the parent hears it, and the other two fold on", async () => {
    const summary = await Effect.runPromise(onePass);

    expect(summary).toEqual({
      thrown: boom,
      done: boom,
      table: ["a", "c"],
      parent: { type: "open", stopped: ["b"] },
      jobs: { a: 11, b: 1, c: 11 },
      closes: { a: 0, b: 1, c: 0 },
      reduceReports: { a: 0, b: 1, c: 0 },
      otherPhases: [],
      survivorsHeard: [],
    });
  });

  it("gives the same answer on every pass", async () => {
    const passes = [];
    for (let pass = 0; pass < 3; pass++) {
      passes.push(await Effect.runPromise(onePass));
    }
    expect(passes[1]).toEqual(passes[0]);
    expect(passes[2]).toEqual(passes[0]);
  });
});
