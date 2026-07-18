/**
 * @demlik/tea/fan-out — scatter-gather over a bounded-concurrency work list.
 *
 * The Level-2 combinator that fans a batch of items out across at most
 * `concurrency` in-flight effects, gathers each item's result (or error), and
 * — once every item has settled — fires an optional `join` over the collected
 * results. It is the "map a list through an effect, but never run more than N
 * at once" knob.
 *
 * The recipe (which bricks it composes):
 *   - `../work-queue` — fan-out's tracked items ARE work-queue items. Each
 *     item carries the same `{ id, status, input }` lifecycle vocabulary
 *     (`pending → running → done | failed`). The slice this knob owns is four
 *     partitions over that one lifecycle, so the work-queue's status taxonomy
 *     is the substrate rather than a parallel invention. We reuse its
 *     `QueueItem<I>` / `QueueItemStatus` TYPES and delegate the ledger
 *     transitions to the `QueueAdapter` verbs (`../work-queue/adapter`):
 *     `scatter` mints each pending record with `queue.enqueue`, and `launchUpTo`
 *     flips `pending → running` with `queue.claim` (one positional claim per
 *     launch). The lone exception is `settleOne`'s `running → done|failed`
 *     flip — it must match "first id-match that is still `running`" to settle
 *     exactly one of a DUPLICATE id, a status predicate the adapter verbs can't
 *     express, so fan-out owns that one index (see `settleOne`). The async
 *     `createQueue(store)` adapter is NOT used here because its `load → mutate
 *     → save` reads the clock and lives at an I/O boundary, while a combinator's
 *     verbs must be pure (invariant 2) — fan-out binds the pure `QueueAdapter`
 *     to its in-Model ledger instead, the same route `monitored-run` /
 *     `idempotent-intake` / `saga` take. The slice lives in the Model instead —
 *     durable + replayable, the two non-negotiables every knob preserves.
 *
 * Typical wiring (combinator form — splice the hooks into your machine):
 *
 *   const fan = createFanOut<Url, Report>({
 *     concurrency: 4,
 *     idOf: (url) => url,                                 // stable, pure identity
 *     of: (url) => ({ type: "crawl", url }),              // the per-item effect, as data
 *     join: (results) => ({ type: "report_done", results }),
 *   });
 *
 *   // in `update`:
 *   start_crawl:  (s, m) => { const [fanOut, cmds] = fan.scatter(s.fanOut, m.urls);
 *                             return [{ ...s, fanOut }, cmds]; },
 *   crawl_ok:     (s, m) => { const [fanOut, cmds] = fan.itemOk(s.fanOut, m.id, m.report);
 *                             return [{ ...s, fanOut }, cmds]; },
 *   crawl_err:    (s, m) => { const [fanOut, cmds] = fan.itemErr(s.fanOut, m.id, m.error);
 *                             return [{ ...s, fanOut }, cmds]; },
 *
 * Every verb is PURE: it returns a NEW slice plus the Cmds to perform (the
 * `of(item)` effects for newly-launched items, and at most one `join` Cmd when
 * the batch completes). The reducer never reads a clock or RNG — item identity
 * is supplied by the caller's `idOf` so `scatter` is deterministic, and the
 * launch effects are plain data the runtime performs (invariant 3).
 *
 * `handlers(ports)` is the I/O splice: it wires the runtime side that actually
 * runs each launched `of(item)` Cmd. Because `of` already produces a fully
 * caller-defined Cmd, fan-out does NOT own the interpret handler for it — the
 * consumer's own `interpret` performs the effect and routes Ok/Err back to the
 * `itemOk` / `itemErr` verbs (the same shape resilient-fetch uses with
 * `tryInterpret`). `handlers` therefore exposes the one piece fan-out CAN
 * pre-wire generically: emitting the gathered batch onto a typed Port when the
 * batch completes, for consumers that observe completion out-of-band rather
 * than through the `join` Cmd.
 *
 * NOT a substrate primitive: it depends only on `../work-queue`'s pure types +
 * blessed ops and `../index`'s `Cmd` / `Port` types. Consumers reach it via the
 * `@demlik/tea/fan-out` subpath.
 */

import { at } from "../at";
import type { Cmd, Port } from "../index";
import type { QueueItem, QueueItemStatus } from "../work-queue";
import { queueAdapter } from "../work-queue/adapter";

