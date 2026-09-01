/**
 * @packageDocumentation
 * @demlik/tea/journal — an append-only, ordered record log for `@demlik/tea`.
 *
 * The log a "durable, replayable state machine" replays from. tea already ships
 * the log's neighbours — `fileStore`/`memoryStore` (`Store<S>`: snapshot with
 * whole-load / whole-save), `recorder` (JSONL debug traces), `durable-effects`
 * (`foldLedger` over an owed-effect ledger) — but not the log itself, so every
 * consumer hand-rolled it. This is that log, domain-blind: a `Journal<R>` over
 * an opaque record `R`, with no pipeline/ledger vocabulary of its own.
 *
 * Three operations carry the contract:
 *   - `append(stream, record)` — durable before it returns, assigning a
 *     per-stream total-order `seq` (1, 2, 3, …). Concurrent appenders to one
 *     stream converge on one order; the lock's only job is an honest order key.
 *   - `list(stream)` — every entry of a stream in `seq` order.
 *   - `changes(listener)` — a subscription over appends made through this
 *     instance after subscribing.
 *
 * `withLock(stream, fx)` runs `fx` with exclusive access to a stream, so a
 * read-decide-append sequence is atomic against other writers. It is
 * re-entrant for the same stream: an `append` inside `fx` does not deadlock on
 * the lock `fx` already holds.
 *
 * The substrate is a `JournalBackend<R>` — how a stream is read, how one record
 * is appended durably, and how a stream is locked across processes.
 * `makeJournal` wires the domain-blind orchestration (per-stream serialisation,
 * `seq` assignment, `changes` fan-out) over any backend. `memoryJournal` is the
 * in-process backend that mirrors `memoryStore` for tests; the Node file
 * backend (`fileJournal`) homes in `@demlik/tea/node` beside `fileStore`.
 *
 * Interface shape follows Effect `unstable/eventlog` `EventJournal`
 * (`entries`/`write`/`changes`/`withLock`) as prior art, not a dependency.
 */

/** A per-stream total-order key. Starts at 1 and increments by one per append. */
export type Seq = number;

/** One appended record, tagged with its stream and its per-stream `seq`. */
export interface JournalEntry<R> {
  readonly stream: string;
  readonly seq: Seq;
  readonly record: R;
}

/**
 * An append-only, ordered record log over an opaque record `R`.
 *
 * Domain-blind: it knows nothing of what a record means. Ordering, durability
 * and the honest order key are its whole contract.
 */
export interface Journal<R> {
  /**
   * Append `record` to `stream`, durable before the promise resolves, and
   * resolve with the `seq` it was assigned — the next integer in the stream's
   * total order.
   */
  append(stream: string, record: R): Promise<{ seq: Seq }>;
  /** Every entry of `stream`, in `seq` order. Empty for an unwritten stream. */
  list(stream: string): Promise<ReadonlyArray<JournalEntry<R>>>;
  /**
   * Subscribe to appends made through this instance after this call. Returns an
   * unsubscribe. Cross-process appends are not delivered — a cross-process
   * subscription is a polling concern this log leaves to its consumer.
   */
  changes(listener: (entry: JournalEntry<R>) => void): () => void;
  /**
   * Run `fx` with exclusive access to `stream` — the in-process mutex against
   * other callers here, the backend lock against other processes. Re-entrant
   * for the same stream, so an `append` (or nested `withLock`) inside `fx` runs
   * under the lock this call already holds rather than deadlocking on it.
   */
  withLock<A>(stream: string, fx: () => Promise<A>): Promise<A>;
}

/**
 * The substrate a `Journal<R>` is built over. Everything host-specific lives
 * here; `makeJournal` owns the host-blind rest.
 *
 * `append` is always invoked under `lock` for the same stream, so a backend
 * assigns `seq` from `read().length + 1` without racing itself.
 */
export interface JournalBackend<R> {
  /** Every entry of `stream` in `seq` order; empty for an unwritten stream. */
  read(stream: string): Promise<ReadonlyArray<JournalEntry<R>>>;
  /**
   * Persist `record` as the next entry of `stream`, durable before resolving,
   * and resolve with the entry it wrote. Invoked only while `lock` holds the
   * stream, so `seq` is safely the current length plus one.
   */
  append(stream: string, record: R): Promise<JournalEntry<R>>;
  /** Run `fx` while holding `stream`'s cross-process lock. */
  lock<A>(stream: string, fx: () => Promise<A>): Promise<A>;
}

/**
 * A promise-chained mutex: each `run` waits for the prior one to settle, so the
 * bodies never interleave. The order key is honest because assignment happens
 * inside a body, never across the `await` that another body could slip through.
 */
class AsyncLock {
  private tail: Promise<unknown> = Promise.resolve();

  run<A>(fx: () => Promise<A>): Promise<A> {
    const result = this.tail.then(fx, fx);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/**
 * Build a `Journal<R>` over `backend`. Owns the host-blind half: per-stream
 * serialisation, re-entrant exclusion, and the `changes` fan-out. `append` and
 * `withLock` both route through `exclusive`, which holds the in-process mutex
 * and the backend lock for one stream and is re-entrant for that stream within
 * a single call chain.
 */
export function makeJournal<R>(backend: JournalBackend<R>): Journal<R> {
  const mutexes = new Map<string, AsyncLock>();
  const held = new Set<string>();
  const listeners = new Set<(entry: JournalEntry<R>) => void>();

  const mutexFor = (stream: string): AsyncLock => {
    let mutex = mutexes.get(stream);
    if (!mutex) {
      mutex = new AsyncLock();
      mutexes.set(stream, mutex);
    }
    return mutex;
  };

  const exclusive = <A>(stream: string, fx: () => Promise<A>): Promise<A> => {
    // Already holding this stream's lock in this call chain: run inline, or a
    // re-entrant append/withLock would block forever on a lock it owns.
    if (held.has(stream)) return fx();
    return mutexFor(stream).run(() =>
      backend.lock(stream, async () => {
        held.add(stream);
        try {
          return await fx();
        } finally {
          held.delete(stream);
        }
      }),
    );
  };

  return {
    append(stream, record) {
      return exclusive(stream, async () => {
        const entry = await backend.append(stream, record);
        for (const listener of listeners) listener(entry);
        return { seq: entry.seq };
      });
    },
    list(stream) {
      return Promise.resolve(backend.read(stream));
    },
    changes(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    withLock(stream, fx) {
      return exclusive(stream, fx);
    },
  };
}

/**
 * An in-process `Journal<R>` — the standard test substrate, mirroring
 * `memoryStore` from `@demlik/tea/mem`. Reference semantics: a record handed to
 * `append` is stored by reference, exactly as `memoryStore` stores state. No
 * cross-process lock is needed — a single process owns the whole log — so the
 * backend lock is identity and `makeJournal`'s in-process mutex is the only
 * ordering guarantee.
 */
export function memoryJournal<R>(): Journal<R> {
  const streams = new Map<string, JournalEntry<R>[]>();

  return makeJournal<R>({
    async read(stream) {
      return (streams.get(stream) ?? []).slice();
    },
    async append(stream, record) {
      const log = streams.get(stream) ?? [];
      const entry: JournalEntry<R> = { stream, seq: log.length + 1, record };
      log.push(entry);
      streams.set(stream, log);
      return entry;
    },
    async lock(_stream, fx) {
      return fx();
    },
  });
}
