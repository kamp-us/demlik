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
 * With `recording`, the store keeps evidence instead of bare Msgs. Each cell is a
 * frame: an `init` frame for every boot save and a `step` frame for every
 * applied Msg, each holding the State after it and the Cmds the engine started
 * for it (see `./recording-frames`). The recovery fold skips the `init` frames,
 * and `snapshotEvery` counts only Msgs, so a recording snapshots, restores and
 * reads (`doEventLogReader`) like the log of Msgs it contains.
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

import type { Cmd, Machine, SaveBoundary, Store, Sub } from "../index";
import { foldMsgs } from "../index";
import type { Trace, TraceStep } from "../internal/persistence/recorder";
import {
  type Basis,
  cellFormatOf,
  type EncodedFrame,
  type EvidenceEncoding,
  encodeFrame,
  encodeOversized,
  type FrameEvidence,
  type FrameRefusal,
  FULL_FRAME_EVERY,
  type LogFormat,
  type OversizedMarker,
  parseCellMsg,
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

interface SnapshotPartsCell {
  readonly seq: number;
  readonly parts: number;
}

const MIN_ROW_BYTES = 1024;
const PART_WIDTH = 8;

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
  /**
   * Record each boundary's evidence. A log this store starts is written as a
   * recording: an `init` frame for every boot save, carrying `provenance`, and
   * a `step` frame for every applied Msg, each with the State after it and the
   * Cmds the engine started for it. A log already written as bare messages
   * keeps being written that way; its missing evidence is never invented.
   * A recording log is written as one whatever this option says, and gets no
   * `init` frame without it.
   *
   * An `init` boundary that carries `skipped` (a windowed trace written with
   * `writeTrace`) is a moved anchor, not a restored boot. It opens an empty log
   * at sequence `skipped + 1`, with a snapshot of its State at that sequence so
   * a restore folds only the steps after it, and each later step keeps the
   * number the live run gave it. A log written as bare messages takes the same
   * offset with no frame: its committed sequence and snapshot start at
   * `skipped`. A `skipped` that is negative or not an integer, or that is given
   * to a log which already has frames, rejects the save and writes nothing.
   */
  readonly recording?: {
    /** JSON written into every `init` frame, unread by the store. */
    readonly provenance: unknown;
    /**
     * The most bytes one frame's row may take: the UTF-8 bytes of its key plus
     * those of its encoded cell. A frame over it is not written. A small
     * refusal marker is written at the same seq instead, naming the frame and
     * the bytes measured, the next frame is written whole, and the write goes
     * on. A storage write rejected with `SQLITE_TOOBIG` takes the same path,
     * since text bytes do not prove the size the storage serializes; any other
     * storage failure still rejects the save. A marker in place of a step frame
     * keeps neither its evidence nor its Msg, so the State after it is
     * snapshotted at its seq in the same write, and restore folds from there.
     * Each marker is reported to `onRecordingBreak` with `reason: "oversized"`.
     * A recording that holds a marker is not replayable: `readFrames` refuses
     * it as `oversized` and `readTrace` reports the recording unavailable.
     * Markers apply to a log written as a recording only.
     *
     * The budget also holds every snapshot this store writes, so the marker
     * and the snapshot that recovers past it always fit, whatever the State's
     * size. A snapshot over the budget is written as a small head cell and its
     * State's JSON split across part rows (`<snapshot key>/part/<n>`), in the
     * same transaction, and restore joins them. When storage still rejects a
     * write with `SQLITE_TOOBIG`, the store first writes the frame as a marker,
     * then halves the row size it splits to, until a write lands or the size
     * would fall below 1024 bytes, when the rejection propagates. Must be a
     * safe integer of at least 1024. A Durable Object row holds at most 8 MB.
     * Default: no budget; every frame and snapshot is written as it encodes.
     */
    readonly maxRowBytes?: number;
  };
  /**
   * Hears a recording whose last frames cannot be rebuilt, once per `load()`,
   * and each frame a save replaced with an oversized marker (`maxRowBytes`).
   * Evidence is not State: the Msgs and the snapshot rebuild the State exactly,
   * so restore still succeeds and the next frame is written whole, as a new
   * basis for the frames after it. This reports which frames are broken; a read
   * of them with `readFrames` still refuses them. Default: a `console.warn`.
   * A hook that throws or rejects is warned about and fails neither the restore
   * nor the save, and the frames after it are still written.
   */
  readonly onRecordingBreak?: (broken: RecordingBreak) => void;
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
   * `stop()`) appends nothing, except that the boot save of a recording
   * (`recording`) appends an `init` frame; a recording's frames are not Msgs,
   * so restore skips them. A write that fails rejects the save and leaves the
   * stored bytes as they were. `migrate` forwards to `parse`.
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
 * frame of a recording it is the size of the Msg JSON inside it. A cell refused
 * as `oversized` is the marker written in place of a frame too large for its
 * row; its `bytes` is the size measured for the frame that was not written.
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
      readonly bytes?: number;
    };

