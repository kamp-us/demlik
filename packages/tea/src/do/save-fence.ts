/**
 * @demlik/tea/do — a save's life at the write point, as one state × event table.
 *
 * NOT part of the public `./do` barrel: `doEventSourcedStore` interprets it.
 * The engine gives up on a save at `disposeTimeoutMs` but cannot call it back,
 * so a save that waits inside its store (behind an earlier write, at the
 * transaction) can reach the write point after a later runtime has loaded the
 * same storage and saved its own State. The rule the table keeps: **a save
 * lands only if no later runtime has loaded the log since the save was
 * issued, judged again on every attempt.** Whether the engine gave up on it is
 * not an input; a save the engine abandoned with no later run behind it is
 * still the newest State and lands.
 *
 * The one generation per log (`storage` and the log's meta cell) is the whole
 * check. A load takes the log and advances the generation; a save carries the
 * generation its store held when it was called; the write point compares the
 * two. The table has two events, and a cell is the only place a decision is
 * made: `takeOver` (a later runtime loaded) and `attempt` (the write point is
 * entered). A storage transaction's callback can run more than once, since a
 * conflict retries it, so a save attempts as often as its callback runs, and a
 * takeover between two attempts is a cell, not a state the first attempt left
 * behind.
 *
 * The generation lives in this isolate only: a Durable Object runs one isolate
 * at a time, and the writes of a dead isolate die with it. No cell is written
 * to storage, so a log written before the fence reads unchanged.
 */

import {
  applyCell,
  type ExhaustiveTransitions,
  StoreConflictError,
} from "../index";

/**
 * Where one save is. `issued` has not attempted. `admitted` was allowed to
 * write at its last attempt. `superseded` has seen a later runtime load the log,
 * so its next attempt is refused. `refused` was refused at an attempt, and every
 * attempt after it is refused too.
 */
export type SavePhase =
  | { readonly _tag: "issued" }
  | { readonly _tag: "superseded" }
  | { readonly _tag: "admitted" }
  | { readonly _tag: "refused" };

/** What moves a save: a later runtime took the log, or the write point is entered. */
export type SaveEvent =
  | { readonly _tag: "takeOver" }
  | { readonly _tag: "attempt" };

/** What the interpreter does after a cell. */
export type SaveCmd = { readonly _tag: "write" } | { readonly _tag: "refuse" };

/**
 * The table. An `attempt` always ends in one Cmd: `write` in `issued` and in
 * `admitted`, `refuse` in `superseded` and in `refused`. A `takeOver` moves
 * `issued` and `admitted` to `superseded`, so a write that was admitted and
 * rolled back is refused when its callback runs again.
 */
export const SAVE_FENCE: ExhaustiveTransitions<SavePhase, SaveEvent, SaveCmd> =
  {
    issued: {
      takeOver: () => [{ _tag: "superseded" }, []],
      attempt: () => [{ _tag: "admitted" }, [{ _tag: "write" }]],
    },
    superseded: {
      takeOver: (state) => [state, []],
      attempt: () => [{ _tag: "refused" }, [{ _tag: "refuse" }]],
    },
    admitted: {
      takeOver: () => [{ _tag: "superseded" }, []],
      attempt: (state) => [state, [{ _tag: "write" }]],
    },
    refused: {
      takeOver: (state) => [state, []],
      attempt: (state) => [state, [{ _tag: "refuse" }]],
    },
  };

/** One step of the table: the next phase and the Cmds it owes. PURE. */
export function stepSave(
  phase: SavePhase,
  event: SaveEvent,
): readonly [SavePhase, readonly SaveCmd[]] {
  return applyCell<SavePhase, SaveEvent, SaveCmd>(
    { update: SAVE_FENCE },
    phase,
    event,
  );
}

/** One store's handle on its log's generation. */
export interface SaveFence {
  /** A runtime loads the log: every save issued before this is superseded. */
  takeOver(): void;
  /**
   * A save is called. Returns the check the save makes at its write point,
   * first thing inside the write, on every run of the transaction callback. It
   * throws {@link StoreConflictError} when a later runtime has loaded the log
   * since this call.
   */
  issue(): () => void;
}

const generations = new WeakMap<object, Map<string, number>>();

/**
 * The fence of the log named `log` on `storage`. Stores built on one storage
 * object share each log's generation, so a store built later sees what an
 * earlier one holds. A store holds the generation current when it was built
 * until it loads.
 */
export function saveFence(storage: object, log: string): SaveFence {
  const current = (): number => generations.get(storage)?.get(log) ?? 0;
  let held = current();
  return {
    takeOver() {
      const logs = generations.get(storage) ?? new Map<string, number>();
      generations.set(storage, logs);
      held = current() + 1;
      logs.set(log, held);
    },
    issue() {
      const issuedUnder = held;
      let phase: SavePhase = { _tag: "issued" };
      return () => {
        if (current() !== issuedUnder) {
          phase = stepSave(phase, { _tag: "takeOver" })[0];
        }
        const [next, cmds] = stepSave(phase, { _tag: "attempt" });
        phase = next;
        for (const cmd of cmds) {
          (
            ({
              write: () => undefined,
              refuse: () => {
                throw new StoreConflictError(issuedUnder, current());
              },
            }) satisfies Record<SaveCmd["_tag"], () => void>
          )[cmd._tag]();
        }
      };
    },
  };
}
