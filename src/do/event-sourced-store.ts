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
 *      (one cell per event, monotonically keyed).
 *   2. Takes a PERIODIC SNAPSHOT every `snapshotEvery` events (count-based
 *      retention — mirrors Akka `RetentionCriteria.snapshotEvery`) so the log
 *      that must replay on the next activation is bounded. A grain that needs
 *      replay bounded by ELAPSED TIME/TICKS rather than raw event count drives
 *      `snapshotNow()` instead (or alongside) — see that method.
 *   3. On activation REBUILDS state by FOLDING the log on top of the latest
 *      snapshot. The fold is the substrate's own `replay` — `init(snapshot)`
 *      then one reducer step per logged Msg. `replay` returns Cmds as data and
 *      never interprets them, so **side effects are suppressed on replay**
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
 *   // Append every applied Msg to the log. `observe` delivers only applied
 *   // Msgs now (#47) — boot has no event, so there is no `null` arm to skip.
 *   runtime.observe((msg) => { es.append(msg); });
 *   await runtime.ready; // store.load() has folded; onReady has fired once.
 *
 * A time/tick-driven grain (e.g. one that derives simulation ticks between
 * sparse intents) bounds its cold-wake replay by ELAPSED TIME rather than event
 * count by calling `es.snapshotNow()` on its own cadence — every N derived ticks
 * or on a wall-clock interval — so a quiet span that never trips `snapshotEvery`
 * is still snapshotted before its replay tail grows unbounded (#190):
 *
 *   // in the grain's tick loop, after the turn's appends have settled:
 *   if (tick % SNAPSHOT_EVERY_TICKS === 0) await es.snapshotNow();
 */

import type { Cmd, Machine, Store, Sub } from "../index";
import { replay } from "../index";

/** Default cell prefixes. Chosen to sort log keys lexicographically by seq. */
const DEFAULT_SNAPSHOT_KEY = "@@es/snapshot";
const DEFAULT_META_KEY = "@@es/meta";
const DEFAULT_EVENT_PREFIX = "@@es/evt/";
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

/**
 * Options for {@link doEventSourcedStore}.
 */
export interface EventSourcedOptions<S, M> {
  /**
   * Take a snapshot every N appended events (count-based retention, mirrors
   * Akka `RetentionCriteria.snapshotEvery`). A snapshot bounds how many events
   * replay on the next activation — it never changes the fold's result, only
   * its length (recovery.md). Must be >= 1. Default 100.
   */
  readonly snapshotEvery?: number;
  /**
   * Boundary parse for the persisted SNAPSHOT cell (the `S` blob). Same
   * contract as `doStore`'s `parse`: returns `S` on a recognized shape, `null`
   * on an unrecognized one (boot fresh), and must NOT throw. Default accepts
   * any non-null, non-array object as `S`.
   */
  readonly parse?: (raw: unknown) => S | null;
  /**
   * Boundary parse for a persisted EVENT (one logged `Msg`). Returns the `M` on
   * a recognized shape; returning `null` DROPS the event from replay (use for a
   * removed Msg variant). Must NOT throw. Default accepts any object carrying a
   * string `type` as `M`.
   */
  readonly parseEvent?: (raw: unknown) => M | null;
  /**
   * End-of-recovery hook (recovery.md `RecoveryCompleted`). Fires EXACTLY ONCE
   * per activation, after the fold completes, carrying the recovered state —
   * even when the log was empty (fresh actor). It may fire again on a later
   * activation, so it MUST be idempotent. Side effects that belong "once after
   * recovery" go here, never in the reducer (the reducer re-runs on every
   * replay).
   */
  readonly onReady?: (state: S) => void;
  /** Cell-key overrides (rarely needed; for coexisting actors in one DO). */
  readonly keys?: {
    readonly snapshot?: string;
    readonly meta?: string;
    readonly eventPrefix?: string;
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
 * `run(...)`, plus the append + recovery surface the cooperating DO drives.
 */
export interface EventSourcedStore<S, M> {
  /**
   * The `Store<S>` to pass as `run(machine, { ctx, store })`. Its `load()`
   * performs the fold (snapshot + log replay); its `save(state)` is the
   * count-based snapshot writer. `migrate` forwards to `parse`.
   */
  readonly store: Store<S>;
  /**
   * Append one applied `Msg` to the log. Call from `runtime.observe` for every
   * non-null msg. Resolves once the event is durably written. Triggers a
   * snapshot when the event count crosses a `snapshotEvery` boundary.
   */
  append(msg: M): Promise<void>;
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
   * It checkpoints the latest state the substrate handed `save()` at the current
   * highest sequence, then advances the count-based baseline (`snapshotEvery`
   * counts afresh from here, so a manual snapshot defers the next automatic one).
   *
   * Returns `true` if a snapshot was written, `false` on a no-op: nothing has
   * been applied yet (fresh actor), or no new event exists since the last
   * snapshot (already current). Like the count-based path, it pairs the held
   * state with the highest sequence, so the caller MUST invoke it between
   * settled transitions — after the turn's `append()`s have resolved — never
   * mid-transition (the same boundary discipline `append`'s own snapshot relies
   * on). Resolves once the snapshot is durably written.
   */
  snapshotNow(): Promise<boolean>;
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
  typeof (raw as { type?: unknown }).type === "string"
    ? (raw as M)
    : null;

/**
 * Build an event-sourced `Store<S>` over `DurableObjectStorage`.
 *
 * The substrate calls `store.load()` once at boot — that is where the fold
 * happens — and `store.save(state)` after every transition — that is where the
 * count-based snapshot is taken. The cooperating DO additionally calls
 * `append(msg)` from `runtime.observe` to grow the log.
 *
 * `machine` and `ctx` are required because the fold is `replay(machine, {
 * loaded: snapshot, msgs: log, ctx })` — the same pure reducer the live runtime
 * uses, so the rebuilt state is identical to the never-evicted state by
 * construction. `ctx` is only used to satisfy `init`'s signature during the
 * fold; an event-sourced machine's `init` rehydrate branch is a pure
 * passthrough (TEA invariant 2), so the fold touches nothing in `ctx`.
 */
// Cmd/Sub are erased to the substrate's base unions here: the fold only needs
// `init` + `update`, and pinning the machine's concrete C/U would force every
// caller to thread them through this factory. A `Machine<S, M, Cmd, Sub, Ctx>`
// accepts any machine whose Cmd/Sub are subtypes (they always are), and the
// machine keeps its precise types at its own definition site.
export function doEventSourcedStore<S, M extends { type: string }, Ctx>(
  storage: DurableObjectStorage,
  machine: Machine<S, M, Cmd, Sub, Ctx>,
  ctx: Ctx,
  opts: EventSourcedOptions<S, M> = {},
): EventSourcedStore<S, M> {
  const snapshotEvery = opts.snapshotEvery ?? 100;
  if (snapshotEvery < 1 || !Number.isInteger(snapshotEvery)) {
    throw new Error(
      `@demlik/tea/do: snapshotEvery must be an integer >= 1, got ${snapshotEvery}`,
    );
  }
  const parse = opts.parse ?? defaultParse;
  const parseEvent = opts.parseEvent ?? defaultParseEvent;
  const snapshotKey = opts.keys?.snapshot ?? DEFAULT_SNAPSHOT_KEY;
  const metaKey = opts.keys?.meta ?? DEFAULT_META_KEY;
  const eventPrefix = opts.keys?.eventPrefix ?? DEFAULT_EVENT_PREFIX;

  // In-memory mirror of the durable seq counter, set during load() and kept in
  // step by append(). Before load() it is unknown; append() lazily reads it.
  let lastSeq: number | null = null;
  // The seq the latest snapshot already folds (so we know the replay tail).
  let snapshotSeq = 0;
  // The latest state the substrate handed us via save(). The substrate calls
  // save(state) BEFORE the observer fires append(msg) for the same transition
  // (run()'s order: state=next → save → reconcile → interpret → observers), so
  // at append(N) time this holds the post-event-N state. The snapshot is taken
  // from the append path (not save) so its recorded `seq` and its `state` agree
  // on the same event boundary — recording seq at save time would lag the state
  // by one event and re-apply that event on recovery.
  let latestState: S | null = null;
  // Idempotency latch for onReady within a single activation.
  let readyFired = false;

  async function readMeta(): Promise<number> {
    const raw = await storage.get<string>(metaKey);
    if (raw === undefined || raw === null) return 0;
    const meta = JSON.parse(raw) as MetaCell;
    return typeof meta.lastSeq === "number" ? meta.lastSeq : 0;
  }

  /**
   * Read the persisted snapshot cell, parsed through the boundary. Returns the
   * folded state + the seq it covers, or `{ state: null, seq: 0 }` when absent
   * or unrecognized (fold then starts from a fresh `init`).
   */
  async function readSnapshot(): Promise<{ state: S | null; seq: number }> {
    const raw = await storage.get<string>(snapshotKey);
    if (raw === undefined || raw === null) return { state: null, seq: 0 };
    // Structural JSON malformation throws here, as in doStore — infra error,
    // not a schema mismatch.
    const cell = JSON.parse(raw) as SnapshotCell<unknown>;
    const parsed = parse(cell.state);
    if (parsed === null) return { state: null, seq: 0 };
    const seq = typeof cell.seq === "number" ? cell.seq : 0;
    return { state: parsed, seq };
  }

  /**
   * Stream the persisted event log in `seq` order, bounded by the optional
   * inclusive `[fromSeq, toSeq]` range. The single owner of the `@@es/evt/`
   * key convention on the read side — both the public {@link EventSourcedStore.readEvents}
   * and the private fold's `readLog` flow through it, so the prefix/decode rule
   * lives in exactly one place.
   */
  async function* readEvents(
    range: EventLogRange = {},
  ): AsyncGenerator<PersistedEvent<M>> {
    const fromSeq = range.fromSeq ?? Number.NEGATIVE_INFINITY;
    const toSeq = range.toSeq ?? Number.POSITIVE_INFINITY;
    // list() returns keys in lexicographic order; zero-padded seq keys sort by
    // sequence, so this is already seq-ascending. Bounds are matched on the
    // parsed seq (inclusive both ends).
    const rows = await storage.list<string>({ prefix: eventPrefix });
    for (const [key, value] of rows) {
      const seq = Number(key.slice(eventPrefix.length));
      if (!Number.isFinite(seq) || seq < fromSeq || seq > toSeq) continue;
      const decoded = parseEvent(JSON.parse(value));
      // A `null` decode drops a retired Msg variant (documented in parseEvent).
      if (decoded !== null) yield { seq, event: decoded };
    }
  }

  /** Read the logged events strictly after `afterSeq`, in seq order. */
  async function readLog(afterSeq: number): Promise<M[]> {
    // The replay tail is the public reader bounded to seqs > afterSeq — one
    // shared source for the key convention, no second `storage.list` walk.
    const events: M[] = [];
    for await (const { event } of readEvents({ fromSeq: afterSeq + 1 })) {
      events.push(event);
    }
    return events;
  }

  const store: Store<S> = {
    async load(): Promise<unknown> {
      const { state: snapshot, seq: snapSeq } = await readSnapshot();
      snapshotSeq = snapSeq;
      lastSeq = await readMeta();

      const events = await readLog(snapSeq);

      // THE FOLD. `replay` boots `init(snapshot, ctx)` then applies one reducer
      // step per event. It returns Cmds as data and never interprets them, so
      // no side effect fires on replay (recovery.md). The result is identical
      // to the live runtime's state for the same (snapshot, events) — same
      // reducer, same order.
      const { state } = replay(machine, {
        msgs: events,
        ctx,
        loaded: snapshot,
      });

      // RecoveryCompleted: fire once per activation, AFTER the fold, even when
      // the log + snapshot were both empty (fresh actor). Idempotent within the
      // activation via `readyFired`; may fire again on a future activation.
      if (!readyFired) {
        readyFired = true;
        opts.onReady?.(state);
      }

      // Returned as `unknown` and re-validated through `migrate` (= parse), same
      // boundary discipline as doStore. The substrate feeds it to `init` as
      // `loaded`, so the live `init` rehydrate branch runs on the folded state.
      return state;
    },

    async save(state: S): Promise<void> {
      // The substrate calls save() after every transition, BEFORE the observer
      // fires append() for that same transition. We don't snapshot here — we
      // only hold the latest state so the append path can pair it with the
      // freshly-advanced seq (see `latestState`). Holding (not snapshotting)
      // here is what keeps the snapshot's seq and state on the same boundary.
      latestState = state;
    },

    migrate(raw: unknown): S | null {
      return parse(raw);
    },
  };

  /**
   * Durably write the snapshot cell pairing `seq` with `state`, then advance the
   * in-memory `snapshotSeq` so the recovery fold replays only events strictly
   * after `seq`. Shared by the count-based path (in `append`) and the
   * time/tick-based path (`snapshotNow`) so both record the boundary the one,
   * identical way — a snapshot bounds replay length; it never changes the fold's
   * result (snapshotting.md).
   */
  async function writeSnapshot(seq: number, state: S): Promise<void> {
    const cell: SnapshotCell<S> = { seq, state };
    await storage.put(snapshotKey, JSON.stringify(cell));
    snapshotSeq = seq;
  }

  async function append(msg: M): Promise<void> {
    // Lazily learn the durable seq if append fires before any load() in this
    // isolate (defensive; the documented flow loads first).
    if (lastSeq === null) lastSeq = await readMeta();
    const seq = lastSeq + 1;
    lastSeq = seq;
    // Write the event then advance the meta cell. DO storage is transactional
    // within a single `alarm`/fetch turn; both puts land together.
    await storage.put(eventKey(eventPrefix, seq), JSON.stringify(msg));
    await storage.put(
      metaKey,
      JSON.stringify({ lastSeq: seq } satisfies MetaCell),
    );

    // Count-based retention (Akka `RetentionCriteria.snapshotEvery`). When the
    // events since the last snapshot reach `snapshotEvery`, checkpoint the
    // post-this-event state under THIS seq. `latestState` was set by the
    // save(state) that ran earlier in this same transition, so its state folds
    // exactly events 1..seq — recording `seq` here is consistent, and the
    // recovery fold replays only events strictly after `seq`. A snapshot bounds
    // replay length; it never changes the fold's result (snapshotting.md).
    if (seq - snapshotSeq >= snapshotEvery && latestState !== null) {
      await writeSnapshot(seq, latestState);
    }
  }

  /**
   * Time/tick-based snapshot trigger (#190) — checkpoint NOW, independent of the
   * count-based `snapshotEvery`. See {@link EventSourcedStore.snapshotNow}.
   */
  async function snapshotNow(): Promise<boolean> {
    // Lazily learn the durable seq if this fires before any load()/append() in
    // this isolate (defensive; the documented flow loads first).
    if (lastSeq === null) lastSeq = await readMeta();
    // No-op when there is nothing new to checkpoint: a fresh actor with no
    // applied state yet (`latestState === null`), or no event appended since the
    // last snapshot (`lastSeq <= snapshotSeq`). Both keep the snapshot's `seq`
    // and `state` paired on the same boundary the count-based path guarantees.
    if (latestState === null || lastSeq <= snapshotSeq) return false;
    await writeSnapshot(lastSeq, latestState);
    return true;
  }

  return { store, append, snapshotNow, readEvents };
}
