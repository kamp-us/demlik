import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import type { Sub } from "../../index";
import { run as promiseRun } from "../../promise";
import { runIn } from "../run-in";

/**
 * One row per engine, so a React test is written once and runs on both.
 *
 * A row builds what a test hands `useMachine` beside the machine: the `run`, an
 * `interpret` cell, a Sub runner. What it returns is typed `never` where the
 * engines' types differ, because the test file is shared and names no `effect`
 * package specifier (`src/entry-points.import-graph.test.ts`). The Effect side's
 * types are pinned where they can be, in `use-machine.test-d.ts`.
 *
 * Where the engines differ for a reason, the difference is a field here and the
 * test asserts it on both, never a `skipIf`.
 */
export interface Engine {
  readonly name: "promise" | "effect";
  /** The engine's `run` as `useMachine` takes it. The same function on every read. */
  readonly run: typeof promiseRun;
  /** `run`, counting the runs started and the runs asked to stop. */
  countedRun(): {
    readonly counts: { started: number; stopped: number };
    readonly counted: typeof promiseRun;
  };
  /** An `interpret` cell that does `work` and sends back what `work` returns. */
  cell(work: () => Promise<unknown>): never;
  /**
   * A Sub runner that is live from its start until its cleanup, and sends nothing.
   * `start` runs when the Sub starts and returns the cleanup.
   */
  live(start: () => () => void): never;
  /** A Sub runner that sends `pick(sub)` as it starts, then stays live. */
  emitting(
    pick: (sub: { readonly deps: { readonly msg: unknown } }) => unknown,
  ): never;
}

function counting(run: typeof promiseRun) {
  return () => {
    const counts = { started: 0, stopped: 0 };
    const counted = ((...args: Parameters<typeof promiseRun>) => {
      counts.started += 1;
      const handle = run(...args);
      const stop = handle.stop;
      handle.stop = () => {
        counts.stopped += 1;
        return stop.call(handle);
      };
      return handle;
    }) as typeof promiseRun;
    return { counts, counted };
  };
}

const promise: Engine = {
  name: "promise",
  run: promiseRun,
  countedRun: counting(promiseRun),
  cell: (work) => work as never,
  live: (start) => (() => start()) as never,
  emitting: (pick) =>
    ((
      sub: Sub & { deps: { msg: unknown } },
      _ctx: unknown,
      dispatch: (msg: unknown) => void,
    ) => {
      dispatch(pick(sub));
      return () => {};
    }) as never,
};

// No Layer: the rows share one runtime that provides nothing, and own nothing to
// dispose.
const effectRun = runIn(
  ManagedRuntime.make(Layer.empty),
) as unknown as typeof promiseRun;

const effect: Engine = {
  name: "effect",
  run: effectRun,
  countedRun: counting(effectRun),
  cell: (work) => (() => Effect.promise(work)) as never,
  live: (start) =>
    (() =>
      Stream.unwrap(
        Effect.sync(() => {
          let cleanup: (() => void) | undefined;
          return Stream.never.pipe(
            Stream.onStart(
              Effect.sync(() => {
                cleanup = start();
              }),
            ),
            Stream.ensuring(Effect.sync(() => cleanup?.())),
          );
        }),
      )) as never,
  emitting: (pick) =>
    ((sub: { deps: { msg: unknown } }) => Stream.make(pick(sub))) as never,
};

/** The engines `useMachine` runs on: the table a React test is run over. */
export const engines: readonly [Engine, Engine] = [promise, effect];
