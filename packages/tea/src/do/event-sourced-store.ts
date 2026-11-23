/// <reference types="@cloudflare/workers-types" />
/**
 * @demlik/tea/do — event-sourced persistence mode for a Durable Object actor.
 *
 * `doStore` (sibling, `./index`) is the DEFAULT and stays snapshot-only: it
 * writes the whole `S` blob to one cell on every transition and reads it back
 * on boot. That is byte-for-byte unchanged by this file.
 *
 * `doEventSourcedStore` is the OPT-IN alternative. Instead of (only)
 * checkpointing the latest state, it:
 *
 *   1. APPENDS each applied `Msg` to an append-only log in `DurableObjectStorage`
 *      (one cell per event, monotonically keyed), from `store.save(state, msg)`.
 *      The engine awaits that save before it starts the transition's Cmds, so
 *      the event is durable before any effect runs: the log is write-ahead. An
 *      activation lost inside a model call finds that call's input in the log.
 *   2. Takes a PERIODIC SNAPSHOT every `snapshotEvery` events (count-based
 *      retention — mirrors Akka `RetentionCriteria.snapshotEvery`) so the log
 *      that must replay on the next activation is bounded. The event, its meta
 *      cell and the snapshot, when one is due, are written in ONE storage
 *      transaction. A grain that needs replay bounded by ELAPSED TIME/TICKS
 *      rather than raw event count drives `snapshotNow()` instead (or
 *      alongside) — see that method.
 *   3. On activation REBUILDS state by FOLDING the log on top of the latest
 *      snapshot. The fold starts directly from a snapshot; without one it
 *      starts from fresh init. One reducer step per logged Msg follows, with
 *      no Cmd handlers executed: **side effects are suppressed on replay**
 *      (recovery.md). This is the same primitive `foldEvents` / the recorder
 *      use; it is reused here, not reinvented (ADR 0003: "the fold already
 *      exists; wire it to Store").
 *
 * The "recovered/ready" signal (recovery.md `RecoveryCompleted`) is delivered
 * exactly once per activation via `onReady`, EVEN for a fresh actor with an
 * empty log, and is documented to be idempotent (it may fire again on a later
 * activation, so the handler must tolerate repeats).
 *
 * Integration with the cooperating DO:
 *
 *   const es = doEventSourcedStore(storage, machine, ctx, {
 *     snapshotEvery: 100,
 *     parse,                       // optional boundary parse for the snapshot
 *     onReady: (state) => { ... }, // optional, idempotent end-of-recovery hook
 *   });
 *   const runtime = run(machine, { ctx, store: es.store });
 *   await runtime.ready; // store.load() has folded; onReady has fired once.
 *
 * Nothing else feeds the log: do not append from `runtime.observe`, which
 * fires after the Cmds, and do not append a Msg by hand before dispatching it,
 * which would record it twice.
 *
 * A time/tick-driven grain (e.g. one that derives simulation ticks between
 * sparse intents) bounds its cold-wake replay by ELAPSED TIME rather than event
 * count by calling `es.snapshotNow()` on its own cadence — every N derived ticks
 * or on a wall-clock interval — so a quiet span that never trips `snapshotEvery`
 * is still snapshotted before its replay tail grows unbounded (#190):
 *
 *   // in the grain's tick loop, after the turn's dispatches have settled:
 *   if (tick % SNAPSHOT_EVERY_TICKS === 0) await es.snapshotNow();
 *
 * This is a legacy-replay store: it journals each APPLIED message after the
 * reducer ran and before its effects start, and recovers by folding the
 * reducer again. A `LoggedStore` (`logged: true`, ADR 0038) instead admits a
 * message before reduction and keeps committed State and owed deliveries, and
 * its recovery never runs a committed reducer again. Do not give one run both.
 */

import type { Cmd, Machine, Store, Sub } from "../index";
import { foldMsgs } from "../index";
import {
  type Basis,
  cellFormatOf,
  type EncodedFrame,
  type EvidenceEncoding,
  type FrameEvidence,
  type FrameRefusal,
  FULL_FRAME_EVERY,
  type LogFormat,
  parseFrame,
  RECORDING_PREFIX,
  readEvidence,
  rebuildEvidence,
} from "./recording-frames";
import { saveFence } from "./save-fence";

/** Default cell prefixes. Chosen to sort log keys lexicographically by seq. */
const DEFAULT_SNAPSHOT_KEY = "@@es/snapshot";
const DEFAULT_META_KEY = "@@es/meta";
const DEFAULT_EVENT_PREFIX = "@@es/evt/";
const EVENT_PAGE_SIZE = 128;
// Loads on the same storage namespace share a queue, including across handles.
const loads = new WeakMap<object, Map<string, Promise<void>>>();
/** Zero-pad seq numbers so `storage.list({ prefix })` returns them in order. */
const SEQ_WIDTH = 16;

function eventKey(prefix: string, seq: number): string {
  return prefix + String(seq).padStart(SEQ_WIDTH, "0");
}

/**
 * Persisted snapshot envelope. `seq` is the highest event sequence number the
 * snapshot's state already folds in — events strictly after it are the replay
 * tail. `state` is the folded `S` at that point.
 */
interface SnapshotCell<S> {
  readonly seq: number;
  readonly state: S;
}

/** Persisted meta cell: the highest sequence number ever appended. */
interface MetaCell {
  readonly lastSeq: number;
}

/** JSON restore evidence retained until a load succeeds. Counts started attempts. */
export interface RestoreAttempt {
  readonly attempts: number;
}

