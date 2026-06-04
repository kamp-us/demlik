/**
 * @demlik/tea/batch-window — coalesce a stream of items into size- or
 * time-bounded BATCHES, then flush each batch as a single Cmd.
 *
 * What this module actually DELEGATES to, vs. what it merely RE-EXPORTS:
 *
 *   - `../deadline` — REAL delegation (the only one). The window timer IS a
 *     `deadline` Sub: `subsFor` returns `deadlineSub` keyed on the window's
 *     identity, the subscribe cell is `subscribeDeadline` verbatim, and the
 *     expiry Msg is `deadlineExceeded`. Nothing about the timer is redrawn here.
 *     "Fire at an absolute instant, even across a rehydrate" is exactly
 *     `deadline`'s absolute-target lifecycle: a late subscribe (post-`Store`
 *     rehydrate) recomputes the remaining delay from the current clock and still
 *     fires at the correct moment.
 *   - `../work-queue` — TYPE re-export only, NOT a sink this module calls. A
 *     flush emits a Cmd; the CONSUMER's interpret handler is what enqueues onto a
 *     `createQueue(store)`. This module never touches queue status — it has no
 *     queue state and no status flip to delegate. It re-exports `EnqueueInput<I>`
 *     purely so the consumer's flush Cmd and queue agree on the item shape; any
 *     actual status flip belongs in the consumer and is delegated to
 *     `../work-queue/ops` there, not here.
 *   - `../debounce` — VALUE/TYPE re-export only, NOT wired into `update`. A
 *     bursty source (keystrokes, scroll, websocket frames) can be `debounce`d at
 *     the host BEFORE it ever becomes an `add` Msg, so the batch window only sees
 *     settled items. `debounce` is a sink transformer OUTSIDE `update`;
 *     batch-window is the durable, replayable half inside it. Re-exported for
 *     one-import ergonomics — this module does not call it.
 *
 * Why this is a knob and not hand-wired logic: the managed state (the buffer +
 * the window-open instant) lives in the Model, so it survives DO eviction /
 * reload (durable) and every transition is still a Msg through `update`
 * (replayable). A closure holding a `setTimeout` and a mutable array would break
 * both — banned. `add` / `onWindow` are PURE: time arrives as an `at`
 * parameter, never `Date.now()`; they return NEW slice values, never mutate.
 *
 * Typical wiring (combinator form):
 *
 *   const bw = createBatchWindow<LogLine, Msg>({
 *     maxItems: 100,
 *     maxMs: 5_000,
 *     flush: (items) => ({ type: "FlushBatch", items }),
 *   });
 *
 *   // Model:        { batch: BatchWindow<LogLine>, ... }
 *   // init:         (loaded) => [loaded ?? { batch: bw.init(), ... }, []]
 *   // update cells:
 *   //   LogArrived:   (s, m) => mapBatch(s, bw.add(s.batch, m.line, m.at))
 *   //   WindowFired:  (s, m) => mapBatch(s, bw.onWindow(s.batch, m.atMs))
 *   // subscriptions: (s) => bw.subs(s.batch)
 *   // subscribe:     { ...bw.handlers() }
 *
 * where `mapBatch(s, [batch, cmds]) => [{ ...s, batch }, cmds]` lifts the slice
 * transition into the consumer's Model. The `FlushBatch` Cmd's interpret handler
 * is the consumer's — it is where the batch meets I/O (an `enqueue`, a network
 * POST, an R2 write).
 *
 * NOT exported from the package root — reached via the `@demlik/tea/batch-window`
 * subpath, same one-shape-per-package rule as `deadline`, `cache`, and
 * `work-queue`.
 */

import type { Cmd } from "../index";

// `../debounce` re-export (value + type) for one-import ergonomics — see file
// header. This module does NOT call debounce; a consumer that wants to debounce
// a bursty source BEFORE it becomes an `add` Msg reaches it from the same import
// as the batch window.
export { type Debounced, debounce } from "../debounce";

import {
  type DeadlineExceeded,
  type DeadlineSub,
  deadlineExceeded,
  deadlineSub,
  subscribeDeadline,
} from "../deadline";
import type { SubscribeHandler } from "../subs/types";