/**
 * One settled-OK item: the original `input` and the `result` its effect
 * produced. Mirrors the spec slice's `done: {item, result}[]` — `item` is the
 * caller's input value (not the internal `QueueItem` envelope), so a consumer
 * reading `done` gets back exactly what it scattered.
 */
export interface FanOutDone<I, R> {
  /** The original scattered input value. */
  readonly item: I;
  /** The result the item's effect produced, routed in via `itemOk`. */
  readonly result: R;
}

/**
 * One settled-error item: the original `input` and the `error` its effect
 * surfaced. `error` is `unknown` — fan-out carries it forward verbatim (an
 * `Error`, a tagged result, a string) for the consumer's reducer to read,
 * never interpreting it (same discipline as `retry-backoff`'s `lastError`).
 */
export interface FanOutFailed<I> {
  /** The original scattered input value. */
  readonly item: I;
  /** The error the item's effect surfaced, routed in via `itemErr`. Carried, never interpreted. */
  readonly error: unknown;
}

/**
 * The slice this knob owns — four partitions over the work-queue item
 * lifecycle, plus the work-queue records the verbs thread the lifecycle
 * through.
 *
 * Why both the spec's four arrays AND `items`:
 *   - The four arrays (`pending` / `running` / `done` / `failed`) are the
 *     SPEC's public read surface — what a consumer's view renders and what
 *     `isComplete` reads. They hold caller-facing values (`I`, or
 *     `FanOutDone` / `FanOutFailed`), not the internal id-bearing envelope.
 *   - `items` is the work-queue ledger: one `QueueItem<I>` per scattered item,
 *     carrying the stable `id` (from `config.idOf`) that `itemOk` / `itemErr`
 *     address and the `status` that decides launch-eligibility. It is the
 *     single source of truth; the four arrays are a derived projection kept in
 *     lockstep so consumers never re-scan `items` to render a partition.
 *
 * Every field is `readonly` and the whole slice is JSON-serializable (plain
 * arrays + the work-queue's plain `QueueItem` records), so it round-trips
 * through a consumer's `Store<S>` unchanged — durable across DO eviction.
 */
export interface FanOutState<I, R> {
  /** Items accepted but not yet launched (queue back-pressure beyond `concurrency`). */
  readonly pending: readonly I[];
  /** Items whose `of(item)` effect is in flight (size never exceeds `concurrency`). */
  readonly running: readonly I[];
  /** Items whose effect resolved OK, with the result it produced. */
  readonly done: readonly FanOutDone<I, R>[];
  /** Items whose effect failed, with the error it surfaced. */
  readonly failed: readonly FanOutFailed<I>[];
  /**
   * The work-queue ledger: one record per scattered item, keyed by the
   * caller's `idOf`. The single source of truth the four arrays project from.
   */
  readonly items: readonly QueueItem<I>[];
  /**
   * Index into `done` where the CURRENT wave's OK results begin. `done` is
   * append-only and accumulates across every wave (so a consumer reading
   * `done` sees the full history), but `join` must fold only the wave that
   * just drained — not the cumulative total. A wave opens when `scatter`
   * enqueues into a slice with nothing in flight; this marks `done.length` at
   * that moment so `join` receives exactly `done.slice(waveDoneFrom)`.
   */
  readonly waveDoneFrom: number;
  /**
   * Index into `failed` where the current wave's failures begin. Symmetric to
   * `waveDoneFrom` — the wave boundary over the failure partition. Carried for
   * a consumer that wants to read only the current wave's failures; `join`
   * itself folds only OK results.
   */
  readonly waveFailedFrom: number;
  /**
   * Whether the current wave has already fired its `join`. `join` fires at most
   * once per wave — set `true` at the completion edge so a stale settle that
   * re-reaches `isComplete` cannot re-fire it. A new `scatter` that opens a wave
   * resets it to `false`.
   */
  readonly joined: boolean;
}

/**
 * The knob. `concurrency` caps how many `of(item)` effects are in flight at
 * once; `idOf` mints a stable, PURE identity per item (so `scatter` is
 * deterministic and `itemOk` / `itemErr` can address an item by id); `of`
 * turns an item into the launch Cmd; `join` (optional) turns the gathered
 * results into a single completion Cmd fired exactly once when every item has
 * settled.
 *
 * Field optionality follows the resilient-call rule — omit `join`, omit the
 * completion Cmd (a consumer that observes `isComplete` itself, or wires the
 * `handlers` Port, doesn't need one).
 */
