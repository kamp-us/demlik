/**
 * journal sync — a remote journal and per-remote cursors, so two local journals
 * meet in one order.
 *
 * `Journal<R>` (`./index`) is the LOCAL append-only log a single machine replays
 * from. This is the second half: a **remote** journal that many local journals
 * push their appends into and pull everyone else's out of, with the remote
 * assigning the one `seq` that counts. Records are append-only, so there is
 * nothing to merge — the fold over the remote's order *is* the merge. This is
 * the network-in-the-middle twin of the append-then-fold shape already proven
 * in-repo by `src/do/event-sourced-store.ts` (append each record to a
 * monotonically-keyed log; rebuild state by folding the log via `replay`).
 *
 * The three moving parts:
 *   - `RemoteJournal<R>` — the append-only remote. `push` sends the records a
 *     client has not yet had acked and gets back the `seq` the remote assigned
 *     each; `pull` reads everyone's records after a given `seq`. One monotonic
 *     `seq` per stream, assigned by the remote, is the whole ordering contract.
 *   - a per-`(client, stream)` **cursor** (`CursorStore`) kept locally — the
 *     last remote `seq` a client has pulled — so `push`/`pull` resume
 *     incrementally instead of re-sending or re-reading the whole stream.
 *   - `SyncClient<R>` — a local `Journal<R>` joined to a `RemoteJournal<R>`
 *     through that cursor and a stable author identity. A local `append` is
 *     PROVISIONAL (it has a local order but no remote `seq`) until `sync` pushes
 *     it and pulls it back under the `seq` the remote assigned.
 *
 * Domain-blind and auth-blind: the remote takes an opaque `token` and an opaque
 * `stream` key and does nothing with the token — who-may-push-to-which-stream is
 * the host's concern, not this primitive's (the same way the local `Journal` is
 * blind to what a record means). Interface shape follows Effect
 * `unstable/eventlog` `EventJournal` (`writeFromRemote`, per-remote cursors, a
 * `changes` stream) as prior art, not a dependency.
 */

import { type JournalEntry, memoryJournal } from "./index";

/**
 * A remote-assigned order key. Like a local `Seq` it starts at 1 and increments
 * by one per record within a stream, but it is assigned by the REMOTE — it is
 * the authoritative order every client folds over, not any one client's local
 * append order.
 */
export type RemoteSeq = number;

/**
 * A record paired with the stable identity of whoever authored it. Author
 * identity is the one fact a team-mode record needs that a solo record does not:
 * once records from many clients interleave in the remote's order, the fold
 * still has to know who wrote each. It is opaque — a string the host assigns
 * meaning to (a device id, a user handle) — never interpreted here.
 */
export interface AuthoredRecord<R> {
  /** The stable identity of the client that authored `record`. */
  readonly author: string;
  /** The domain record itself; this primitive knows nothing of its shape. */
  readonly record: R;
}

/**
 * One record as it lives on the remote: the `seq` the remote assigned, the
 * `author` that wrote it, the `stream` it belongs to, and the record. This is
 * the entry every client pulls and folds; two clients that pull the same stream
 * see identical `RemoteEntry`s in identical `seq` order, which is what lets
 * their folds agree.
 */
export interface RemoteEntry<R> {
  /** The stream this entry belongs to. */
  readonly stream: string;
  /** The remote-assigned order key — 1-based, gap-free, monotonic per stream. */
  readonly seq: RemoteSeq;
  /** The stable identity of the client that authored the record. */
  readonly author: string;
  /** The domain record. */
  readonly record: R;
}

/** A `push` — the records a client wants acked, presented under its token. */
export interface PushRequest<R> {
  /**
   * An opaque credential the host's remote may check. This primitive does
   * nothing with it: authorization (who may push to which stream) is the host's
   * concern, deliberately out of scope here.
   */
  readonly token: unknown;
  /** The opaque stream key to append to. */
  readonly stream: string;
  /**
   * The records to append, in the client's local order. Normally these are the
   * client's own appends made since its last successful push — the incremental
   * tail, not the whole stream.
   */
  readonly records: ReadonlyArray<AuthoredRecord<R>>;
}

/** The remote's answer to a `push`: the `seq` it assigned each record, in order. */
export interface PushResult {
  /**
   * The remote `seq` assigned to each record of the request, in the same order.
   * `seqs[i]` is the seq of `records[i]`. A client does not need to fold these —
   * it learns the full ordered stream (its own records included) through `pull`,
   * which is the single reader of converged state.
   */
  readonly seqs: ReadonlyArray<RemoteSeq>;
}

/** A `pull` — read everyone's records after a `seq` the client already has. */
export interface PullRequest {
  /** The opaque credential; ignored here, see {@link PushRequest.token}. */
  readonly token: unknown;
  /** The opaque stream key to read. */
  readonly stream: string;
  /**
   * Return only entries with `seq` strictly greater than this. A client passes
   * its cursor (the last `seq` it pulled), so it reads only what is new — never
   * re-reading the whole stream. `0` (the cursor's initial value) reads from the
   * start.
   */
  readonly since: RemoteSeq;
}