// `../work-queue` TYPE re-export only (see file header). This module emits a
// flush Cmd; the CONSUMER's interpret handler enqueues onto a
// `createQueue(store)`. Re-export the caller-facing enqueue payload type so the
// consumer's flush Cmd and queue agree on the item shape.
export type { EnqueueInput } from "../work-queue";

/**
 * Configuration for a batch window — the knob. Pure config, no mutable state
 * (the `BatchWindow<I>` slice carries that). One config object is shared across
 * every window of one logical stream (often a module-scope const).
 *
 * `flush` is a pure Cmd CONSTRUCTOR, not a closure-with-state: it maps the
 * buffered items to the single Cmd the runtime performs when a window closes.
 * Keeping it a `(items) => Cmd` (not a `(items) => void`) is what keeps the
 * trigger replayable — the flush is a Cmd in the transition's output, never a
 * side effect inside the verb.
 */
export interface BatchWindowConfig<I, C extends Cmd> {
  /**
   * Size trigger. A batch flushes the instant its buffer reaches `maxItems`,
   * WITHOUT waiting for the time window — the classic "send as soon as the
   * page is full" cutoff. Must be `>= 1`; a config of `maxItems: 0` would flush
   * an empty batch on every `add`, which is never useful, so callers treat `1`
   * as the floor (the verb still behaves: with `maxItems <= 1` every item
   * flushes on arrival, a degenerate but legal "no batching" window).
   */
  readonly maxItems: number;
  /**
   * Time trigger, in milliseconds. A batch flushes no later than `openedAt +
   * maxMs` — `openedAt` being the `at` of the item that opened the window. This
   * is the latency ceiling: an item never waits longer than `maxMs` to ship,
   * even if the buffer never reaches `maxItems`.
   */
  readonly maxMs: number;
  /**
   * Map a flushed batch to the single Cmd the runtime performs. Called with the
   * buffered items in arrival order; the returned Cmd is what `add` / `onWindow`
   * emit when a window closes. PURE constructor — no I/O, no clock; the I/O
   * happens later in the consumer's interpret handler for the returned Cmd.
   */
  readonly flush: (items: readonly I[]) => C;
}

/**
 * The Model slice a batch window owns. `buffer` is the items accumulated for the
 * current open window; `openedAt` is the `at` of the item that OPENED it (the
 * anchor the time trigger measures against), or `null` when the window is
 * closed (buffer empty). The pair is the single source of truth for "is a
 * window open, and when must it flush by?" — both plain data so the whole slice
 * is trivially JSON-serializable into a consumer's `Store<S>`.
 *
 * Invariant the verbs preserve: `buffer.length === 0` IFF `openedAt === null`.
 * A non-empty buffer always has an `openedAt`; an empty buffer never does. The
 * window timer Sub keys its arm/disarm off exactly this invariant.
 */
export interface BatchWindow<I> {
  readonly buffer: readonly I[];
  readonly openedAt: number | null;
}

/** The starting slice: closed window, empty buffer. */
export function initBatchWindow<I>(): BatchWindow<I> {
  return { buffer: [], openedAt: null };
}

/**
 * The Sub a batch window's open timer produces: it IS `../deadline`'s
 * `DeadlineSub`, not a re-tagged copy. `atMs` is the absolute flush-by instant
 * (`openedAt + maxMs`). Aliasing the deadline type (rather than redeclaring an
 * identical shape) is what lets `subsFor` return `deadlineSub(...)` with no
 * cast — the value's static type already satisfies this name. Consumers running
 * several windows route each one by the Sub's `id`, not by a distinct type.
 */
export type BatchWindowSub = DeadlineSub;

/** The Msg a closed-by-time window dispatches. Alias of `deadline`'s Msg. */
export type BatchWindowExpired = DeadlineExceeded;

/**
 * Construct the window-expired Msg for the window identified by `id`, flushing
 * by `atMs`. Re-exported alias of `deadlineExceeded` so the subscribe cell and
 * the consumer's reducer share one constructor rather than two literals that
 * can drift. The consumer handles it in a reducer cell by calling `onWindow`.
 */
