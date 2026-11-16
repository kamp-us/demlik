/**
 * @packageDocumentation
 * @demlik/tea/mem — in-memory `Store<S>` adapter for `@demlik/tea`.
 *
 * The standard test adapter — used everywhere a Worker or DO would be
 * overkill. Mirrors the source-only convention from `packages/widget-engine`
 * and `packages/tea` (no build step).
 *
 * Reference semantics, NOT deep-clone semantics:
 *   - `save(state)` stores the reference; subsequent mutations to that
 *     reference by the caller are observable through later `load()` calls.
 *   - `load()` returns the stored reference; mutations made through it are
 *     observable on the next `load()`.
 *
 * This matches what a real KV/DO `get()` would NOT do (those serialize +
 * deserialize), but it also matches what an in-memory cache obviously does.
 * Adding a deep clone here would lie about the boundary and impose a JSON
 * round-trip on every test. Tests that need fresh copies should clone at the
 * call site.
 *
 * Boundary parse (invariant 8): `Store<S>` requires `migrate(raw)`. For
 * `memoryStore` we ship a permissive identity-default — `(raw) => raw as
 * S | null` — because this adapter is a degenerate same-process boundary:
 * there is no serialization, the reference we read is structurally the
 * reference we wrote. The `as` cast here is the documented exception to the
 * invariant-8 no-`as` rule, scoped to the parameter default. Callers that
 * want strict parsing (e.g. a test that hand-seeds the cell from outside)
 * may pass an explicit `parse` to override.
 */

import type { DeletableStore, FencedStore, Migrated } from "../index";
import { StoreConflictError } from "../index";
import {
  logKey,
  logWriter,
  type PreparedLogWrite,
  sameLogValue,
} from "../internal/persistence/durable-log/format";
import type { Cmd } from "../pure/core";
import type { EventSourcedOptions, LoggedStore } from "../runtime-types";
import { schemaMigrate } from "../runtime-types";

/** Options for {@link memoryStore}. */
export interface MemoryStoreOptions {
  /**
   * Refuse a second live writer (#143). With `{ fenced: true }` the returned
   * store is a `FencedStore<S>` whose version is an in-process counter — honest
   * for this adapter, since the cell it guards is in this process too. Two
   * `run`s handed the SAME `memoryStore` are the case it catches, and it is the
   * cheapest way to exercise the fenced path in a test. A run on a fenced store
   * must be given an `onError` (see `StoreAndOnError`).
   */
  readonly fenced?: true;
}

/**
 * Build an in-memory `Store<S>`.
 *
 * @param initial - optional seed value. `undefined` and explicit `null` both
 *   mean "no seed"; `load()` resolves with `null` until the first `save()`.
 *   A concrete `S` seed is returned by `load()` until overwritten.
 * @param parse - optional boundary parse for the `Store<S>.migrate` contract.
 *   Defaults to identity (`(raw) => raw as S | null`) — honest for this
 *   adapter's degenerate same-process boundary. Pass an explicit parser when
 *   the test wants to reject seeded shapes that don't match `S`.
 */
