/** Serialized logged-store mutations owned by one engine activation. */
import type { DeliveryId } from "../../pure/core";
import type { LoggedStore, Store } from "../../runtime-types";
import { isLoggedStore, StoreRefusedError } from "../../runtime-types";
import { deliveryIsOwed } from "../persistence/durable-log/format";

/** A failed durable mutation, carried to the engine edge with its original cause. */
export class LogWriteFailure {
  constructor(readonly cause: unknown) {}
}

/** Open the optional logged session without wrapping or altering snapshot stores. */
export function storeSession<S, M, C>(
  store: Store<S> | undefined,
  open: () => boolean,
) {
  if (store === undefined || !isLoggedStore<S, M, C>(store)) return undefined;
  const logged: LoggedStore<S, M, C> = store;
  let tail: Promise<unknown> = Promise.resolve();
  let failed: LogWriteFailure | undefined;
  return {
    async owes(id: DeliveryId) {
      try {
        return await deliveryIsOwed(logged, id);
      } catch (cause) {
        throw new StoreRefusedError("durable ledger could not be read", {
          cause,
        });
      }
    },
    async read() {
      try {
        return await logged.readLog();
      } catch (cause) {
        throw new StoreRefusedError("durable log could not be read", { cause });
      }
    },
    write<T>(use: (store: LoggedStore<S, M, C>) => Promise<T>): Promise<T> {
      const next = tail.then(async () => {
        if (failed) throw failed;
        if (!open()) throw new Error("Durable store session is closed");
        try {
          return await use(logged);
        } catch (cause) {
          failed = new LogWriteFailure(cause);
          throw failed;
        }
      });
      tail = next.catch(() => {});
      return next;
    },
    poisoned: () => failed,
  };
}

/** Invocation-local failure signal used by engine adapters for interrupted work. */
export const handlerFailed: unique symbol = Symbol("tea.handlerFailed");

/** Mark an interrupted handler without turning it into successful void. */
export function failHandler(ctx: unknown): void {
  if (typeof ctx === "object" && ctx !== null)
    (ctx as { [handlerFailed]?: () => void })[handlerFailed]?.();
}