export function batchWindowExpired(
  id: string,
  atMs: number,
): BatchWindowExpired {
  return deadlineExceeded(id, atMs);
}

/**
 * The bound knob returned by `createBatchWindow`. `init` + the two pure verbs +
 * `subs` + `handlers`, all closing over one `BatchWindowConfig`. The verbs
 * return `readonly [BatchWindow<I>, readonly C[]]`: the next slice and the Cmds
 * to emit (one `flush` Cmd when a window closes, none otherwise).
 */
export interface BatchWindowKnob<I, C extends Cmd> {
  /** The starting slice — `initBatchWindow()`. */
  init(): BatchWindow<I>;
  /**
   * Buffer `item` (arrival-stamped `at`), flushing immediately if that brings
   * the buffer to `maxItems`. See `addItem`.
   */
  add(
    state: BatchWindow<I>,
    item: I,
    at: number,
  ): readonly [BatchWindow<I>, readonly C[]];
  /**
   * Flush whatever is buffered because the time window closed. See `onWindow`.
   */
  onWindow(
    state: BatchWindow<I>,
    at: number,
  ): readonly [BatchWindow<I>, readonly C[]];
  /**
   * The window timer Sub, armed only while a window is open. See `subsFor`.
   * `id` keys the deadline so several windows on one machine route distinctly.
   */
  subs(state: BatchWindow<I>, id?: string): readonly BatchWindowSub[];
  /**
   * The `subscribe` cells this knob splices into `machine.subscribe`. One cell,
   * keyed `"deadline"`, delegating to `../deadline`'s subscribe handler. Spread
   * into the consumer's subscribe map: `subscribe: { ...bw.handlers() }`.
   */
  handlers(): {
    deadline: SubscribeHandler<BatchWindowSub, BatchWindowExpired, unknown>;
  };
}

/**
 * Buffer `item` and decide whether the size trigger fires. PURE.
 *
 * - Empty (closed) window → `item` OPENS it: `openedAt` becomes `at`, buffer
 *   becomes `[item]`. This is the anchor the time window measures against.
 * - Open window → `item` appends; `openedAt` is left untouched (the window's
 *   latency clock keeps running from the FIRST item, not this one).
 *
 * After buffering, if the buffer has reached `maxItems` the window flushes
 * immediately: emit `config.flush(buffer)` and RESET to the closed slice. The
 * size trigger pre-empts the time trigger — a full page ships now, the window
 * Sub for the (now closed) window disarms on the next reconcile because `subs`
 * returns `[]` for an empty buffer.
 *
 * `maxItems <= 1` is the degenerate "no batching" case: every item flushes on
 * arrival (buffer reaches 1 immediately). Legal and useful as a feature flag to
 * disable batching without restructuring the wiring.
 *
 * @param config the knob (maxItems / flush constructor)
 * @param state  the current slice
 * @param item   the item to buffer
 * @param at     the arrival instant (epoch ms) — the caller stamps it; the verb
 *               never reads the clock
 */
export function addItem<I, C extends Cmd>(
  config: BatchWindowConfig<I, C>,
  state: BatchWindow<I>,
  item: I,
  at: number,
): readonly [BatchWindow<I>, readonly C[]] {
  const buffer = [...state.buffer, item];
  // A closed window opens at THIS item's `at`; an already-open window keeps its
  // original `openedAt` (the latency clock runs from the first item).
  const openedAt = state.openedAt ?? at;

  // Size trigger: a full page ships now, regardless of the time window. The
  // floor of 1 means `maxItems <= 1` flushes every item on arrival.
  if (buffer.length >= Math.max(1, config.maxItems)) {
    return [initBatchWindow<I>(), [config.flush(buffer)]];
  }

  return [{ buffer, openedAt }, []];
}

