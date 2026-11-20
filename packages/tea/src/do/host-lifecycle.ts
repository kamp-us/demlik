/**
 * @demlik/tea/do — the agent host's lifecycle, as one state × message table.
 *
 * `createAgentHost` interprets it. The host's whole life is the four phases
 * below and the five messages that move between them, so a build that settles
 * after it was reset and a `runtime()` that arrives mid-teardown each have one
 * cell, and `ExhaustiveTransitions` makes a missing cell a compile error. The
 * cells are pure: every value a cell may keep (the next build's record, the
 * promise a teardown settles) arrives on the message, made by the interpreter
 * before it sends, and every effect leaves as a Cmd.
 *
 * `reset()` is a test and lifecycle seam for one caller at a time, so an
 * overlap is an illegal state and the table refuses it: a `reset()` while a
 * teardown is in flight, a `reset()` from inside `run()`, and a `runtime()`
 * while a teardown is in flight each leave the phase as it was and answer with a
 * `refuse` Cmd, which the interpreter throws as a {@link HostOverlapError}.
 */

import { applyCell, type ExhaustiveTransitions } from "../index";

/** A promise with its settle functions held beside it. */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

/** Make a {@link Deferred}. */
export function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/**
 * Thrown by `createAgentHost` when a call overlaps a lifecycle step that has to
 * finish first: a `reset()` while another `reset()` is still stopping the run, a
 * `reset()` from inside `run()`, or a `runtime()` while a `reset()` is still
 * stopping the run. `reset()` is a test and lifecycle seam for one caller at a
 * time, so no handler can do anything useful with the overlap: await the first
 * call before making the next. To stop a run from production code, dispatch
 * `agentCancelMsg` into `await host.runtime()`.
 */
export class HostOverlapError extends Error {
  override readonly name = "HostOverlapError";
  readonly _tag = "HostOverlapError" as const;
  constructor(
    public readonly call: "reset" | "runtime",
    public readonly during: "teardown" | "run",
  ) {
    super(
      `@demlik/tea: createAgentHost().${call}() was called while ` +
        (during === "teardown"
          ? "a reset() was still stopping the run"
          : "the host was still starting the run, before run() returned its handle") +
        `. reset() is a test and lifecycle seam for one caller at a time: ` +
        `await it before the next call. To stop a run, dispatch ` +
        `agentCancelMsg into \`await host.runtime()\`.`,
    );
  }
}

/**
 * Where the host is. `building` and `live` hold the one build the next
 * `runtime()` answers from; a `building` whose `handle` is still `null` is
 * inside `run()`. `tearingDown` is the one teardown in flight.
 */
export type HostPhase<B> =
  | { readonly _tag: "empty" }
  | { readonly _tag: "building"; readonly build: B }
  | { readonly _tag: "live"; readonly build: B }
  | { readonly _tag: "tearingDown" };

/** What moves the host. `fresh` and `done` are offered, not owed. */
export type HostMsg<B> =
  | { readonly _tag: "runtime"; readonly fresh: B }
  | { readonly _tag: "reset"; readonly done: Deferred<void> }
  | { readonly _tag: "built"; readonly build: B }
  | { readonly _tag: "failed"; readonly build: B }
  | { readonly _tag: "tornDown" };

/** What the interpreter does after a cell. */
export type HostCmd<B> =
  | { readonly _tag: "begin"; readonly build: B }
  | {
      readonly _tag: "tearDown";
      readonly build: B;
      readonly done: Deferred<void>;
    }
  | {
      readonly _tag: "refuse";
      readonly call: "reset" | "runtime";
      readonly during: "teardown" | "run";
    };

/** The interpreter's build record: the table reads only whether `run` has returned. */
export interface HostBuild {
  readonly handle: unknown;
}

type Table<B extends HostBuild> = ExhaustiveTransitions<
  HostPhase<B>,
  HostMsg<B>,
  HostCmd<B>
>;

/**
 * The table, over the interpreter's build record `B`. Rules every row keeps: one
 * teardown in flight and no overlap with it; a build that settles after it
 * stopped being the host's build changes nothing; a failed build returns the
 * host to `empty`.
 */
export function hostLifecycle<B extends HostBuild>(): Table<B> {
  const tearDown = (
    build: B,
    done: Deferred<void>,
  ): readonly [HostPhase<B>, readonly HostCmd<B>[]] => [
    { _tag: "tearingDown" },
    [{ _tag: "tearDown", build, done }],
  ];
  const refuse = (
    phase: HostPhase<B>,
    call: "reset" | "runtime",
    during: "teardown" | "run",
  ): readonly [HostPhase<B>, readonly HostCmd<B>[]] => [
    phase,
    [{ _tag: "refuse", call, during }],
  ];
  return {
    empty: {
      runtime: (_state, msg) => [
        { _tag: "building", build: msg.fresh },
        [{ _tag: "begin", build: msg.fresh }],
      ],
      reset: (state) => [state, []],
      built: (state) => [state, []],
      failed: (state) => [state, []],
      tornDown: (state) => [state, []],
    },
    building: {
      runtime: (state) => [state, []],
      reset: (state, msg) =>
        state.build.handle === null
          ? refuse(state, "reset", "run")
          : tearDown(state.build, msg.done),
      built: (state, msg) =>
        msg.build === state.build
          ? [{ _tag: "live", build: state.build }, []]
          : [state, []],
      failed: (state, msg) =>
        msg.build === state.build ? [{ _tag: "empty" }, []] : [state, []],
      tornDown: (state) => [state, []],
    },
    live: {
      runtime: (state) => [state, []],
      reset: (state, msg) => tearDown(state.build, msg.done),
      built: (state) => [state, []],
      failed: (state) => [state, []],
      tornDown: (state) => [state, []],
    },
    tearingDown: {
      runtime: (state) => refuse(state, "runtime", "teardown"),
      reset: (state) => refuse(state, "reset", "teardown"),
      built: (state) => [state, []],
      failed: (state) => [state, []],
      tornDown: () => [{ _tag: "empty" }, []],
    },
  };
}

/** One step of the table: the next phase and the Cmds it owes. PURE. */
export function stepLifecycle<B extends HostBuild>(
  table: Table<B>,
  phase: HostPhase<B>,
  msg: HostMsg<B>,
): readonly [HostPhase<B>, readonly HostCmd<B>[]] {
  return applyCell<HostPhase<B>, HostMsg<B>, HostCmd<B>>(
    { update: table },
    phase,
    msg,
  );
}