/** A previous restore did not finish and its automatic retry budget is spent. */
export class RestoreInterruptedError extends Error {
  override readonly name = "RestoreInterruptedError";
  readonly _tag = "restore_interrupted" as const;
  constructor(
    readonly attempts: number,
    readonly retryLimit: number,
  ) {
    super(
      `Restore interrupted after ${attempts} attempts (retry limit ${retryLimit})`,
    );
  }
}

function nextRestoreAttempt(
  attempts: number,
  retryLimit: number,
): RestoreAttempt {
  const decisions = {
    available: () => ({ attempts: attempts + 1 }),
    exhausted: () => {
      throw new RestoreInterruptedError(attempts, retryLimit);
    },
  } satisfies Record<"available" | "exhausted", () => RestoreAttempt>;
  return decisions[attempts > retryLimit ? "exhausted" : "available"]();
}

/**
 * How a log's events are decoded and where its cells live: the part of
 * {@link EventSourcedOptions} that {@link doEventLogReader} also takes. A
 * reader given the writing store's options finds and decodes the cells that
 * store wrote, so an `EventSourcedOptions` value is accepted as is.
 */
export interface EventLogReaderOptions<M> {
  /**
   * Boundary parse for a persisted EVENT (one logged `Msg`). Returns the `M` on
   * a recognized shape; returning `null` DROPS the event from replay (use for a
   * removed Msg variant). Must NOT throw. Default accepts any object carrying a
   * string `_tag` as `M`.
   */
  readonly parseEvent?: (raw: unknown) => M | null;
  /** Cell-key overrides (rarely needed; for coexisting actors in one DO). */
  readonly keys?: {
    readonly snapshot?: string;
    readonly meta?: string;
    readonly eventPrefix?: string;
  };
}

/** The log's cell keys, each override falling back to its default. */
function logKeys(keys: EventLogReaderOptions<never>["keys"] = {}): {
  readonly snapshot: string;
  readonly meta: string;
  readonly eventPrefix: string;
} {
  return {
    snapshot: keys.snapshot ?? DEFAULT_SNAPSHOT_KEY,
    meta: keys.meta ?? DEFAULT_META_KEY,
    eventPrefix: keys.eventPrefix ?? DEFAULT_EVENT_PREFIX,
  };
}

/**
 * Options for {@link doEventSourcedStore}.
 */
export interface EventSourcedOptions<S, M> extends EventLogReaderOptions<M> {
  /**
   * Take a snapshot every N appended events (count-based retention, mirrors
   * Akka `RetentionCriteria.snapshotEvery`). A snapshot bounds how many events
   * replay on the next activation — it never changes the fold's result, only
   * its length (recovery.md). Must be >= 1. Default 100.
   */
  readonly snapshotEvery?: number;
  /**
   * Automatic retries after an unfinished restore. Default 1: an initial
   * attempt and one retry; a second unfinished attempt refuses before reading
   * the snapshot or journal. Must be a non-negative safe integer. A thrown
   * load also leaves an unfinished attempt. Only success clears the record.
   */
  readonly restoreRetryLimit?: number;
  /**
   * Boundary parse for the persisted SNAPSHOT cell (the `S` blob). Returns `S`
   * on a recognized shape, `null` on an unrecognized one, and must NOT throw.
   * A present snapshot that returns `null` refuses restore; it never falls
   * back to replaying the full journal. Default accepts any non-null,
   * non-array object as `S`.
   */
  readonly parse?: (raw: unknown) => S | null;
  /**
   * End-of-recovery hook (recovery.md `RecoveryCompleted`). Fires EXACTLY ONCE
   * per activation, after the fold completes, carrying the recovered state —
   * even when the log was empty (fresh actor). It may fire again on a later
   * activation, so it MUST be idempotent. Side effects that belong "once after
   * recovery" go here, never in the reducer (the reducer re-runs on every
   * replay).
   */
  readonly onReady?: (state: S) => void;
  readonly keys?: EventLogReaderOptions<M>["keys"] & {
    /** Restore-attempt cell. Default: `${meta}/restore-attempt`. */
    readonly restoreAttempt?: string;
  };
}

/**
 * One persisted log entry handed to a {@link EventSourcedStore.readEvents}
 * consumer: the monotonic `seq` the event was appended under, paired with the
 * decoded `event`. `seq` is the store's own append counter (the key the event
 * lives under), so it both orders the stream and bounds an {@link EventLogRange}.
 */
export interface PersistedEvent<M> {
  /** The append sequence number this event was logged under (1-based, gap-free). */
  readonly seq: number;
  /** The decoded `Msg`, parsed through the store's `parseEvent` boundary. */
  readonly event: M;
}

/**
 * Optional inclusive bounds for {@link EventSourcedStore.readEvents}. Both ends
 * are inclusive and match against the event's `seq`; omitting an end leaves it
 * unbounded. `{ fromSeq: 5, toSeq: 10 }` yields seqs 5..10; `{}` (or no
 * argument) yields the whole log.
 */
export interface EventLogRange {
  /** Lowest `seq` to include (inclusive). Default: the first event. */
  readonly fromSeq?: number;
  /** Highest `seq` to include (inclusive). Default: the last event. */
  readonly toSeq?: number;
}

/**
 * The handle returned by {@link doEventSourcedStore}: a `Store<S>` to hand to
 * `run(...)`, plus the snapshot and read surface the cooperating DO drives.
 */
