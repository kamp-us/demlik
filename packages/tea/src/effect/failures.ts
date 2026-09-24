/**
 * The Effect engine's typed failures (#308, ruling R4.1 of #325), and the edge
 * that turns what the shared loop rejects with into them.
 *
 * The loop is engine-neutral: it rejects a dispatch with whatever was thrown.
 * Two throws it cannot tell apart from a bug — a hand-written cell's declared
 * failure and a store's failed save — are wrapped here on the way in, so the
 * edge can read them on the way out. The wrappers never reach the caller: a
 * handle verb fails with the typed value, and the `onError` sink is handed the
 * value it was always handed.
 */

import { Data, Exit } from "effect";
import {
  type ExtensionFactory,
  RuntimeStoppedError,
} from "../internal/engine/loop";
import {
  DispatchDiscardedError,
  type Store,
  StoreRefusedError,
} from "../runtime-types";

/**
 * A dispatch the run refused because it is stopping or has stopped. The Msg
 * was never folded.
 *
 * `when` is `"stopping"` for a Msg that arrived while `stop()` (or a closing
 * Scope) drained the run's in-flight work, and `"stopped"` once it had.
 */
export class Stopped extends Data.TaggedError("Stopped")<{
  readonly msgType: string;
  readonly when: "stopping" | "stopped";
}> {
  override get message(): string {
    return (
      `@demlik/tea: Msg "${this.msgType}" was refused — the run is ` +
      `${this.when}.`
    );
  }
}

/**
 * The run's store failed. `operation` is `"load"` when the saved state could
 * not be restored at boot — `cause` is then the `StoreRefusedError` that says
 * why — and `"save"` when a transition's save threw, a fenced store's
 * `StoreConflictError` included; `cause` is then the store's own throw.
 */
export class StoreFailed extends Data.TaggedError("StoreFailed")<{
  readonly operation: "load" | "save";
  readonly cause: unknown;
}> {
  override get message(): string {
    return `@demlik/tea: store ${this.operation} failed.`;
  }
}

/** A hand-written cell's declared failure, on its way through the loop. */
export class CellFailure {
  constructor(readonly failure: unknown) {}
}

/** A store's failed save, on its way through the loop. */
class SaveFailure {
  constructor(readonly cause: unknown) {}
}

/** What was thrown, with the edge's wrapper taken off. */
export function unwrapped(error: unknown): unknown {
  if (error instanceof CellFailure) return error.failure;
  if (error instanceof SaveFailure) return error.cause;
  return error;
}

/**
 * The outermost store wrapper: every save that throws is marked as a store
 * failure. Outermost, so it wraps the fenced compare-and-swap too, and its
 * `StoreConflictError` fails as a `StoreFailed`.
 */
export function saveFailures<S, M, C>(): ExtensionFactory<S, M, C> {
  return () => ({
    store: (store: Store<S>): Store<S> => ({
      load: () => store.load(),
      async save(state) {
        try {
          await store.save(state);
        } catch (cause) {
          throw new SaveFailure(cause);
        }
      },
      migrate: (raw) => store.migrate(raw),
    }),
  });
}

/**
 * The Exit a handle verb ends with when the loop rejected with `error`: a
 * typed failure for a refused dispatch, a failed store and a cell's declared
 * failure, and a defect for anything else — a reducer throw, a Msg with no
 * cell, a livelock — which ADR 0011 keeps a contract breach.
 */
export function exitOf<Err>(
  error: unknown,
): Exit.Exit<never, Err | Stopped | StoreFailed> {
  if (error instanceof CellFailure) return Exit.fail(error.failure as Err);
  if (error instanceof SaveFailure) {
    return Exit.fail(
      new StoreFailed({ operation: "save", cause: error.cause }),
    );
  }
  if (error instanceof StoreRefusedError) {
    return Exit.fail(new StoreFailed({ operation: "load", cause: error }));
  }
  if (error instanceof DispatchDiscardedError) {
    return Exit.fail(new Stopped({ msgType: error.msgType, when: "stopping" }));
  }
  if (error instanceof RuntimeStoppedError) {
    return Exit.fail(new Stopped({ msgType: error.msgType, when: "stopped" }));
  }
  return Exit.die(error);
}
