/**
 * @demlik/tea/do — a save's life at the write point, as one state × event table.
 *
 * NOT part of the public `./do` barrel: `doEventSourcedStore` interprets it.
 * The engine gives up on a save at `disposeTimeoutMs` but cannot call it back,
 * so a save that waits inside its store (behind an earlier write, at the
 * transaction) can reach the write point after a later runtime has loaded the
 * same storage and saved its own State. The rule the table keeps: **a save
 * lands only if no later runtime has loaded the log since the save was
 * issued.** Whether the engine gave up on it is not an input; a save the engine
 * abandoned with no later run behind it is still the newest State and lands.
 *
 * The one generation per log (`storage` and the log's meta cell) is the whole
 * check. A load takes the log and advances the generation; a save carries the
 * generation its store held when it was called; the write point compares the
 * two. The table has two events, and a cell is the only place a decision is
 * made: `takeOver` (a later runtime loaded) and `reach` (the write point).
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
 * Where one save is. `issued` waits for its write point. `superseded` is
 * `issued` after a later runtime loaded the log. `admitted` was allowed to
 * write, and `refused` was not; both end the save.
 */
export type SavePhase =
  | { readonly _tag: "issued" }
  | { readonly _tag: "superseded" }
  | { readonly _tag: "admitted" }
  | { readonly _tag: "refused" };

/** What moves a save: a later runtime took the log, or the save reached its write. */
export type SaveEvent =
  | { readonly _tag: "takeOver" }
  | { readonly _tag: "reach" };

/** What the interpreter does after a cell. */
export type SaveCmd = { readonly _tag: "write" } | { readonly _tag: "refuse" };

/**
 * The table. A save that reaches its write point in `issued` writes; in
 * `superseded` it is refused; a save that has ended never writes or refuses
 * again, whatever happens next.
 */
export const SAVE_FENCE: ExhaustiveTransitions<SavePhase, SaveEvent, SaveCmd> =
  {
    issued: {
      takeOver: () => [{ _tag: "superseded" }, []],
      reach: () => [{ _tag: "admitted" }, [{ _tag: "write" }]],
    },
    superseded: {
      takeOver: (state) => [state, []],
      reach: () => [{ _tag: "refused" }, [{ _tag: "refuse" }]],
    },
    admitted: {
      takeOver: (state) => [state, []],
      reach: (state) => [state, []],
    },
    refused: {
      takeOver: (state) => [state, []],
      reach: (state) => [state, []],
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
   * first thing inside the write, which throws {@link StoreConflictError} when
   * a later runtime has loaded the log since this call.
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
        const [next, cmds] = stepSave(phase, { _tag: "reach" });
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