export interface EventSourcedStore<S, M> {
  /**
   * The `Store<S>` to pass as `run(machine, { ctx, store })`, and the only way
   * the log grows. Its `load()` performs the fold (snapshot + log replay). Its
   * `save(state, msg)` appends the applied `msg`, advances the meta cell and,
   * when `snapshotEvery` events have accumulated, writes the snapshot, all in
   * one storage transaction that settles before the engine starts the
   * transition's Cmds. A save without a Msg (the boot save, the flush at
   * `stop()`) appends nothing. A write that fails rejects the save and leaves
   * the stored bytes as they were. `migrate` forwards to `parse`.
   *
   * Its `load()` also takes the log for this isolate. A store built earlier on
   * the same storage can no longer write: a `save` or `snapshotNow()` it called
   * before the later `load()` is refused with `StoreConflictError` at its write
   * point, whenever it gets there, so a stopped run's save that lands late never
   * overwrites what the later run saved. A save with no later `load()` behind it
   * still lands, whether or not its run was given up on. Every `load()` counts,
   * this store's own included, so a store a host hands to each run it rebuilds
   * is covered too.
   *
   * Loads on the same storage object and meta key are serialized, including
   * across handles. Before snapshot or journal reads, load persists a JSON
   * {@link RestoreAttempt}. Success clears it; failure leaves it. Once
   * `restoreRetryLimit` is spent, load throws {@link RestoreInterruptedError}
   * before expensive reads. The engine preserves it as StoreRefusedError.cause.
   */
  readonly store: Store<S>;
  /**
   * Take a snapshot NOW, independent of the count-based `snapshotEvery` trigger
   * (a time/tick-based retention trigger, #190). The count-based trigger bounds
   * the replay tail by raw EVENT COUNT; a grain that derives many state
   * transitions per logged event (e.g. simulation ticks between sparse intents)
   * needs the tail bounded by ELAPSED TIME instead — so it calls `snapshotNow()`
   * on its own cadence (every N derived ticks, or on a wall-clock interval) to
   * checkpoint the current folded state without injecting filler events purely
   * to advance the counter.
   *
   * It checkpoints the State of the highest event the store has durably
   * written, at that event's sequence, then advances the count-based baseline
   * (`snapshotEvery` counts afresh from here, so a manual snapshot defers the
   * next automatic one).
   *
   * Returns `true` if a snapshot was written, `false` on a no-op: nothing has
   * been applied yet (fresh actor), or no new event exists since the last
   * snapshot (already current). The State and the sequence it pairs move
   * together, only once an event is durable, so a transition whose save failed
   * is never checkpointed. Resolves once the snapshot is durably written.
   */
  snapshotNow(): Promise<boolean>;
  /**
   * Highest committed append sequence, or 0 for an empty log. Reads only meta
   * before load; after load/save it uses the acknowledged sequence in memory.
   * Consumers can resume readEvents at this sequence + 1 without scanning history.
   * Assumes this handle is the active writer, like save and snapshotNow.
   */
  getCommittedSeq(): Promise<number>;
  /**
   * Stream the persisted event log in `seq` order, optionally bounded by an
   * inclusive {@link EventLogRange}. This is the PUBLIC read side of the
   * event-sourced write model — the surface replay / projection / audit
   * consumers (CQRS reads, recovery.md / projections.md) read through, instead
   * of mirroring the store's private `@@es/evt/` key convention.
   *
   * The log is APPEND-ONLY and is never truncated by snapshotting (a snapshot
   * only bounds the *replay* tail, never the log), so this yields EVERY event
   * in range — including ones a snapshot already folds. Each entry carries its
   * `seq`, so a consumer can resume from a known offset (`{ fromSeq }`) or read
   * a window (`{ fromSeq, toSeq }`). An empty (or fully out-of-range) log yields
   * nothing. Events whose `parseEvent` returns `null` (a retired Msg variant)
   * are dropped, identical to the recovery fold.
   * Bounds are applied in storage queries, in pages of at most 128 rows.
   *
   * Read-only: it never appends, snapshots, or mutates store state, so streaming
   * the log can never perturb the live actor.
   */
  readEvents(range?: EventLogRange): AsyncIterable<PersistedEvent<M>>;
}

const defaultParse = <S>(raw: unknown): S | null =>
  raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as S)
    : null;

const defaultParseEvent = <M>(raw: unknown): M | null =>
  raw !== null &&
  typeof raw === "object" &&
  !Array.isArray(raw) &&
  typeof (raw as { _tag?: unknown })._tag === "string"
    ? (raw as M)
    : null;

/**
 * What a log's head cells say: the highest committed append sequence (0 when
 * no event was committed) and whether a snapshot cell is present.
 */
export interface EventLogHead {
  readonly lastSeq: number;
  readonly snapshot: boolean;
  /** The format of the log's first cell, or `null` when it has none. */
  readonly format: LogFormat | null;
}

/**
 * An {@link EventLogRange} with an optional cap on how many stored cells are
 * read. `limit` counts every cell in range, refused ones included.
 */
export interface StoredEventRange extends EventLogRange {
  readonly limit?: number;
}

/**
 * Why a stored event cell did not decode: its value is not text (`not-text`),
 * its key carries no integer sequence (`key`), its text is not JSON (`json`),
 * `parseEvent` returned `null` (`event`), or it is a recording cell that does
 * not decode as a frame, lacks the frame its delta needs, or fails its checksum
 * ({@link FrameRefusal}).
 */
export type StoredEventRefusal =
  | "not-text"
  | "key"
  | "json"
  | "event"
  | FrameRefusal;