export interface FanOutConfig<I, R, C extends Cmd, J extends Cmd> {
  /** Max in-flight `of(item)` effects. Clamped to `>= 1` (a 0/negative cap would deadlock). */
  readonly concurrency: number;
  /**
   * Stable, deterministic identity for an item. PURE — no clock, no RNG. The
   * id is what `itemOk` / `itemErr` address, so it must survive a round-trip
   * through the durable slice and match across the launch → settle gap. For
   * value-unique inputs (URLs, ids) this is often the identity function; for
   * structural inputs, a content hash or a caller-assigned key.
   */
  readonly idOf: (item: I) => string;
  /** The per-item effect, as data. Performed by the consumer's own `interpret`. */
  readonly of: (item: I) => C;
  /**
   * Optional: fold the gathered done-results into a single completion Cmd,
   * fired exactly once at the transition that empties `pending` + `running`.
   * Omit to drive completion off `isComplete` (or the `handlers` Port) instead.
   */
  readonly join?: (results: readonly R[]) => J;
}

/**
 * Clamp the configured concurrency to a usable launch budget. A cap of 0 or
 * negative would launch nothing and the batch would deadlock with items stuck
 * `pending` forever; clamping to 1 degrades gracefully to fully-serial
 * fan-out (still correct, just no parallelism) rather than hanging.
 */
function launchBudget(concurrency: number): number {
  return concurrency < 1 ? 1 : Math.floor(concurrency);
}

/** The starting slice: nothing scattered yet. */
export function initFanOut<I, R>(): FanOutState<I, R> {
  return {
    pending: [],
    running: [],
    done: [],
    failed: [],
    items: [],
    waveDoneFrom: 0,
    waveFailedFrom: 0,
    joined: false,
  };
}

/**
 * Whether every scattered item has settled (no `pending`, no `running`).
 * Derived — reads the slice, never mutates. The verbs use it to decide when to
 * fire `join`; consumers can read it directly to branch their own phase.
 *
 * An empty fan-out (nothing ever scattered) is NOT complete: completion is "a
 * non-empty batch fully drained," so `isComplete(initFanOut())` is `false` and
 * a `scatter([])` of zero items also reads `false` (there was no batch to
 * complete). This keeps `join` from firing on a degenerate empty scatter.
 */
export function isComplete<I, R>(state: FanOutState<I, R>): boolean {
  if (state.items.length === 0) return false;
  return state.pending.length === 0 && state.running.length === 0;
}

/**
 * Count of items currently in flight. `running.length`, named for the launch
 * arithmetic below (and readable at a call site).
 */
function inFlight<I, R>(state: FanOutState<I, R>): number {
  return state.running.length;
}

/**
 * Move up to `budget - inFlight` items from `pending` to `running`, emitting
 * `of(item)` for each launched item. PURE — returns the new slice and the
 * launch Cmds. The work-queue `items` ledger flips each launched item's status
 * `pending → running` via the `QueueAdapter`'s `claim`, in lockstep with the
 * projected arrays.
 *
 * Delegation, not re-rolling: each launch is one `queue.claim` call — the same
 * `pending → running` transition `@demlik/tea/work-queue` owns. `queue.claim`
 * flips the FIRST pending ledger record positionally, and fan-out's `pending`
 * array is appended in lockstep with the ledger, so the first `slots` pending
 * inputs map to the first `slots` pending records — claiming one-per-launch
 * settles exactly those. This also makes a DUPLICATE id correct: a positional
 * claim flips ONE record per launch, where a blanket id-set flip would promote
 * every pending record sharing the launched id (over-flipping the ledger past
 * `running.length`). The `at` stamp is `0` — fan-out's verbs are pure and never
 * read a clock; positional order, not the timestamp, drives every decision
 * (same convention as `scatter`'s `enqueuedAt: 0`).
 *
 * Shared by `scatter` (launch on enqueue) and `itemOk` / `itemErr` (launch the
 * next pending item as a slot frees). Factoring it here keeps the concurrency
 * invariant — `running.length <= budget` — in ONE place.
 */