/**
 * One stored cell read as a frame of the log. A `message` is a cell of a log
 * written as bare messages, with no evidence. An `init` or `step` frame is a
 * recording frame; its `evidence` is rebuilt only when the read asked for it.
 * `serializedBytes` is the UTF-8 size of the whole stored text and
 * `messageBytes` the size of the Msg JSON inside it. An `init` frame at a
 * moved anchor carries `skipped`, the transitions before it; a boot has none.
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
      readonly skipped?: number;
      readonly encoding: EvidenceEncoding;
      readonly evidence?: FrameEvidence;
    }
  | Extract<StoredEvent<M>, { _tag: "refused" }>;

/**
 * Where a recording's evidence is broken. With `frame`, `basis` or `checksum`,
 * the evidence cannot be rebuilt where the next frame would take its delta
 * from: frames `fromSeq` to `toSeq` (the log's last) are the ones that depend
 * on the first frame that does not rebuild, and `reason` is the refusal
 * {@link EventLogReader.readFrames} gives that frame. With `oversized`, a save
 * wrote a refusal marker at `seq` in place of a frame of `bytes` bytes (its
 * key plus its encoded cell); `fromSeq` and `toSeq` are both `seq`, and `seq`
 * and `bytes` are present only then.
 */
export interface RecordingBreak {
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly reason: FrameRefusal;
  readonly seq?: number;
  readonly bytes?: number;
}

/**
 * Why {@link readTrace} has no trace to give: the log or range is empty
 * (`empty`), it is written as bare messages (`messages`), its first frame is
 * not an `init` frame (`anchor`), a second `init` frame opens another boot
 * (`boot`), a seq inside the range has no cell (`gap`), the cells stop before
 * the committed head (`tail`), or a frame is refused, with the refusal
 * `readFrames` gives it, `oversized` among them.
 */
export type TraceUnavailableReason =
  | StoredEventRefusal
  | "empty"
  | "messages"
  | "anchor"
  | "boot"
  | "gap"
  | "tail";

/**
 * What {@link readTrace} reads back: a whole `Trace`, or why
 * the recording cannot be replayed. A recording with any frame missing is
 * `unavailable`, never a trace of the frames before it.
 */
export type RecordedTrace<S, M> =
  | { readonly _tag: "trace"; readonly trace: Trace<S, M> }
  | {
      readonly _tag: "unavailable";
      readonly seq: number | null;
      readonly reason: TraceUnavailableReason;
      readonly bytes?: number;
    };

/** The evidence bytes a delta is taken from, or why there are none. */
interface BasisRead {
  readonly basis: Basis | null;
  readonly broken: RecordingBreak | null;
}

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

async function firstCell(
  storage: DurableObjectStorage,
  eventPrefix: string,
  noCache: boolean,
  atOne?: unknown,
): Promise<unknown> {
  const one =
    atOne !== undefined
      ? atOne
      : await storage.get<unknown>(
          eventKey(eventPrefix, 1),
          noCache ? { noCache } : {},
        );
  if (one !== undefined && one !== null) return one;
  const rows = await storage.list<unknown>({
    prefix: eventPrefix,
    limit: 1,
    ...(noCache ? { noCache } : {}),
  });
  for (const [, value] of rows) return value;
  return undefined;
}

function rowSize(key: string, value: string): number {
  return utf8.encode(key).byteLength + utf8.encode(value).byteLength;
}

function isTooBig(thrown: unknown): boolean {
  let at: unknown = thrown;
  for (
    let depth = 0;
    depth < 4 && at !== null && at !== undefined;
    depth += 1
  ) {
    const message =
      at instanceof Error ? at.message : typeof at === "string" ? at : "";
    if (message.includes("SQLITE_TOOBIG")) return true;
    at = at instanceof Error ? at.cause : undefined;
  }
  return false;
}