/**
 * One stored event cell as read, decoded or refused. `serializedBytes` is the
 * UTF-8 size of the stored text (0 when the value is not text); for a step
 * frame of a recording it is the size of the Msg JSON inside it.
 */
export type StoredEvent<M> =
  | {
      readonly _tag: "decoded";
      readonly key: string;
      readonly seq: number;
      readonly serializedBytes: number;
      readonly event: M;
    }
  | {
      readonly _tag: "refused";
      readonly key: string;
      readonly seq: number | null;
      readonly serializedBytes: number;
      readonly reason: StoredEventRefusal;
      readonly cause?: unknown;
    };

/**
 * One stored cell read as a frame of the log. A `message` is a cell of a log
 * written as bare messages, with no evidence. An `init` or `step` frame is a
 * recording frame; its `evidence` is rebuilt only when the read asked for it.
 * `serializedBytes` is the UTF-8 size of the whole stored text and
 * `messageBytes` the size of the Msg JSON inside it.
 */
export type StoredFrame<M> =
  | {
      readonly _tag: "message";
      readonly key: string;
      readonly seq: number;
      readonly serializedBytes: number;
      readonly messageBytes: number;
      readonly event: M;
    }
  | {
      readonly _tag: "step";
      readonly key: string;
      readonly seq: number;
      readonly serializedBytes: number;
      readonly messageBytes: number;
      readonly event: M;
      readonly encoding: EvidenceEncoding;
      readonly evidence?: FrameEvidence;
    }
  | {
      readonly _tag: "init";
      readonly key: string;
      readonly seq: number;
      readonly serializedBytes: number;
      readonly restored: boolean;
      readonly provenance: unknown;
      readonly encoding: EvidenceEncoding;
      readonly evidence?: FrameEvidence;
    }
  | Extract<StoredEvent<M>, { _tag: "refused" }>;

/** Options for {@link EventLogReader.readFrames}. */
export interface FrameReadOptions {
  /**
   * Rebuild each recording frame's evidence. `"verify"` rebuilds and checks
   * it, refusing a frame that does not rebuild, but yields no evidence.
   * Default `false`.
   */
  readonly evidence?: boolean | "verify";
  /** Read the range from its highest `seq` down. Evidence is not rebuilt. */
  readonly reverse?: boolean;
}

/**
 * A read-only view over a durable agent's event log, built by
 * {@link doEventLogReader}. Every call reads storage afresh; none writes a
 * cell, sets an alarm, or loads the agent.
 */
export interface EventLogReader<M> {
  /** The log's head, or `null` when neither meta nor snapshot cell exists. */
  readHead(): Promise<EventLogHead | null>;
  /** Highest committed append sequence from the meta cell, or 0 when absent. */
  readCommittedSeq(): Promise<number>;
  /**
   * Every stored event cell in range, in `seq` order, with refusals reported
   * instead of thrown. Read in pages of at most 128 rows.
   */
  readStoredEvents(range?: StoredEventRange): AsyncIterable<StoredEvent<M>>;
  /**
   * Decoded events in range, in `seq` order, exactly as the store's
   * {@link EventSourcedStore.readEvents}: events `parseEvent` refuses are
   * dropped, and text that is not JSON throws.
   */
  readEvents(range?: EventLogRange): AsyncIterable<PersistedEvent<M>>;
  /**
   * Every stored cell in range as a {@link StoredFrame}, in `seq` order, with
   * refusals reported instead of thrown. With `evidence`, each recording
   * frame's State and Cmds are rebuilt; a delta whose basis is missing or whose
   * checksum fails is refused. Only the current basis is held, and the frames
   * before the range that a delta needs are read in one bounded page.
   */
  readFrames(
    range?: StoredEventRange,
    options?: FrameReadOptions,
  ): AsyncIterable<StoredFrame<M>>;
}

const utf8 = new TextEncoder();

function parseMeta(raw: string): number {
  const meta = JSON.parse(raw) as MetaCell;
  if (!Number.isSafeInteger(meta.lastSeq) || meta.lastSeq < 0) {
    throw new Error("@demlik/tea/do: invalid committed sequence");
  }
  return meta.lastSeq;
}