export function memoryStore<S>(
  initial?: S | null,
  parse?: (raw: unknown) => Migrated<S>,
): DeletableStore<S>;
export function memoryStore<S>(
  initial: S | null | undefined,
  parse: ((raw: unknown) => Migrated<S>) | undefined,
  options: MemoryStoreOptions & { readonly fenced: true },
): FencedStore<S> & DeletableStore<S>;
export function memoryStore<S>(
  initial?: S | null,
  parse?: (raw: unknown) => Migrated<S>,
  options?: MemoryStoreOptions,
): DeletableStore<S> | (FencedStore<S> & DeletableStore<S>);
export function memoryStore<S>(
  initial?: S | null,
  parse: (raw: unknown) => Migrated<S> = (raw) => raw as S | null,
  options: MemoryStoreOptions = {},
): DeletableStore<S> | (FencedStore<S> & DeletableStore<S>) {
  // Single internal cell — `undefined` and `null` collapse to one
  // representation so the load site is branchless.
  let cell: S | null = initial ?? null;
  // The version the cell was last written at. A never-written cell reads `0`,
  // matching `fileStore`'s absent stamp.
  let version = 0;

  const base: DeletableStore<S> = {
    async load(): Promise<unknown> {
      return cell;
    },
    async save(state: S): Promise<void> {
      cell = state;
      version += 1;
    },
    migrate(raw: unknown): Migrated<S> {
      return parse(raw);
    },
    async delete(): Promise<void> {
      // Back to never-written: an empty cell at version `0`. The seed is gone
      // too — `load()` answers what an unseeded store answers.
      cell = null;
      version = 0;
    },
  };
  if (options.fenced !== true) return base;

  return {
    ...base,
    fenced: true,
    async loadFenced(): Promise<{ raw: unknown; version: number }> {
      return { raw: cell, version };
    },
    async saveFenced(state: S, expectedVersion: number): Promise<number> {
      // No lock: the whole store is one process's memory, and this body has no
      // await before the compare, so nothing can interleave between the check
      // and the write.
      if (version !== expectedVersion) {
        throw new StoreConflictError(expectedVersion, version);
      }
      cell = state;
      version += 1;
      return version;
    },
  };
}

/**
 * Build a single-writer durable log over caller-owned serialized memory.
 * A fresh driver over the same Map and key resumes the same history.
 * Each mutation reads, decides and writes synchronously before yielding.
 */
export function memoryEventSourcedStore<
  S,
  M extends { _tag: string },
  C extends Cmd,
>(
  backing: Map<string, string>,
  options: EventSourcedOptions<S, M, C>,
): LoggedStore<S, M, C> {
  const key = logKey(options.key);
  const every = options.snapshotEvery ?? 100;
  if (!Number.isSafeInteger(every) || every < 1)
    throw new Error("snapshotEvery must be a positive safe integer");
  let writer = logWriter(options);
  let root: string | undefined;
  let checkpoint: string | undefined;
  let loaded = false;
  const read = () => {
    try {
      const current = backing.get(key);
      if (!loaded || current !== root) {
        writer = logWriter(options);
        root = current;
        checkpoint = undefined;
        loaded = true;
        if (root !== undefined) writer.restore(root);
        else if (backing.has(`${key}/2`))
          throw new Error("Durable log is missing its birth");
      }
      for (;;) {
        const bytes = backing.get(`${key}/${writer.version() + 1}`);
        if (bytes === undefined) break;
        writer.restore(bytes);
      }
      const saved = backing.get(`${key}/checkpoint`);
      if (saved !== checkpoint) {
        if (saved !== undefined) writer.restoreCheckpoint(saved);
        checkpoint = saved;
      }
      return writer;
    } catch (error) {
      loaded = false;
      throw error;
    }
  };
  const mutate = <T>(
    decide: (
      log: ReturnType<typeof logWriter<S, M, C>>,
    ) => T | PreparedLogWrite<T>,
  ): T => {
    const result = decide(read());
    if (typeof result !== "object" || result === null || !("accept" in result))
      return result;
    backing.set(key + result.suffix, result.bytes);
    result.accept();
    if (result.suffix === "") root = result.bytes;
    if (result.suffix === "/checkpoint") checkpoint = result.bytes;
    return result.result;
  };
  return {
    logged: true,
    async load() {
      return read().state();
    },
    async save(state) {
      if (!sameLogValue(state, read().state()))
        throw new Error("Logged State can only change through commitStep");
    },
    migrate: schemaMigrate(options.state),
    async readLog() {
      return read().read();
    },
    async appendMessage(message) {
      return mutate((log) => log.append(message));
    },
    async commitStep(step) {
      return mutate((log) => log.commit(step));
    },
    async confirmEffect(id) {
      return mutate((log) => log.confirm(id));
    },
    async checkpoint() {
      return mutate((log) => log.checkpoint());
    },
  };
}