function launchUpTo<I, R, C extends Cmd>(
  state: FanOutState<I, R>,
  config: {
    concurrency: number;
    idOf: (item: I) => string;
    of: (item: I) => C;
  },
): readonly [FanOutState<I, R>, readonly C[]] {
  const budget = launchBudget(config.concurrency);
  const slots = budget - inFlight(state);
  if (slots <= 0 || state.pending.length === 0) return [state, []];

  const toLaunch = state.pending.slice(0, slots);
  const stillPending = state.pending.slice(slots);

  // Flip the ledger records `pending → running` one launch at a time via the
  // `QueueAdapter` (positional first-pending claim per call).
  const queue = queueAdapter<I>();
  let items: readonly QueueItem<I>[] = state.items;
  for (let i = 0; i < toLaunch.length; i++) {
    const claimed = queue.claim(items, 0);
    if (claimed === null) break;
    items = claimed.next;
  }

  const next: FanOutState<I, R> = {
    ...state,
    pending: stillPending,
    running: [...state.running, ...toLaunch],
    items,
  };
  const cmds = toLaunch.map((item) => config.of(item));
  return [next, cmds];
}

/**
 * Settle EXACTLY ONE running entry for `id`: remove the first `running` item
 * whose `idOf` matches, and flip the first ledger record for `id` that is still
 * `running` to `status`. Returns the input that was settled plus the new
 * `running` / `items` arrays, or `undefined` if no running item carries that id
 * (a stale / unknown settle Msg → caller treats as a no-op rather than a crash).
 *
 * Why "exactly one": when two scattered items share an `idOf` (a duplicate id),
 * the ledger holds two `running` records under the same id and `running` holds
 * two inputs. A settle Msg carries one result, so it must close out exactly one
 * of them — not all matches. A blanket `filter((x) => idOf(x) !== id)` would
 * drop BOTH running entries while recording only ONE result, silently losing a
 * unit of work and corrupting the done/failed partition. find-index + splice
 * removes a single `running` entry; the matching `findIndex` over the ledger
 * flips a single record. The OTHER duplicate stays `running`, awaiting its own
 * settle Msg.
 *
 * This flip is NOT delegated to the `QueueAdapter`'s `patch`: the verb matches
 * the FIRST record by id, but the record fan-out must flip is "first id-match
 * that is still `running`" — and after a dup-id's first settle the first id-match
 * is the already-terminal record. The status predicate is load-bearing here and
 * the adapter verbs can't express it, so fan-out owns this one index. The flipped
 * record is still built the work-queue way (spread + new `status`), and there
 * is no `as` cast: `status` arrives already typed `QueueItemStatus`.
 */
function settleOne<I, R>(
  state: FanOutState<I, R>,
  id: string,
  status: QueueItemStatus,
  idOf: (item: I) => string,
):
  | { input: I; running: readonly I[]; items: readonly QueueItem<I>[] }
  | undefined {
  const runIdx = state.running.findIndex((item) => idOf(item) === id);
  // `at` collapses "no running entry for this id" into an `undefined` early-out,
  // narrowing `input` to `I` below without a non-null assertion (the pattern
  // `ops.ts` uses); `runIdx` stays around for the splice.
  const input = at(state.running, runIdx);
  if (input === undefined) return undefined;

  const running = [
    ...state.running.slice(0, runIdx),
    ...state.running.slice(runIdx + 1),
  ];

  const ledgerIdx = state.items.findIndex(
    (item) => item.id === id && item.status === "running",
  );
  // Same early-out via `at`: `ledger === undefined` narrows the record to
  // `QueueItem<I>` for the spread below without a non-null assertion.
  const ledger = at(state.items, ledgerIdx);
  const items =
    ledger === undefined
      ? state.items
      : [
          ...state.items.slice(0, ledgerIdx),
          { ...ledger, status },
          ...state.items.slice(ledgerIdx + 1),
        ];

  return { input, running, items };
}

/**
 * Optional Port for observing batch completion out-of-band. When a consumer
 * passes `handlers(ports)` a `complete` Port, the runtime side can emit the
 * gathered results onto it the moment `isComplete` flips true — distinct from
 * the in-band `join` Cmd (which threads back through `update`). Use the Port
 * for "tell the outside world the batch finished" without folding a completion
 * signal into the consumer's Msg union.
 */
export interface FanOutPorts<R> {
  /** Fires once with every gathered done-result when the batch completes. */
  readonly complete: Port<readonly R[]>;
}