function decodeStoredEvent<M>(
  eventPrefix: string,
  parseEvent: (raw: unknown) => M | null,
  key: string,
  value: unknown,
): StoredEvent<M> {
  const seq = Number(key.slice(eventPrefix.length));
  const position = Number.isSafeInteger(seq) ? seq : null;
  if (typeof value !== "string") {
    return {
      _tag: "refused",
      key,
      seq: position,
      serializedBytes: 0,
      reason: "not-text",
    };
  }
  const serializedBytes = utf8.encode(value).byteLength;
  if (position === null) {
    return { _tag: "refused", key, seq: null, serializedBytes, reason: "key" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch (cause) {
    return {
      _tag: "refused",
      key,
      seq: position,
      serializedBytes,
      reason: "json",
      cause,
    };
  }
  const event = parseEvent(raw);
  if (event === null) {
    return {
      _tag: "refused",
      key,
      seq: position,
      serializedBytes,
      reason: "event",
    };
  }
  return { _tag: "decoded", key, seq: position, serializedBytes, event };
}

function jsonBytes(value: unknown): number {
  return utf8.encode(JSON.stringify(value)).byteLength;
}

type Refused = Extract<StoredFrame<never>, { _tag: "refused" }>;

/**
 * Decode one stored cell as a frame, in whichever format it was written. The
 * parsed recording cell is returned beside it, evidence still encoded, for a
 * read that rebuilds it. A cell of a log written as bare messages has none. A
 * step whose Msg the host refuses (`event`) keeps its parsed cell: only its Msg
 * is refused, and the deltas after it still rebuild against its evidence.
 */
function decodeStoredFrame<M>(
  eventPrefix: string,
  parseEvent: (raw: unknown) => M | null,
  key: string,
  value: unknown,
): { readonly frame: StoredFrame<M>; readonly encoded: EncodedFrame | null } {
  if (typeof value !== "string" || cellFormatOf(value) === "messages") {
    const stored = decodeStoredEvent(eventPrefix, parseEvent, key, value);
    if (stored._tag === "refused") return { frame: stored, encoded: null };
    const { event, serializedBytes } = stored;
    return {
      frame: {
        _tag: "message",
        key,
        seq: stored.seq,
        serializedBytes,
        messageBytes: serializedBytes,
        event,
      },
      encoded: null,
    };
  }
  const serializedBytes = utf8.encode(value).byteLength;
  const seq = Number(key.slice(eventPrefix.length));
  const refused = (reason: Refused["reason"], cause?: unknown) => ({
    frame: {
      _tag: "refused",
      key,
      seq: Number.isSafeInteger(seq) ? seq : null,
      serializedBytes,
      reason,
      ...(cause === undefined ? {} : { cause }),
    } satisfies Refused,
    encoded: null,
  });
  if (!Number.isSafeInteger(seq)) return refused("key");
  if (!value.startsWith(RECORDING_PREFIX)) return refused("frame");
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch (cause) {
    return refused("json", cause);
  }
  const encoded = parseFrame(raw);
  if (encoded === null) return refused("frame");
  const { encoding } = encoded.evidence;
  if (encoded.frame === "init") {
    const { restored, provenance } = encoded;
    return {
      frame: {
        _tag: "init",
        key,
        seq,
        serializedBytes,
        restored,
        provenance,
        encoding,
      },
      encoded,
    };
  }
  const event = parseEvent(encoded.msg);
  if (event === null) return { frame: refused("event").frame, encoded };
  return {
    frame: {
      _tag: "step",
      key,
      seq,
      serializedBytes,
      messageBytes: jsonBytes(encoded.msg),
      event,
      encoding,
    },
    encoded,
  };
}

/**
 * Read a durable agent's event log without waking it.
 *
 * A host holding the agent's `DurableObjectStorage` reads the log's head, its
 * committed sequence and its events in a range. The reader never writes
 * storage, never runs a restore or a fold, and sets no alarm. Every call reads
 * the cells afresh (`noCache`), and events are listed in bounded pages.
 *
 * Cells the store cannot write — a value that is not a string, or a key whose
 * suffix is not an integer sequence — are skipped by `readEvents` and reported
 * as refused by `readStoredEvents`.
 */
export function doEventLogReader<M extends { _tag: string } = { _tag: string }>(
  storage: DurableObjectStorage,
  opts: EventLogReaderOptions<M> = {},
): EventLogReader<M> {
  return openLogReader(storage, opts).reader;
}

/**
 * The reader, and the one read the writing store also needs: the evidence
 * bytes of the frame before `seq`, which the next delta is taken from.
 */
function openLogReader<M extends { _tag: string }>(
  storage: DurableObjectStorage,
  opts: EventLogReaderOptions<M>,
): {
  readonly reader: EventLogReader<M>;
  basisBefore(seq: number): Promise<Basis | null>;
} {
  const parseEvent = opts.parseEvent ?? defaultParseEvent<M>;
  const {
    snapshot: snapshotKey,
    meta: metaKey,
    eventPrefix,
  } = logKeys(opts.keys);

  async function readCommittedSeq(): Promise<number> {
    const raw = await storage.get<string>(metaKey, { noCache: true });
    if (raw === undefined || raw === null) return 0;
    return parseMeta(raw);
  }

  async function readHead(): Promise<EventLogHead | null> {
    const firstKey = eventKey(eventPrefix, 1);
    const cells = await storage.get<string>([metaKey, snapshotKey, firstKey], {
      noCache: true,
    });
    const meta = cells.get(metaKey);
    const snapshot = cells.get(snapshotKey);
    const first = cells.get(firstKey);
    const absent = (
      cell: string | undefined | null,
    ): cell is undefined | null => cell === undefined || cell === null;
    if (absent(meta) && absent(snapshot)) return null;
    return {
      lastSeq: absent(meta) ? 0 : parseMeta(meta),
      snapshot: !absent(snapshot),
      format: absent(first) ? null : cellFormatOf(first),
    };
  }

  /** The raw cells in range, a page at a time, from the lowest `seq` or, reversed, the highest. */
  async function* listCells(
    range: StoredEventRange,
    reverse: boolean,
  ): AsyncGenerator<readonly [string, unknown]> {
    const fromSeq = Math.max(1, Math.ceil(range.fromSeq ?? 1));
    const toSeq = Math.floor(range.toSeq ?? Number.POSITIVE_INFINITY);
    const limit = range.limit ?? Number.POSITIVE_INFINITY;
    if (fromSeq > toSeq || fromSeq === Number.POSITIVE_INFINITY || limit < 1)
      return;
    const start = eventKey(eventPrefix, fromSeq);
    const end = Number.isFinite(toSeq)
      ? eventKey(eventPrefix, toSeq + 1)
      : undefined;
    let startAfter: string | undefined;
    let endBefore = end;
    let yielded = 0;
    while (true) {
      const bounds = reverse
        ? { start, ...(endBefore === undefined ? {} : { end: endBefore }) }
        : {
            ...(startAfter === undefined ? { start } : { startAfter }),
            ...(end === undefined ? {} : { end }),
          };
      const rows = await storage.list<unknown>({
        prefix: eventPrefix,
        ...bounds,
        reverse,
        limit: Math.min(EVENT_PAGE_SIZE, limit - yielded),
        noCache: true,
      });
      for (const [key, value] of rows) {
        if (reverse) endBefore = key;
        else startAfter = key;
        yielded += 1;
        yield [key, value];
      }
      if (rows.size < EVENT_PAGE_SIZE || yielded >= limit) return;
    }
  }

  async function basisBefore(seq: number): Promise<Basis | null> {
    if (seq <= 1) return null;
    const rows = await storage.list<unknown>({
      prefix: eventPrefix,
      end: eventKey(eventPrefix, seq),
      reverse: true,
      limit: FULL_FRAME_EVERY,
      noCache: true,
    });
    // Walk back to the last whole frame, then rebuild forward from it.
    const chain: (readonly [number, EncodedFrame])[] = [];
    let expected = seq - 1;
    for (const [key, value] of rows) {
      const { frame, encoded } = decodeStoredFrame(
        eventPrefix,
        parseEvent,
        key,
        value,
      );
      if (encoded === null || frame.seq !== expected) return null;
      chain.push([expected, encoded]);
      if (encoded.evidence.encoding === "full") break;
      expected -= 1;
    }
    let basis: Basis | null = null;
    for (const [at, encoded] of chain.reverse()) {
      const rebuilt = await rebuildEvidence(at, encoded.evidence, basis);
      if (typeof rebuilt === "string") return null;
      basis = rebuilt;
    }
    return basis;
  }

  async function* readFrames(
    range: StoredEventRange = {},
    options: FrameReadOptions = {},
  ): AsyncGenerator<StoredFrame<M>> {
    const evidence = options.evidence ?? false;
    const rebuild = evidence !== false && options.reverse !== true;
    // `undefined`: the frame before the range is not looked up yet.
    let basis: Basis | null | undefined;
    for await (const [key, value] of listCells(
      range,
      options.reverse === true,
    )) {
      const decoded = decodeStoredFrame(eventPrefix, parseEvent, key, value);
      const { frame, encoded } = decoded;
      if (
        !rebuild ||
        encoded === null ||
        frame._tag === "message" ||
        frame.seq === null
      ) {
        basis = null;
        yield frame;
        continue;
      }
      if (basis === undefined && encoded.evidence.encoding === "delta") {
        basis = await basisBefore(frame.seq);
      }
      const rebuilt = await rebuildEvidence(
        frame.seq,
        encoded.evidence,
        basis ?? null,
      );
      const read =
        typeof rebuilt === "string" ? null : readEvidence(rebuilt.bytes);
      if (typeof rebuilt === "string" || read === null) {
        basis = null;
        yield frame._tag === "refused"
          ? frame
          : {
              _tag: "refused",
              key,
              seq: frame.seq,
              serializedBytes: frame.serializedBytes,
              reason: typeof rebuilt === "string" ? rebuilt : "frame",
            };
        continue;
      }
      basis = rebuilt;
      yield frame._tag === "refused" || evidence === "verify"
        ? frame
        : { ...frame, evidence: read };
    }
  }

  async function* readStoredEvents(
    range: StoredEventRange = {},
  ): AsyncGenerator<StoredEvent<M>> {
    for await (const frame of readFrames(range)) {
      if (frame._tag === "init") continue;
      if (frame._tag === "refused") {
        yield frame;
        continue;
      }
      yield {
        _tag: "decoded",
        key: frame.key,
        seq: frame.seq,
        serializedBytes: frame.messageBytes,
        event: frame.event,
      };
    }
  }

  async function* readEvents(
    range: EventLogRange = {},
  ): AsyncGenerator<PersistedEvent<M>> {
    const fromSeq = Math.max(1, Math.ceil(range.fromSeq ?? 1));
    const toSeq = Math.floor(range.toSeq ?? Number.POSITIVE_INFINITY);
    for await (const stored of readStoredEvents(range)) {
      if (stored._tag === "decoded") {
        if (stored.seq < fromSeq || stored.seq > toSeq) continue;
        yield { seq: stored.seq, event: stored.event };
        continue;
      }
      if (stored.reason === "json") throw stored.cause;
    }
  }

  return {
    reader: {
      readHead,
      readCommittedSeq,
      readStoredEvents,
      readEvents,
      readFrames,
    },
    basisBefore,
  };
}

/**
 * Build an event-sourced `Store<S>` over `DurableObjectStorage`.
 *
 * The substrate calls `store.load()` once at boot — that is where the fold
 * happens — and `store.save(state, msg)` after every transition, before that
 * transition's Cmds start — that is where the event is appended and the
 * count-based snapshot is taken. No other call grows the log.
 *
 * Snapshot recovery folds update directly from the captured State; it does
 * not initialize that State again. With no snapshot, `ctx` supplies the fresh
 * init used to establish the event log's starting State. Live resume commands
 * belong to the runtime's subsequent init over the recovered State.
 */
// Cmd/Sub are INFERRED type params (`C`/`U`) that DEFAULT to the substrate's
// base unions, not pinned to them. The fold itself only ever touches `init` +
// `update`, so the body never depends on the concrete C/U — but pinning the
// machine param to the base `Cmd` made `interpret` *structurally required* via
// the `Machine` conditional (`[C] extends [Cmd<never>] ? { interpret? } : {
// interpret }`): a CMDLESS grain (`Cmd = never`, which legitimately declares no
// `interpret`) then could not satisfy the param without a cast (#195). Threading
// `C`/`U` lets TS infer `C = never` for such a grain, relaxing `interpret` to
// optional exactly as `run`/`replay` already do for a `Cmd = never` machine — so
// a cmdless machine type-checks with no cast and no no-op `interpret`. The
// defaults keep inference byte-for-byte identical for a commandful machine (and
// for the existing `<S, M, Ctx>`-explicit callers, whose C/U fall to the base
// defaults exactly as before); the machine keeps its precise types at its own
// definition site.
export function doEventSourcedStore<
  S,
  M extends { _tag: string },
  Ctx,
  C extends Cmd = Cmd,
  U extends Sub = Sub,
>(
  storage: DurableObjectStorage,
  machine: Machine<S, M, C, U, Ctx>,
  ctx: Ctx,
  opts: EventSourcedOptions<S, M> = {},
): EventSourcedStore<S, M> {
  const snapshotEvery = opts.snapshotEvery ?? 100;
  if (snapshotEvery < 1 || !Number.isInteger(snapshotEvery)) {
    throw new Error(
      `@demlik/tea/do: snapshotEvery must be an integer >= 1, got ${snapshotEvery}`,
    );
  }
  const restoreRetryLimit = opts.restoreRetryLimit ?? 1;
  if (!Number.isSafeInteger(restoreRetryLimit) || restoreRetryLimit < 0) {
    throw new Error(
      "@demlik/tea/do: restoreRetryLimit must be a non-negative safe integer",
    );
  }
  const parse = opts.parse ?? defaultParse;
  const {
    snapshot: snapshotKey,
    meta: metaKey,
    eventPrefix,
  } = logKeys(opts.keys);
  const restoreAttemptKey =
    opts.keys?.restoreAttempt ?? `${metaKey}/restore-attempt`;

  // In-memory mirror of the durable seq counter, set during load() and moved
  // only once a write has been acknowledged. Before load() it is unknown;
  // `ensureLastSeq()` lazily reads it.
  let lastSeq: number | null = null;
  // The seq the latest snapshot already folds (so we know the replay tail).
  let snapshotSeq = 0;
  // The State that folds events 1..lastSeq: what load() recovered, then the
  // State of each event once its write is acknowledged. A snapshot pairs it
  // with `lastSeq`, so a snapshot's `seq` and `state` always agree on one event
  // boundary. A save without a Msg, and a transition whose write failed, never
  // replace it.
  let latestState: S | null = null;
  // The log's generation in this isolate: a `load()` takes it, and a write that
  // was called under an older one is refused at its write point (./save-fence).
  const fence = saveFence(storage, metaKey);
  // Idempotency latch for onReady within a single activation.
  let readyFired = false;
  // One write at a time: `snapshotNow()` is called by the host, outside the
  // engine's serial tail, and must not interleave with a save.
  let writing: Promise<unknown> = Promise.resolve();
  // The read side of the log: the one owner of the event-key convention and
  // the stored-event decode, shared with hosts that read without loading.
  const reader = doEventLogReader<M>(storage, opts);

  async function readMeta(): Promise<number> {
    const raw = await storage.get<string>(metaKey);
    if (raw === undefined || raw === null) return 0;
    return parseMeta(raw);
  }

  /**
   * Return the durable `lastSeq`, lazily learning it from meta if a write
   * (`save`/`snapshotNow`) fires before any `load()` in this isolate
   * (defensive; the documented flow loads first). The guard lives here once so
   * `save` and `snapshotNow` can't drift on the write-before-load path.
   */
  async function ensureLastSeq(): Promise<number> {
    if (lastSeq === null) lastSeq = await readMeta();
    return lastSeq;
  }

  /**
   * Read the persisted snapshot cell, parsed through the boundary. Returns the
   * folded state + the seq it covers, or `{ state: null, seq: 0 }` when absent.
   * An unrecognized snapshot refuses instead of replaying its preceding events.
   */
  async function readSnapshot(): Promise<{ state: S | null; seq: number }> {
    const raw = await storage.get<string>(snapshotKey);
    if (raw === undefined || raw === null) return { state: null, seq: 0 };
    // Structural JSON malformation throws here, as in doStore — infra error,
    // not a schema mismatch.
    const cell = JSON.parse(raw) as SnapshotCell<unknown>;
    const parsed = parse(cell.state);
    if (parsed === null)
      throw new Error("@demlik/tea/do: persisted snapshot was refused");
    if (!Number.isSafeInteger(cell.seq) || cell.seq < 0) {
      throw new Error("@demlik/tea/do: invalid snapshot sequence");
    }
    return { state: parsed, seq: cell.seq };
  }

  /**
   * Stream the persisted event log in `seq` order, bounded by the optional
   * inclusive `[fromSeq, toSeq]` range. Both the public
   * {@link EventSourcedStore.readEvents} and the private fold's `readLog` flow
   * through the shared {@link doEventLogReader}, so the prefix/decode rule
   * lives in exactly one place.
   */
  const readEvents = reader.readEvents;

  /** Fold one decoded event at a time, retaining neither the tail nor its Cmds. */
  async function readLog(state: S, afterSeq: number): Promise<S> {
    for await (const { event } of readEvents({ fromSeq: afterSeq + 1 })) {
      state = foldMsgs(machine, state, [event]);
    }
    return state;
  }

  async function load(): Promise<S> {
    fence.takeOver();
    const raw = await storage.get<string>(restoreAttemptKey);
    const previous: unknown =
      raw === undefined ? { attempts: 0 } : JSON.parse(raw);
    if (
      previous === null ||
      typeof previous !== "object" ||
      !("attempts" in previous) ||
      typeof previous.attempts !== "number" ||
      !Number.isSafeInteger(previous.attempts) ||
      previous.attempts < 0
    ) {
      throw new Error("@demlik/tea/do: invalid restore-attempt record");
    }
    const attempt = nextRestoreAttempt(previous.attempts, restoreRetryLimit);
    await storage.put(restoreAttemptKey, JSON.stringify(attempt));

    const { state: snapshot, seq: snapSeq } = await readSnapshot();
    const committedSeq = await readMeta();
    const initialState = snapshot ?? machine.init(null, ctx)[0];
    const state = await readLog(initialState, snapSeq);
    if (parse(state) === null) {
      throw new Error("@demlik/tea/do: recovered state was refused");
    }
    latestState = state;
    lastSeq = committedSeq;
    snapshotSeq = snapSeq;
    if (!readyFired) opts.onReady?.(state);
    await storage.delete(restoreAttemptKey);
    readyFired = true;
    return state;
  }

  const store: Store<S> = {
    load(): Promise<unknown> {
      const queue = loads.get(storage) ?? new Map<string, Promise<void>>();
      loads.set(storage, queue);
      const result = (queue.get(metaKey) ?? Promise.resolve()).then(load);
      queue.set(
        metaKey,
        result.then(
          () => undefined,
          () => undefined,
        ),
      );
      return result;
    },

    async save(state: S, msg?: unknown): Promise<void> {
      // Boot and the final flush at `stop()` carry no Msg: there is no event to
      // write, and their State is not one an event produced.
      if (msg === undefined) return;
      const admit = fence.issue();
      await exclusive(async () => {
        const seq = (await ensureLastSeq()) + 1;
        // Count-based retention (Akka `RetentionCriteria.snapshotEvery`). When
        // the events since the last snapshot reach `snapshotEvery`, checkpoint
        // the post-this-event State under THIS seq, in the same transaction as
        // the event, so the snapshot's `seq` and `state` agree and the recovery
        // fold replays only events strictly after `seq`. A snapshot bounds
        // replay length; it never changes the fold's result (snapshotting.md).
        const snapshotDue = seq - snapshotSeq >= snapshotEvery;
        await persist(
          {
            event: { seq, json: JSON.stringify(msg) },
            snapshot: snapshotDue ? { seq, state } : null,
          },
          admit,
        );
        lastSeq = seq;
        latestState = state;
        if (snapshotDue) snapshotSeq = seq;
      });
    },

    migrate(raw: unknown): S | null {
      return parse(raw);
    },
  };

  /** Run `task` once every earlier write has settled, whether or not it succeeded. */
  function exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = writing.then(task);
    writing = result.catch(() => undefined);
    return result;
  }

  /**
   * The one private write: the event, the meta cell that counts it and, when one
   * is due, the snapshot that pairs the same seq with its State, in ONE storage
   * transaction. Every value is serialized before the transaction opens, so a
   * value that cannot be serialized refuses before any cell is touched, and a
   * put that fails undoes the others. The in-memory counters move only after
   * this resolves. `admit` is the caller's fence check, the first thing inside
   * the transaction callback, which the platform may run more than once: a write
   * called before a later runtime loaded this log throws `StoreConflictError`
   * there, on any run of the callback, and touches no cell.
   */
  async function persist(
    write: {
      readonly event?: { readonly seq: number; readonly json: string };
      readonly snapshot: { readonly seq: number; readonly state: S } | null;
    },
    admit: () => void,
  ): Promise<void> {
    const cells: [string, string][] = [];
    if (write.event !== undefined) {
      cells.push(
        [eventKey(eventPrefix, write.event.seq), write.event.json],
        [
          metaKey,
          JSON.stringify({ lastSeq: write.event.seq } satisfies MetaCell),
        ],
      );
    }
    if (write.snapshot !== null) {
      const cell: SnapshotCell<S> = write.snapshot;
      cells.push([snapshotKey, JSON.stringify(cell)]);
    }
    await storage.transaction(async (txn) => {
      admit();
      for (const [key, value] of cells) await txn.put(key, value);
    });
  }

  /**
   * Time/tick-based snapshot trigger (#190) — checkpoint NOW, independent of the
   * count-based `snapshotEvery`. See {@link EventSourcedStore.snapshotNow}.
   */
  function snapshotNow(): Promise<boolean> {
    const admit = fence.issue();
    return exclusive(async () => {
      const seq = await ensureLastSeq();
      // No-op when there is nothing new to checkpoint: a fresh actor with no
      // recovered State yet (`latestState === null`), or no event written since
      // the last snapshot (`seq <= snapshotSeq`). Both keep the snapshot's `seq`
      // and `state` paired on the same boundary the count-based path guarantees.
      if (latestState === null || seq <= snapshotSeq) return false;
      await persist({ snapshot: { seq, state: latestState } }, admit);
      snapshotSeq = seq;
      return true;
    });
  }

  return { store, snapshotNow, readEvents, getCommittedSeq: ensureLastSeq };
}
