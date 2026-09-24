import { describeError } from "../../describe-error";
import {
  type Migrated,
  Refusal,
  type Store,
  StoreRefusedError,
} from "../../runtime-types";

/**
 * Read a store's saved state through its `migrate`: the `S` it holds, or `null`
 * when nothing was saved. Throws {@link StoreRefusedError} when `migrate`
 * refuses, and when `load` or `migrate` throws (#316) — the caller then writes
 * nothing, so bytes it could not read are never overwritten. Boot and the work
 * queue both read a store through this.
 */
export async function restore<S>(store: Store<S>): Promise<S | null> {
  let migrated: Migrated<S>;
  try {
    migrated = store.migrate(await store.load());
  } catch (cause) {
    if (cause instanceof StoreRefusedError) throw cause;
    throw new StoreRefusedError(
      `the saved state could not be read (${describeError(cause)})`,
      { cause },
    );
  }
  if (migrated instanceof Refusal) throw new StoreRefusedError(migrated.reason);
  return migrated;
}