/**
 * Flush the open window because its time bound was reached. PURE.
 *
 * - Open window (buffer non-empty) → emit `config.flush(buffer)` and RESET to
 *   the closed slice.
 * - Closed window (buffer empty) → no-op: return the same slice and no Cmds.
 *   This guards the race where the size trigger already flushed and reset the
 *   window before the time Sub's Msg lands — a stale `onWindow` after a
 *   size-flush must NOT emit an empty batch.
 *
 * `at` is accepted for symmetry with `add` and so the consumer's reducer cell
 * has a uniform `(state, at)` shape; the verb doesn't need it for the flush
 * decision (the buffer's emptiness is the whole signal), but taking it keeps a
 * future "flush only if the window is genuinely past `openedAt + maxMs`"
 * tightening a non-breaking change.
 *
 * @param config the knob (flush constructor)
 * @param state  the current slice
 * @param at     the firing instant (epoch ms) — the caller stamps it; the verb
 *               never reads the clock
 */
export function onWindow<I, C extends Cmd>(
  config: BatchWindowConfig<I, C>,
  state: BatchWindow<I>,
  _at: number,
): readonly [BatchWindow<I>, readonly C[]] {
  // Empty buffer = the size trigger already flushed (or nothing arrived). A
  // stale timer Msg must not ship an empty batch — return the slice untouched.
  if (state.buffer.length === 0) return [state, []];
  return [initBatchWindow<I>(), [config.flush(state.buffer)]];
}

/**
 * The window timer Sub, derived from the slice. PURE.
 *
 * Returns the single `deadline` Sub targeting `openedAt + maxMs` while a window
 * is open (buffer non-empty), or `[]` while it is closed. The substrate's
 * reconcile pass arms the timer when the array gains the Sub and disarms it
 * (clearing the pending `setTimeout`) when the array loses it — so a size-flush
 * that empties the buffer auto-cancels the now-irrelevant time trigger on the
 * next transition.
 *
 * `id` defaults to `"batch-window"`; pass a distinct id per window when a
 * machine runs several so the dispatched `BatchWindowExpired` Msg (and its
 * reconcile identity) routes to the right one.
 *
 * @param config the knob (maxMs)
 * @param state  the current slice
 * @param id     stable identity for this window's timer (default
 *               `"batch-window"`)
 */
export function subsFor<I, C extends Cmd>(
  config: BatchWindowConfig<I, C>,
  state: BatchWindow<I>,
  id = "batch-window",
): readonly BatchWindowSub[] {
  // Closed window → no timer. The invariant (empty buffer IFF openedAt null)
  // means either check suffices; we read `openedAt` so the `atMs` arithmetic
  // below is non-null without a `!`. `deadlineSub` already returns a
  // `DeadlineSub`, which IS `BatchWindowSub` — no cast.
  if (state.openedAt === null) return [];
  return [deadlineSub(id, state.openedAt + config.maxMs)];
}

/**
 * The `subscribe["deadline"]` cell for a batch window's timer — the exact
 * `../deadline` handler. Arms a one-shot timer for `max(0, atMs - now)` and
 * dispatches `batchWindowExpired(...)`; returns a cleanup that clears it. The
 * consumer assigns it via the knob's `handlers()`.
 */
export const subscribeBatchWindow: SubscribeHandler<
  BatchWindowSub,
  BatchWindowExpired,
  unknown
> = subscribeDeadline;

/**
 * Build a batch window knob from a config. Combinator form (the default L2
 * ergonomic): hand it the config, splice the ~4 returned hooks into your
 * machine. The pure verbs (`add` / `onWindow`) close over the config so the
 * consumer's reducer cells stay a uniform `(state, ...args)` shape; `subs` /
 * `handlers` pre-wire the window timer.
 *
 * @typeParam I the item type buffered into each batch
 * @typeParam C the Cmd type `config.flush` returns
 */
export function createBatchWindow<I, C extends Cmd>(
  config: BatchWindowConfig<I, C>,
): BatchWindowKnob<I, C> {
  return {
    init: () => initBatchWindow<I>(),
    add: (state, item, at) => addItem(config, state, item, at),
    onWindow: (state, at) => onWindow(config, state, at),
    subs: (state, id) => subsFor(config, state, id),
    handlers: () => ({ deadline: subscribeBatchWindow }),
  };
}
