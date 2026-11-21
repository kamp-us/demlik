/// <reference types="@cloudflare/workers-types" />
/**
 * An in-memory `DurableObjectStorage` for the tests of the stores that write to
 * one: `get`, `put` (one key or an entries object), `delete`, `list` and
 * `transaction`. The backing Map is the retained storage: a second storage over
 * the same Map is a new activation that finds what the last one left.
 *
 * A value is structured-cloned on the way in and out, as the platform does. A
 * `transaction` that throws puts back every key it touched, so a write that
 * fails half way leaves the bytes it started with. `failPut` makes a chosen key
 * refuse its write. A fake proves the shape of the writes, not Cloudflare's
 * durability.
 */

export interface FakeDoStorage<V> {
  /** The retained cells. */
  readonly backing: Map<string, V>;
  readonly storage: DurableObjectStorage;
  /** The next `put` of a key `refuses` accepts is rejected with `cause`. */
  failPut(refuses: (key: string) => boolean, cause?: Error): void;
  /** Stop refusing writes. */
  healPut(): void;
  /** Keys written by each `put`, in order, including writes later rolled back. */
  readonly writes: string[];
}

export function fakeDoStorage<V = string>(
  backing: Map<string, V> = new Map(),
): FakeDoStorage<V> {
  let refuses: ((key: string) => boolean) | null = null;
  let cause: Error = new Error("storage refused the write");
  const writes: string[] = [];

  const write = (key: string, value: V): void => {
    writes.push(key);
    if (refuses?.(key)) throw cause;
    backing.set(key, structuredClone(value));
  };

  const cells = {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      return structuredClone(backing.get(key)) as T | undefined;
    },
    async put<T>(
      keyOrEntries: string | Record<string, T>,
      value?: T,
    ): Promise<void> {
      if (typeof keyOrEntries === "string") {
        write(keyOrEntries, value as unknown as V);
        return;
      }
      for (const [key, entry] of Object.entries(keyOrEntries)) {
        write(key, entry as unknown as V);
      }
    },
    async delete(keys: string | readonly string[]): Promise<boolean> {
      let deleted = false;
      for (const key of typeof keys === "string" ? [keys] : keys) {
        deleted = backing.delete(key) || deleted;
      }
      return deleted;
    },
    async list<T = unknown>(options?: {
      readonly prefix?: string;
      readonly start?: string;
      readonly startAfter?: string;
      readonly end?: string;
      readonly limit?: number;
    }): Promise<Map<string, T>> {
      const prefix = options?.prefix ?? "";
      const listed = new Map<string, T>();
      // The platform lists keys in lexicographic order.
      for (const key of [...backing.keys()].sort()) {
        if (
          key.startsWith(prefix) &&
          (options?.start === undefined || key >= options.start) &&
          (options?.startAfter === undefined || key > options.startAfter) &&
          (options?.end === undefined || key < options.end)
        ) {
          listed.set(key, structuredClone(backing.get(key)) as T);
          if (listed.size === options?.limit) break;
        }
      }
      return listed;
    },
    async transaction<T>(
      closure: (txn: DurableObjectTransaction) => Promise<T>,
    ): Promise<T> {
      const before = new Map(backing);
      try {
        return await closure(cells as unknown as DurableObjectTransaction);
      } catch (error) {
        backing.clear();
        for (const [key, value] of before) backing.set(key, value);
        throw error;
      }
    },
  };

  return {
    backing,
    storage: cells as unknown as DurableObjectStorage,
    failPut(predicate, error) {
      refuses = predicate;
      if (error !== undefined) cause = error;
    },
    healPut() {
      refuses = null;
    },
    writes,
  };
}