/** The remote's answer to a `pull`: the new entries, in `seq` order. */
export interface PullResult<R> {
  /** Every entry with `seq > since`, in ascending `seq` order. */
  readonly entries: ReadonlyArray<RemoteEntry<R>>;
}

/**
 * An append-only remote journal: many clients push into it, all pull from it,
 * and it assigns the one monotonic `seq` per stream that every client's fold
 * agrees over. It is the network-in-the-middle: a real one is a server; this
 * interface is what a client talks to, host- and transport-blind.
 *
 * The remote never merges and never resolves conflicts — records are
 * append-only, so its only job is to assign an honest total order. That order
 * is enough: two clients that both push and both pull fold the same sequence and
 * reach the same state (the append-then-fold result proven in phoenix spike
 * #6673, reused here rather than reinvented).
 */
export interface RemoteJournal<R> {
  /**
   * Append `records` to `stream` durably and return the `seq` assigned to each,
   * in order. Concurrent pushes to one stream are serialised into a single total
   * order — the seq assignment is the remote's whole ordering guarantee.
   */
  push(request: PushRequest<R>): Promise<PushResult>;
  /**
   * Read every entry of `stream` with `seq` strictly greater than
   * `request.since`, in ascending `seq` order. Empty when the client is already
   * caught up.
   */
  pull(request: PullRequest): Promise<PullResult<R>>;
}

/**
 * An in-memory `RemoteJournal<R>` — the standard test/reference substrate,
 * mirroring `memoryStore` (`@demlik/tea/mem`) and `memoryJournal` (`./index`).
 *
 * It is built ON `memoryJournal`: the remote's authoritative `seq` assignment IS
 * a local `Journal`'s per-stream total order. `push` appends each record under
 * the stream's lock (so concurrent pushes serialise into one order and never
 * race the seq), and `pull` is `list` filtered past the client's cursor. The
 * seq machinery is `makeJournal`'s, reused — this substrate reinvents none of
 * it, exactly as the issue's seam was designed to be consumed.
 *
 * The `token` is accepted and ignored: this substrate enforces no authorization,
 * because who-may-push-to-which-stream is the host's concern, out of scope here.
 */
export function memoryRemoteJournal<R>(): RemoteJournal<R> {
  const journal = memoryJournal<AuthoredRecord<R>>();

  const toRemoteEntry = (
    entry: JournalEntry<AuthoredRecord<R>>,
  ): RemoteEntry<R> => ({
    stream: entry.stream,
    seq: entry.seq,
    author: entry.record.author,
    record: entry.record.record,
  });

  return {
    async push({ stream, records }) {
      const seqs: RemoteSeq[] = [];
      // Hold the stream's lock across the whole batch so a concurrent push
      // cannot interleave its seqs into the middle of this one — a batch lands
      // as a contiguous run, and racing batches serialise as wholes.
      await journal.withLock(stream, async () => {
        for (const record of records) {
          const { seq } = await journal.append(stream, record);
          seqs.push(seq);
        }
      });
      return { seqs };
    },
    async pull({ stream, since }) {
      const entries = (await journal.list(stream))
        .filter((entry) => entry.seq > since)
        .map(toRemoteEntry);
      return { entries };
    },
  };
}

/**
 * Where a client keeps its per-`(client, stream)` cursor — the last remote `seq`
 * it has pulled. Kept LOCALLY (the client's own disk/memory), never on the
 * remote, so `push`/`pull` resume incrementally after a restart instead of
 * re-reading the whole stream. `get` returns `0` for a stream never pulled.
 */
export interface CursorStore {
  /** The last remote `seq` pulled for `stream`, or `0` if none yet. */
  get(stream: string): Promise<RemoteSeq>;
  /** Record `seq` as the last remote `seq` pulled for `stream`. */
  set(stream: string, seq: RemoteSeq): Promise<void>;
}

/**
 * An in-memory `CursorStore`, mirroring `memoryStore`. A durable client swaps in
 * a file- or DB-backed one so its cursor survives a restart; the semantics are
 * identical.
 */
export function memoryCursorStore(): CursorStore {
  const cursors = new Map<string, RemoteSeq>();
  return {
    async get(stream) {
      return cursors.get(stream) ?? 0;
    },
    async set(stream, seq) {
      cursors.set(stream, seq);
    },
  };
}