/**
 * Build the fan-out knob from `config`. Returns the uniform combinator
 * contract: `init` for the owned slice, the three settle verbs + the derived
 * `isComplete`, and `handlers` for the optional out-of-band completion Port.
 *
 * No `subs` — fan-out runs no timers (the spec pins "Subs: none"). The
 * per-item effect's lifetime is owned by the consumer's `interpret`, and
 * completion is a pure function of the settle Msgs, so there is nothing
 * continuous to subscribe to.
 */
export function createFanOut<I, R, C extends Cmd = Cmd, J extends Cmd = Cmd>(
  config: FanOutConfig<I, R, C, J>,
) {
  /**
   * Enqueue `items` and launch up to `concurrency` of them. PURE.
   *
   * Each item gets a ledger record (`status: "pending"`, its `idOf` id) and is
   * appended to `pending`; `launchUpTo` then promotes as many as the free
   * concurrency budget allows, emitting `of(item)` per launch. The returned
   * Cmds are exactly the launch effects — `scatter` never fires `join` (a batch
   * can't complete on the same transition it starts unless it launches zero
   * effects, which `isComplete`'s empty-batch rule already declines to treat as
   * completion).
   *
   * Each pending ledger record is minted by the `QueueAdapter`'s `enqueue` — the
   * same `pending` append `@demlik/tea/work-queue` owns — rather than re-rolled
   * inline, so the `status: "pending"` literal lives in exactly one place (no
   * `as QueueItemStatus` cast here).
   *
   * `enqueuedAt` is stamped `0` rather than read from a clock: fan-out's verbs
   * are pure, and fan-out does not use the timestamp for any decision (ordering
   * is positional via the arrays). A consumer that needs real enqueue times
   * threads them through its own Msg `at` and stores them alongside.
   */
  function scatter(
    state: FanOutState<I, R>,
    items: readonly I[],
  ): readonly [FanOutState<I, R>, readonly C[]] {
    // Append one pending ledger record per item via the `QueueAdapter`.
    // `queue.enqueue` returns `status: "pending"` already typed — no cast — and
    // the lifecycle's "new work is pending" rule stays in work-queue's hands.
    const queue = queueAdapter<I>();
    let ledger: readonly QueueItem<I>[] = state.items;
    for (const input of items) {
      ledger = queue.enqueue(ledger, input, 0, config.idOf(input)).next;
    }
    // A scatter OPENS A FRESH WAVE when nothing is in flight — either the very
    // first scatter, or a re-scatter after the previous wave fully drained. The
    // wave boundary advances to the current `done` / `failed` length so `join`
    // folds only THIS wave's results, never the cumulative history, and
    // `joined` resets so the new wave can fire its own `join` exactly once.
    //
    // A scatter that adds to a wave still in flight (pending or running
    // non-empty — e.g. enqueuing more work mid-batch) does NOT open a wave:
    // those items join the current wave and settle under its single `join`.
    const opensWave = state.pending.length === 0 && state.running.length === 0;

    const enqueued: FanOutState<I, R> = {
      ...state,
      pending: [...state.pending, ...items],
      items: ledger,
      ...(opensWave
        ? {
            waveDoneFrom: state.done.length,
            waveFailedFrom: state.failed.length,
            joined: false,
          }
        : {}),
    };
    return launchUpTo(enqueued, config);
  }

  /**
   * Record `id`'s effect as succeeded with `result`, then launch the next
   * pending item to backfill the freed slot. PURE.
   *
   * Moves the item out of `running` into `done` (carrying the original input +
   * its result), flips its ledger record `running → done`, and runs
   * `launchUpTo` to keep the pipeline full. If this transition empties both
   * `pending` and `running` AND a `join` is configured, the returned Cmds also
   * include the single `join(results)` Cmd — fired exactly once at the
   * completion edge.
   *
   * A settle for an unknown / already-settled `id` is a no-op (returns the
   * slice unchanged, no Cmds): the runtime's serial dispatch makes a true
   * double-settle impossible, but a stale Msg after a boot/replay is real, and
   * swallowing it is the safe direction (the result is already recorded).
   */
  function itemOk(
    state: FanOutState<I, R>,
    id: string,
    result: R,
  ): readonly [FanOutState<I, R>, readonly (C | J)[]] {
    const settled = settleOne(state, id, "done", config.idOf);
    if (settled === undefined) return [state, []];

    const next: FanOutState<I, R> = {
      ...state,
      running: settled.running,
      done: [...state.done, { item: settled.input, result }],
      items: settled.items,
    };
    return finishOrLaunch(next);
  }

  /**
   * Record `id`'s effect as failed with `error`, then launch the next pending
   * item to backfill the freed slot. PURE.
   *
   * Symmetric to `itemOk`: moves the item out of `running` into `failed`
   * (carrying the original input + the error), flips its ledger record
   * `running → failed`, backfills via `launchUpTo`, and fires `join` at the
   * completion edge if configured. A failed item still counts toward completion
   * — the batch is "done" when every item has settled, success or failure;
   * `join` receives only the OK results (failures are read off `failed`).
   *
   * Same unknown-`id` no-op contract as `itemOk`.
   */
  function itemErr(
    state: FanOutState<I, R>,
    id: string,
    error: unknown,
  ): readonly [FanOutState<I, R>, readonly (C | J)[]] {
    const settled = settleOne(state, id, "failed", config.idOf);
    if (settled === undefined) return [state, []];

    const next: FanOutState<I, R> = {
      ...state,
      running: settled.running,
      failed: [...state.failed, { item: settled.input, error }],
      items: settled.items,
    };
    return finishOrLaunch(next);
  }

  /**
   * Shared tail of `itemOk` / `itemErr`: backfill the freed slot, then — if the
   * CURRENT wave is now complete, a `join` is configured, and this wave has not
   * already joined — append the single completion Cmd and mark the wave joined.
   *
   * Two guards keep `join` firing exactly once per wave:
   *   - `isComplete(next)` is the completion edge (the transition that drains
   *     the last in-flight item; `launchUpTo` cannot re-fill from an empty
   *     `pending`, so `running` stays empty and the edge is reached once).
   *   - `!next.joined` makes it idempotent even if a stale settle re-reaches a
   *     completed slice, and — critically — combined with the per-wave reset in
   *     `scatter` it stops `join` re-firing across waves. Without the wave
   *     boundary, `done` is append-only, so a SECOND wave draining would see
   *     `isComplete` true and re-fold the WHOLE cumulative `done` (wave 1 +
   *     wave 2). The fix folds only `done.slice(waveDoneFrom)` — exactly the
   *     results this wave produced.
   */
  function finishOrLaunch(
    settled: FanOutState<I, R>,
  ): readonly [FanOutState<I, R>, readonly (C | J)[]] {
    const [launched, launchCmds] = launchUpTo(settled, config);
    if (config.join !== undefined && !launched.joined && isComplete(launched)) {
      const results = launched.done
        .slice(launched.waveDoneFrom)
        .map((d) => d.result);
      const next: FanOutState<I, R> = { ...launched, joined: true };
      return [next, [...launchCmds, config.join(results)]];
    }
    return [launched, launchCmds];
  }

  /**
   * The out-of-band completion splice. Returns an observer-shaped function the
   * consumer calls after every settle: when the batch has just completed it
   * emits the gathered results onto `ports.complete`. This is the Port-side
   * analogue of the `join` Cmd — use it when completion should leave the
   * runtime as a typed signal rather than re-enter `update`.
   *
   * Returns the emit-on-complete callback so the consumer wires it into its own
   * runtime `observe` (e.g. `runtime.observe((_, s) => emit(s.fanOut))`); fan-out
   * stays out of the dispatch loop, matching `historyTracker`'s discipline.
   */
  function handlers(ports: FanOutPorts<R>) {
    return {
      /**
       * Emit the gathered done-results onto `ports.complete` iff `state` is a
       * just-completed batch. Idempotency is the caller's concern (call it once
       * per transition via `observe`); emitting to a Port with no subscribers
       * is a no-op at the runtime, so an extra call is harmless.
       */
      emitOnComplete(
        emit: <T>(port: Port<T>, value: T) => void,
        state: FanOutState<I, R>,
      ): void {
        if (!isComplete(state)) return;
        emit(
          ports.complete,
          state.done.slice(state.waveDoneFrom).map((d) => d.result),
        );
      },
    };
  }

  return {
    init: initFanOut<I, R>,
    scatter,
    itemOk,
    itemErr,
    isComplete,
    handlers,
  };
}
