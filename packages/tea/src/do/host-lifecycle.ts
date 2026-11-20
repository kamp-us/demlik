/**
 * @demlik/tea/do — the agent host's lifecycle, as one state × message table.
 *
 * NOT part of the public `./do` barrel: `createAgentHost` interprets it. The
 * host's whole life is the four phases below and the five messages that move
 * between them, so a reset that overlaps a reset, a `runtime()` that arrives
 * while a teardown is still saving, and a build that settles after it was
 * reset each have one cell, and `ExhaustiveTransitions` makes a missing cell a
 * compile error. The cells are pure: every value a cell may keep (the next
 * build's record, a deferred answer) arrives on the message, made by the
 * interpreter before it sends, and every effect leaves as a Cmd.
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
 * Where the host is. `building` and `live` hold the one build the next
 * `runtime()` answers from. `tearingDown` holds the one teardown in flight, and
 * at most one `runtime()` answer that waits for it.
 */
export type HostPhase<B, V> =
  | { readonly _tag: "empty" }
  | { readonly _tag: "building"; readonly build: B }
  | { readonly _tag: "live"; readonly build: B }
  | {
      readonly _tag: "tearingDown";
      readonly done: Deferred<void>;
      readonly queued: Deferred<V> | null;
    };

/** What moves the host. `fresh`, `done` and `queue` are offered, not owed. */
export type HostMsg<B, V> =
  | { readonly _tag: "runtime"; readonly fresh: B; readonly queue: Deferred<V> }
  | { readonly _tag: "reset"; readonly done: Deferred<void> }
  | { readonly _tag: "built"; readonly build: B }
  | { readonly _tag: "failed"; readonly build: B }
  | { readonly _tag: "tornDown"; readonly fresh: B };

/** What the interpreter does after a cell. */
export type HostCmd<B, V> =
  | { readonly _tag: "begin"; readonly build: B }
  | {
      readonly _tag: "tearDown";
      readonly build: B;
      readonly done: Deferred<void>;
    }
  | { readonly _tag: "discard"; readonly queued: Deferred<V> }
  | {
      readonly _tag: "beginFor";
      readonly build: B;
      readonly queued: Deferred<V>;
    };

type Table<B, V> = ExhaustiveTransitions<
  HostPhase<B, V>,
  HostMsg<B, V>,
  HostCmd<B, V>
>;

/**
 * The table, over the interpreter's build record `B` and booted value `V`.
 * Rules every row keeps: one teardown in flight, shared by every `reset()` that
 * overlaps it; a `runtime()` during a teardown waits for it and then builds, so
 * a replacement never runs beside an old run's last save; a `reset()` that
 * overlaps a waiting `runtime()` discards that wait; a build that settles after
 * it stopped being the host's build changes nothing.
 */
export function hostLifecycle<B, V>(): Table<B, V> {
  const tearDown = (
    build: B,
    done: Deferred<void>,
  ): readonly [HostPhase<B, V>, readonly HostCmd<B, V>[]] => [
    { _tag: "tearingDown", done, queued: null },
    [{ _tag: "tearDown", build, done }],
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
      reset: (state, msg) => tearDown(state.build, msg.done),
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
      runtime: (state, msg) =>
        state.queued === null
          ? [{ ...state, queued: msg.queue }, []]
          : [state, []],
      reset: (state) =>
        state.queued === null
          ? [state, []]
          : [
              { ...state, queued: null },
              [{ _tag: "discard", queued: state.queued }],
            ],
      built: (state) => [state, []],
      failed: (state) => [state, []],
      tornDown: (state, msg) =>
        state.queued === null
          ? [{ _tag: "empty" }, []]
          : [
              { _tag: "building", build: msg.fresh },
              [{ _tag: "beginFor", build: msg.fresh, queued: state.queued }],
            ],
    },
  };
}

/** One step of the table: the next phase and the Cmds it owes. PURE. */
export function stepLifecycle<B, V>(
  table: Table<B, V>,
  phase: HostPhase<B, V>,
  msg: HostMsg<B, V>,
): readonly [HostPhase<B, V>, readonly HostCmd<B, V>[]] {
  return applyCell<HostPhase<B, V>, HostMsg<B, V>, HostCmd<B, V>>(
    { update: table },
    phase,
    msg,
  );
}