/** How to build a {@link SyncClient}. */
export interface SyncClientOptions<R> {
  /** The remote every push/pull talks to. */
  readonly remote: RemoteJournal<R>;
  /**
   * This client's stable author identity, stamped on every record it appends —
   * the one fact team mode needs that solo mode does not.
   */
  readonly author: string;
  /**
   * The opaque credential presented on every push/pull. Optional because this
   * primitive never checks it; a host that runs an authorizing remote supplies
   * it here.
   */
  readonly token?: unknown;
  /**
   * The client's LOCAL append-only journal — its own provisional appends live
   * here. Defaults to a `memoryJournal`; a durable client passes a `fileJournal`
   * (or any `Journal<R>`), which is the #30 substrate seam this consumes.
   */
  readonly local?: LocalJournal<R>;
  /**
   * Where the per-stream pull cursor lives. Defaults to a `memoryCursorStore`; a
   * durable client passes one backed by its own storage.
   */
  readonly cursors?: CursorStore;
}

/**
 * The slice of a local `Journal<R>` a `SyncClient` drives — its own provisional
 * appends and reading them back in local order. This is structurally the #30
 * `Journal<R>` interface narrowed to what sync needs, so a `memoryJournal` or a
 * `fileJournal` satisfies it as-is.
 */
export interface LocalJournal<R> {
  append(stream: string, record: R): Promise<{ seq: number }>;
  list(stream: string): Promise<ReadonlyArray<JournalEntry<R>>>;
}

/**
 * A local `Journal` joined to a `RemoteJournal` through a cursor and an author
 * identity. It is what makes two local journals "meet in one order": each
 * appends offline, both `sync`, and both converge on the remote's order.
 */
export interface SyncClient<R> {
  /**
   * Append `record` to the client's LOCAL journal. The append is PROVISIONAL: it
   * has a local order immediately, but no remote `seq` — and so no place in the
   * converged order — until a later `sync` pushes it and pulls it back. Resolves
   * once the local append is durable.
   */
  append(stream: string, record: R): Promise<void>;
  /**
   * The client's local appends for `stream` that have not yet been pushed — the
   * provisional tail. Empty right after a successful `sync`.
   */
  pending(stream: string): Promise<ReadonlyArray<AuthoredRecord<R>>>;
  /**
   * Reconcile `stream` with the remote: PUSH every local append not yet pushed,
   * then PULL every remote entry after the cursor and fold it into the converged
   * log, advancing the cursor. One `sync` may not see records a peer pushes
   * concurrently (they may land after this pull); a second `sync` — with nothing
   * new to push — pulls them, which is how two racing clients converge.
   */
  sync(stream: string): Promise<void>;
  /**
   * The converged log for `stream`: every entry the client has pulled, in remote
   * `seq` order. This is the fold's input — reducing over it yields the client's
   * state. After both of two racing clients sync to quiescence, their `log`s are
   * identical, which is the convergence guarantee.
   */
  log(stream: string): ReadonlyArray<RemoteEntry<R>>;
}

/**
 * Build a {@link SyncClient} over a remote, an author identity, and (optionally)
 * a local journal and cursor store.
 *
 * The client holds two watermarks per stream: how many of its own local appends
 * it has PUSHED (so a re-`sync` sends only the new tail), and — in the
 * `CursorStore` — the last remote `seq` it has PULLED (so it reads only what is
 * new). Its converged `log` is built solely from `pull`, so `pull` is the single
 * source of converged truth; a client learns even its OWN records' remote order
 * by pulling them back.
 */
export function makeSyncClient<R>(
  options: SyncClientOptions<R>,
): SyncClient<R> {
  const { remote, author, token } = options;
  const local = options.local ?? memoryJournal<R>();
  const cursors = options.cursors ?? memoryCursorStore();

  // Per stream: how many of this client's local appends have been pushed. Local
  // seqs are 1-based and gap-free, so this count is also the local seq watermark
  // — appends with local seq > pushed are the unpushed tail.
  const pushed = new Map<string, number>();
  // Per stream: the converged log, remote-ordered, built only from `pull`.
  const converged = new Map<string, RemoteEntry<R>[]>();

  const unpushed = async (
    stream: string,
  ): Promise<ReadonlyArray<JournalEntry<R>>> => {
    const entries = await local.list(stream);
    return entries.slice(pushed.get(stream) ?? 0);
  };

  return {
    async append(stream, record) {
      await local.append(stream, record);
    },
    async pending(stream) {
      const tail = await unpushed(stream);
      return tail.map((entry) => ({ author, record: entry.record }));
    },
    async sync(stream) {
      const tail = await unpushed(stream);
      if (tail.length > 0) {
        await remote.push({
          token,
          stream,
          records: tail.map((entry) => ({ author, record: entry.record })),
        });
        pushed.set(stream, (pushed.get(stream) ?? 0) + tail.length);
      }

      const since = await cursors.get(stream);
      const { entries } = await remote.pull({ token, stream, since });
      const last = entries[entries.length - 1];
      if (last !== undefined) {
        const log = converged.get(stream) ?? [];
        log.push(...entries);
        converged.set(stream, log);
        await cursors.set(stream, last.seq);
      }
    },
    log(stream) {
      return (converged.get(stream) ?? []).slice();
    },
  };
}