type Refused = Extract<StoredFrame<never>, { _tag: "refused" }>;

/** A recording cell's text, parsed, with the seq its key names; or why it is not one. */
function openRecordingCell(
  eventPrefix: string,
  key: string,
  value: string,
):
  | Refused
  | {
      readonly seq: number;
      readonly serializedBytes: number;
      readonly raw: unknown;
    } {
  const serializedBytes = utf8.encode(value).byteLength;
  const seq = Number(key.slice(eventPrefix.length));
  const refused = (reason: Refused["reason"], cause?: unknown): Refused => ({
    _tag: "refused",
    key,
    seq: Number.isSafeInteger(seq) ? seq : null,
    serializedBytes,
    reason,
    ...(cause === undefined ? {} : { cause }),
  });
  if (!Number.isSafeInteger(seq)) return refused("key");
  if (!value.startsWith(RECORDING_PREFIX)) return refused("frame");
  try {
    return { seq, serializedBytes, raw: JSON.parse(value) };
  } catch (cause) {
    return refused("json", cause);
  }
}

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
  const opened = openRecordingCell(eventPrefix, key, value);
  if ("_tag" in opened) return { frame: opened, encoded: null };
  const { seq, serializedBytes } = opened;
  const refused = (reason: Refused["reason"]) => ({
    frame: {
      _tag: "refused",
      key,
      seq,
      serializedBytes,
      reason,
    } satisfies Refused,
    encoded: null,
  });
  const marker = oversizedAt(seq, opened.raw);
  if (marker !== null) {
    return {
      frame: {
        _tag: "refused",
        key,
        seq,
        serializedBytes,
        reason: "oversized",
        bytes: marker.bytes,
      },
      encoded: null,
    };
  }
  const encoded = parseFrame(opened.raw);
  if (encoded === null) return refused("frame");
  const { encoding } = encoded.evidence;
  if (encoded.frame === "init") {
    const { restored, provenance, skipped } = encoded;
    return {
      frame: {
        _tag: "init",
        key,
        seq,
        serializedBytes,
        restored,
        provenance,
        ...(skipped > 0 ? { skipped } : {}),
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

function oversizedAt(seq: number, raw: unknown): OversizedMarker | null {
  const cell = parseCellMsg(raw);
  return cell?.frame === "oversized" && cell.seq === seq ? cell : null;
}

/** What a fold of a log's Msgs takes from one cell: nothing (an init frame), a Msg, or why it cannot. */
type FoldCell<M> =
  | { readonly _tag: "init" }
  | { readonly _tag: "decoded"; readonly event: M }
  | Refused;

/**
 * Decode one stored cell for a fold of the log's Msgs. A recording cell's
 * evidence is not read, so a cell whose evidence is unreadable still gives its
 * Msg: the Msgs and the snapshot rebuild the State, whatever the evidence holds.
 */
function decodeFoldCell<M>(
  eventPrefix: string,
  parseEvent: (raw: unknown) => M | null,
  key: string,
  value: unknown,
): FoldCell<M> {
  if (typeof value !== "string" || cellFormatOf(value) === "messages") {
    const stored = decodeStoredEvent(eventPrefix, parseEvent, key, value);
    return stored._tag === "refused"
      ? stored
      : { _tag: "decoded", event: stored.event };
  }
  const opened = openRecordingCell(eventPrefix, key, value);
  if ("_tag" in opened) return opened;
  const refused = (reason: Refused["reason"]): Refused => ({
    _tag: "refused",
    key,
    seq: opened.seq,
    serializedBytes: opened.serializedBytes,
    reason,
  });
  const cell = parseCellMsg(opened.raw);
  if (cell === null) return refused("frame");
  if (cell.frame === "oversized") {
    if (cell.seq !== opened.seq) return refused("frame");
    return cell.of === "init" ? { _tag: "init" } : refused("oversized");
  }
  if (cell.frame === "init") return { _tag: "init" };
  const event = parseEvent(cell.msg);
  return event === null ? refused("event") : { _tag: "decoded", event };
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
 * The reader, and the two reads the writing store also needs: the evidence
 * bytes of the frame before `seq`, which the next delta is taken from, and the
 * cells after `afterSeq` as a fold of the Msgs reads them.
 */
function openLogReader<M extends { _tag: string }>(
  storage: DurableObjectStorage,
  opts: EventLogReaderOptions<M>,
): {
  readonly reader: EventLogReader<M>;
  basisBefore(seq: number): Promise<BasisRead>;
  foldCells(afterSeq: number): AsyncGenerator<FoldCell<M>>;
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
    const first =
      meta === undefined || meta === null
        ? cells.get(firstKey)
        : await firstCell(
            storage,
            eventPrefix,
            true,
            cells.get(firstKey) ?? null,
          );
    const absent = (
      cell: string | undefined | null,
    ): cell is undefined | null => cell === undefined || cell === null;
    if (absent(meta) && absent(snapshot)) return null;
    return {
      lastSeq: absent(meta) ? 0 : parseMeta(meta),
      snapshot: !absent(snapshot),
      format:
        first === undefined || first === null ? null : cellFormatOf(first),
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

  async function basisBefore(seq: number): Promise<BasisRead> {
    if (seq <= 1) return { basis: null, broken: null };
    const toSeq = seq - 1;
    const broke = (
      fromSeq: number,
      reason: Exclude<FrameRefusal, "oversized">,
    ): BasisRead => ({
      basis: null,
      broken: { fromSeq, toSeq, reason },
    });
    const rows = await storage.list<unknown>({
      prefix: eventPrefix,
      end: eventKey(eventPrefix, seq),
      reverse: true,
      limit: FULL_FRAME_EVERY,
      noCache: true,
    });
    // Walk back to the last whole frame, then rebuild forward from it.
    const chain: (readonly [number, EncodedFrame])[] = [];
    let expected = toSeq;
    for (const [key, value] of rows) {
      const { frame, encoded } = decodeStoredFrame(
        eventPrefix,
        parseEvent,
        key,
        value,
      );
      if (frame.seq !== expected) return broke(expected, "basis");
      if (frame._tag === "refused" && frame.reason === "oversized") {
        return chain.length === 0
          ? { basis: null, broken: null }
          : broke(expected, "basis");
      }
      if (encoded === null) return broke(expected, "frame");
      chain.push([expected, encoded]);
      if (encoded.evidence.encoding === "full") break;
      expected -= 1;
    }
    if (chain.length === 0) return broke(toSeq, "basis");
    let basis: Basis | null = null;
    for (const [at, encoded] of chain.reverse()) {
      const rebuilt = await rebuildEvidence(at, encoded.evidence, basis);
      if (typeof rebuilt === "string") return broke(at, rebuilt);
      basis = rebuilt;
    }
    return { basis, broken: null };
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
        basis = (await basisBefore(frame.seq)).basis;
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

  async function* foldCells(afterSeq: number): AsyncGenerator<FoldCell<M>> {
    for await (const [key, value] of listCells(
      { fromSeq: afterSeq + 1 },
      false,
    )) {
      yield decodeFoldCell(eventPrefix, parseEvent, key, value);
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
    foldCells,
  };
}

/**
 * Read a recording back as the `Trace` it was written from, for `replayTrace`.
 *
 * The committed head is read first and bounds the read. The range's first
 * frame is the anchor and must be an `init` frame: its State is `loaded` and
 * its `skipped` the trace's `skipped`, so a trace written with `writeTrace`
 * reads back as it was dumped. Each `step` frame after it gives a Msg and a
 * step with its State and Cmds, and `finalState` is the last State.
 *
 * The answer is a whole trace or `unavailable` at a seq, never a prefix: every
 * seq from the anchor (or `range.fromSeq`) to the committed head (or
 * `range.toSeq`, when lower) must hold a frame that reads. A missing cell inside
 * the range is a `gap`, cells that stop before the head are a `tail`, and a
 * second boot, a bare message or any refused frame (an `oversized` marker, a
 * delta that does not rebuild) is unavailable at its seq. To read the boot
 * after a restart, start the range at its `init` frame.
 *
 * ```ts
 * const back = await readTrace<State, Msg>(doEventLogReader<Msg>(storage));
 * if (back._tag === "trace") replayTrace(machine, back.trace);
 * ```
 */
export async function readTrace<S, M extends { _tag: string }>(
  reader: Pick<EventLogReader<M>, "readCommittedSeq" | "readFrames">,
  range: EventLogRange = {},
): Promise<RecordedTrace<S, M>> {
  const unavailable = (
    seq: number | null,
    reason: TraceUnavailableReason,
    bytes?: number,
  ): RecordedTrace<S, M> => ({
    _tag: "unavailable",
    seq,
    reason,
    ...(bytes === undefined ? {} : { bytes }),
  });
  const head = await reader.readCommittedSeq();
  const toSeq = Math.min(
    Math.floor(range.toSeq ?? Number.POSITIVE_INFINITY),
    head,
  );
  const fromSeq =
    range.fromSeq === undefined ? null : Math.max(1, Math.ceil(range.fromSeq));
  if (toSeq < 1 || (fromSeq !== null && fromSeq > toSeq)) {
    return unavailable(null, "empty");
  }
  let expected = fromSeq;
  let anchor: { readonly state: S; readonly skipped: number } | null = null;
  const steps: TraceStep<S, M>[] = [];
  for await (const frame of reader.readFrames(
    { fromSeq: fromSeq ?? 1, toSeq },
    { evidence: true },
  )) {
    const seq = frame.seq;
    if (seq === null) {
      return unavailable(null, frame._tag === "refused" ? frame.reason : "key");
    }
    if (expected !== null && seq !== expected) {
      return unavailable(expected, "gap");
    }
    expected = seq + 1;
    if (frame._tag === "refused") {
      return unavailable(frame.seq, frame.reason, frame.bytes);
    }
    if (frame._tag === "message") return unavailable(frame.seq, "messages");
    if (frame.evidence === undefined) return unavailable(frame.seq, "frame");
    const state = frame.evidence.state as S;
    if (frame._tag === "init") {
      if (anchor !== null) return unavailable(frame.seq, "boot");
      anchor = { state, skipped: frame.skipped ?? 0 };
      continue;
    }
    if (anchor === null) return unavailable(frame.seq, "anchor");
    const { cmds } = frame.evidence;
    steps.push(
      cmds === null
        ? { msg: frame.event, state }
        : { msg: frame.event, state, cmds: cmds as readonly Cmd[] },
    );
  }
  if (expected === null) return unavailable(null, "empty");
  if (expected <= toSeq) return unavailable(expected, "tail");
  if (anchor === null) return unavailable(null, "empty");
  return {
    _tag: "trace",
    trace: {
      loaded: anchor.state,
      ...(anchor.skipped > 0 ? { skipped: anchor.skipped } : {}),
      msgs: steps.map((step) => step.msg),
      finalState: steps.at(-1)?.state ?? anchor.state,
      steps,
    },
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
  const maxRowBytes = opts.recording?.maxRowBytes;
  if (
    maxRowBytes !== undefined &&
    (!Number.isSafeInteger(maxRowBytes) || maxRowBytes < MIN_ROW_BYTES)
  ) {
    throw new Error(
      `@demlik/tea/do: recording.maxRowBytes must be a safe integer >= ${MIN_ROW_BYTES}, got ${maxRowBytes}`,
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
  let snapshotParts: number | null = null;
  // The log's generation in this isolate: a `load()` takes it, and a write that
  // was called under an older one is refused at its write point (./save-fence).
  const fence = saveFence(storage, metaKey);
  // The format this log is written in, learned from its first cell (or, for a
  // log with none, from `recording`) and reset by every `load()`.
  let format: LogFormat | null = null;
  // The evidence bytes of the frame at `lastSeq`, which the next frame's delta
  // is taken from: `null` when a log is written as messages, or until one is
  // written whole.
  let basis: Basis | null = null;
  // The Msg events since the last snapshot, init frames not counted, so that
  // `snapshotEvery` counts the same events for either format. `null` until
  // `load()` has counted them.
  let sinceSnapshot: number | null = null;
  // Idempotency latch for onReady within a single activation.
  let readyFired = false;
  // One write at a time: `snapshotNow()` is called by the host, outside the
  // engine's serial tail, and must not interleave with a save.
  let writing: Promise<unknown> = Promise.resolve();
  // The read side of the log: the one owner of the event-key convention and
  // the stored-event decode, shared with hosts that read without loading.
  const { reader, basisBefore, foldCells } = openLogReader(storage, opts);

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
    if (raw === undefined || raw === null) {
      snapshotParts = 0;
      return { state: null, seq: 0 };
    }
    // Structural JSON malformation throws here, as in doStore — infra error,
    // not a schema mismatch.
    const cell = JSON.parse(raw) as SnapshotCell<unknown> &
      Partial<SnapshotPartsCell>;
    let state: unknown = cell.state;
    snapshotParts = 0;
    if (cell.parts !== undefined) {
      if (!Number.isSafeInteger(cell.parts) || cell.parts < 1) {
        throw new Error("@demlik/tea/do: invalid snapshot part count");
      }
      state = JSON.parse(await readParts(cell.parts));
      snapshotParts = cell.parts;
    }
    const parsed = parse(state);
    if (parsed === null)
      throw new Error("@demlik/tea/do: persisted snapshot was refused");
    if (!Number.isSafeInteger(cell.seq) || cell.seq < 0) {
      throw new Error("@demlik/tea/do: invalid snapshot sequence");
    }
    return { state: parsed, seq: cell.seq };
  }

  async function readParts(count: number): Promise<string> {
    let text = "";
    for (let from = 0; from < count; from += EVENT_PAGE_SIZE) {
      const keys = Array.from(
        { length: Math.min(EVENT_PAGE_SIZE, count - from) },
        (_, at) => partKey(from + at),
      );
      const found = await storage.get<string>(keys);
      for (const key of keys) {
        const part = found.get(key);
        if (typeof part !== "string") {
          throw new Error("@demlik/tea/do: a snapshot part is missing");
        }
        text += part;
      }
    }
    return text;
  }

  /**
   * Stream the persisted event log in `seq` order, bounded by the optional
   * inclusive `[fromSeq, toSeq]` range. Both the public
   * {@link EventSourcedStore.readEvents} and the private fold's `readLog` flow
   * through the shared {@link doEventLogReader}, so the prefix/decode rule
   * lives in exactly one place.
   */
  const readEvents = reader.readEvents;

  /**
   * Fold one decoded event at a time, retaining neither the tail nor its Cmds,
   * and count the init frames the fold skips. A recording cell that is not a
   * frame refuses the restore, as text that is not JSON does. A cell whose
   * evidence is unreadable does not: the fold reads only its Msg, and the break
   * is reported from the frames before the head.
   */
  async function readLog(
    state: S,
    afterSeq: number,
  ): Promise<{ state: S; inits: number }> {
    let inits = 0;
    for await (const cell of foldCells(afterSeq)) {
      if (cell._tag === "init") {
        inits += 1;
        continue;
      }
      if (cell._tag === "refused") {
        if (cell.reason === "json") throw cell.cause;
        if (cell.reason === "frame") {
          throw new Error("@demlik/tea/do: recording frame was refused");
        }
        if (cell.reason === "oversized") {
          throw new Error(
            `@demlik/tea/do: the step at ${cell.seq} was not kept (oversized) and no snapshot covers it`,
          );
        }
        continue;
      }
      state = foldMsgs(machine, state, [cell.event]);
    }
    return { state, inits };
  }

  /** The format this log is written in: its first cell's, or `recording`'s when it has none. */
  async function ensureFormat(): Promise<LogFormat> {
    if (format !== null) return format;
    const first = await firstCell(storage, eventPrefix, false);
    format =
      first === undefined || first === null
        ? opts.recording === undefined
          ? "messages"
          : "recording"
        : cellFormatOf(first);
    return format;
  }

  /** Tell the host where the evidence is broken; a hook that throws is warned about, not fatal. */
  function hearBreak(broken: RecordingBreak): void {
    const hear =
      opts.onRecordingBreak ??
      ((b: RecordingBreak) =>
        console.warn(
          b.reason === "oversized"
            ? `@demlik/tea/do: the recording's frame ${b.seq} measured ${b.bytes} bytes, over its row budget; a refusal marker was written in its place and the next frame is written whole`
            : `@demlik/tea/do: the recording's evidence cannot be rebuilt for frames ${b.fromSeq} to ${b.toSeq} (${b.reason}); the next frame is written whole`,
        ));
    try {
      void Promise.resolve(hear(broken)).catch((thrown: unknown) => {
        console.warn(thrown);
      });
    } catch (thrown) {
      console.warn(thrown);
    }
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
    const { state, inits } = await readLog(initialState, snapSeq);
    if (parse(state) === null) {
      throw new Error("@demlik/tea/do: recovered state was refused");
    }
    format = null;
    const written = await ensureFormat();
    const next: BasisRead =
      written === "recording"
        ? await basisBefore(committedSeq + 1)
        : { basis: null, broken: null };
    if (next.broken !== null) hearBreak(next.broken);
    latestState = state;
    lastSeq = committedSeq;
    snapshotSeq = snapSeq;
    basis = next.basis;
    sinceSnapshot = Math.max(0, committedSeq - snapSeq - inits);
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

    async save(
      state: S,
      msg?: unknown,
      boundary?: SaveBoundary,
    ): Promise<void> {
      const init = boundary?._tag === "init" ? boundary : null;
      const skipped = init?.skipped ?? 0;
      if (
        !Number.isSafeInteger(skipped) ||
        skipped < 0 ||
        !Number.isSafeInteger(skipped + 1)
      ) {
        throw new Error(
          `@demlik/tea/do: an init boundary's skipped count must be an integer >= 0 that leaves a safe sequence after it, got ${skipped}`,
        );
      }
      const moved = skipped > 0;
      // The flush at `stop()` has no event to write. The boot save has none
      // either, unless the log is a recording, which opens each boot with a frame.
      if (
        msg === undefined &&
        (init === null || (opts.recording === undefined && !moved))
      )
        return;
      const admit = fence.issue();
      await exclusive(async () => {
        const prior = await ensureLastSeq();
        if (moved && prior > 0) {
          throw new Error(
            `@demlik/tea/do: a moved anchor (skipped ${skipped}) opens an empty log only; this log has frames up to ${prior}`,
          );
        }
        const seq = moved ? skipped + 1 : prior + 1;
        if (!Number.isSafeInteger(seq)) {
          throw new Error(
            `@demlik/tea/do: the log's next sequence ${seq} is not a safe integer`,
          );
        }
        const written = await ensureFormat();
        if (init !== null && written !== "recording") {
          // A log written as messages never gets a frame: its evidence is not invented.
          if (!moved) return;
          await persistFitting(
            () => ({ committed: skipped, snapshot: { seq: skipped, state } }),
            admit,
            false,
          );
          lastSeq = skipped;
          latestState = state;
          snapshotSeq = skipped;
          sinceSnapshot = 0;
          return;
        }
        // Count-based retention (Akka `RetentionCriteria.snapshotEvery`). When
        // the Msg events since the last snapshot reach `snapshotEvery`,
        // checkpoint the post-this-event State under THIS seq, in the same
        // transaction as the event, so the snapshot's `seq` and `state` agree
        // and the recovery fold replays only events strictly after `seq`. A
        // snapshot bounds replay length; it never changes the fold's result
        // (snapshotting.md). An init frame is not an event and is never one.
        const since = sinceSnapshot ?? seq - 1 - snapshotSeq;
        const snapshotDue = init === null && since + 1 >= snapshotEvery;
        const cell =
          written === "messages"
            ? { json: JSON.stringify(msg), basis: null }
            : await encodeFrame(
                seq,
                init === null
                  ? { frame: "step", msgJson: JSON.stringify(msg) }
                  : {
                      frame: "init",
                      restored: prior > 0,
                      provenance: opts.recording?.provenance ?? null,
                      ...(moved ? { skipped } : {}),
                    },
                {
                  state,
                  cmds:
                    boundary !== undefined && "cmds" in boundary
                      ? boundary.cmds
                      : null,
                },
                basis,
              );
        const budgeted = maxRowBytes !== undefined && written === "recording";
        const bytes = budgeted
          ? rowSize(eventKey(eventPrefix, seq), cell.json)
          : 0;
        const over: OversizedMarker = {
          of: init === null ? "step" : "init",
          seq,
          bytes,
        };
        const measured = budgeted && bytes > maxRowBytes;
        const marked = await persistFitting(
          (retried) => {
            const marker = measured || retried ? over : null;
            return {
              event: {
                seq,
                json: marker === null ? cell.json : encodeOversized(marker),
              },
              snapshot:
                moved || snapshotDue || marker?.of === "step"
                  ? { seq, state }
                  : null,
            };
          },
          admit,
          budgeted && !measured,
        );
        const marker = measured || marked ? over : null;
        lastSeq = seq;
        basis = marker === null ? cell.basis : null;
        if (init !== null) {
          if (moved) {
            latestState = state;
            snapshotSeq = seq;
          }
          sinceSnapshot = moved ? 0 : since;
        } else {
          const snapped = snapshotDue || marker !== null;
          latestState = state;
          sinceSnapshot = snapped ? 0 : since + 1;
          if (snapped) snapshotSeq = seq;
        }
        if (marker !== null) {
          hearBreak({
            fromSeq: seq,
            toSeq: seq,
            reason: "oversized",
            seq,
            bytes: marker.bytes,
          });
        }
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
      readonly committed?: number;
      readonly snapshot: { readonly seq: number; readonly state: S } | null;
    },
    admit: () => void,
    rowBytes: number | null = null,
  ): Promise<void> {
    const cells: [string, string][] = [];
    let stale: string[] = [];
    let parts = snapshotParts;
    if (write.event !== undefined) {
      cells.push([eventKey(eventPrefix, write.event.seq), write.event.json]);
    }
    const committed = write.event?.seq ?? write.committed;
    if (committed !== undefined) {
      cells.push([
        metaKey,
        JSON.stringify({ lastSeq: committed } satisfies MetaCell),
      ]);
    }
    if (write.snapshot !== null) {
      const cell: SnapshotCell<S> = write.snapshot;
      const json = JSON.stringify(cell);
      const split =
        rowBytes === null || rowBytes >= rowSize(snapshotKey, json)
          ? null
          : splitRows(JSON.stringify(cell.state), rowBytes);
      const before = snapshotParts ?? (await storedSnapshotParts());
      if (split === null) {
        cells.push([snapshotKey, json]);
        parts = 0;
      } else {
        cells.push([
          snapshotKey,
          JSON.stringify({
            seq: cell.seq,
            parts: split.length,
          } satisfies SnapshotPartsCell),
        ]);
        for (const [at, part] of split.entries()) {
          cells.push([partKey(at), part]);
        }
        parts = split.length;
      }
      const kept = parts;
      stale = Array.from({ length: Math.max(0, before - kept) }, (_, at) =>
        partKey(kept + at),
      );
    }
    await storage.transaction(async (txn) => {
      admit();
      for (const [key, value] of cells) await txn.put(key, value);
      for (const key of stale) await txn.delete(key);
    });
    snapshotParts = parts;
  }

  function partKey(at: number): string {
    return `${snapshotKey}/part/${String(at).padStart(PART_WIDTH, "0")}`;
  }

  function splitRows(text: string, rowBytes: number): string[] {
    const room = rowBytes - utf8.encode(partKey(0)).byteLength;
    if (room < 4) {
      throw new Error("@demlik/tea/do: a snapshot part has no room in its row");
    }
    const rows: string[] = [];
    let start = 0;
    let used = 0;
    let at = 0;
    while (at < text.length) {
      const code = text.codePointAt(at) as number;
      const width = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
      const step = code >= 0x10000 ? 2 : 1;
      if (used + width > room) {
        rows.push(text.slice(start, at));
        start = at;
        used = 0;
      }
      used += width;
      at += step;
    }
    rows.push(text.slice(start));
    return rows;
  }

  async function storedSnapshotParts(): Promise<number> {
    const raw = await storage.get<string>(snapshotKey);
    if (raw === undefined || raw === null) return 0;
    const cell = JSON.parse(raw) as Partial<SnapshotPartsCell>;
    return typeof cell.parts === "number" && Number.isSafeInteger(cell.parts)
      ? cell.parts
      : 0;
  }

  async function persistFitting(
    build: (mark: boolean) => Parameters<typeof persist>[0],
    admit: () => void,
    canMark: boolean,
  ): Promise<boolean> {
    let rowBytes = maxRowBytes ?? null;
    let mark = false;
    for (;;) {
      try {
        await persist(build(mark), admit, rowBytes);
        return mark;
      } catch (thrown) {
        if (rowBytes === null || !isTooBig(thrown)) throw thrown;
        if (canMark && !mark) {
          mark = true;
          continue;
        }
        rowBytes = Math.floor(rowBytes / 2);
        if (rowBytes < MIN_ROW_BYTES) throw thrown;
      }
    }
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
      const state = latestState;
      await persistFitting(() => ({ snapshot: { seq, state } }), admit, false);
      snapshotSeq = seq;
      sinceSnapshot = 0;
      return true;
    });
  }

  return { store, snapshotNow, readEvents, getCommittedSeq: ensureLastSeq };
}
