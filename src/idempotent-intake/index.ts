/**
 * @demlik/tea/idempotent-intake — receive-once intake for webhooks / queue
 * messages: dedupe by key, enqueue the new ones, replay the cached result to
 * the duplicates. The "process this payload exactly once even though it
 * arrives N times" knob.
 *
 * **The recipe.** This is a Level-2 composition — it owns no primitive
 * queue/cache logic of its own, it *splices two L1 bricks into one Model slice*
 * and DELEGATES every transition to their pure ops:
 *
 *   - `../idempotency` — the dedupe-by-key + last-result cache. The `seen`
 *     half of the slice is its `IdempotencyStore`, keyed by `keyOf(payload)`.
 *     A key is `seen` once `receive` calls `remember` to record it; `complete`
 *     calls `remember` again to swap its cached value from `pending` to the
 *     finished `result`. The cache write is the brick's, never re-rolled here.
 *   - `../work-queue/ops` — the pending-work list. The `queue` half of the
 *     slice is its `QueueItem<P>[]`. Every status flip routes through the
 *     blessed ops: `receive` enqueues via `enqueueOp`, `claimNext` stamps the
 *     `running` claim via `patchItemOp`, `boot` re-arms a dead worker's claim
 *     via `patchItemOp`. Intake owns only the SELECTION (which item, gated on
 *     the done-cache reconcile below) — the array transition is the brick's.
 *     The consumer drains it (claim → process → `complete`) at its own pace.
 *
 * Both bricks are pure-state + pure-ops, host- and clock-agnostic by
 * construction, so the combined slice inherits TEA's two non-negotiables:
 *
 *   - **Durable** — the slice is a plain serializable value (a record-backed
 *     idempotency store + an array of queue items, no `Map`, no closures), so
 *     it survives a Durable-Object eviction / reload and rehydrates whole.
 *   - **Replayable** — every verb is a pure `(state, …) => [state, Cmd[]]`
 *     transition; no `Date.now()`, no `Math.random()`, no I/O inside a verb.
 *     `at` (the clock) and `id` (the queue-item id) are *injected* at the call
 *     site, so `trace-replay` reconstructs each transition exactly.
 *
 * **The decision lives in a Cmd, not in a return shape.** `receive` cannot
 * "return" what it decided (the knob contract pins the shape to
 * `[State, Cmd[]]`), so the decision is *reified as a Cmd* the runtime
 * performs:
 *
 *   - first sighting of a key  → mark it `pending`, enqueue the payload, emit
 *     `IntakeProcess` (go run the work).
 *   - a key already `pending`  → drop silently (the original is in flight);
 *     emit nothing.
 *   - a key already `done`     → emit `IntakeReplay` carrying the cached
 *     result so the duplicate caller gets the SAME response the first one
 *     produced, with zero re-execution of the side effect.
 *
 * **Two crash-safety guarantees the verbs enforce (and the unit specs alone
 * missed — see the wired-machine test):**
 *
 *   - *A slow worker is never double-enqueued.* The TTL clock starts at
 *     `complete`, not at `receive`: a `pending` entry NEVER ages out, so a
 *     duplicate of an in-flight key is always dropped no matter how long the
 *     worker takes. Only a `done` entry expires (see `liveEntry`).
 *   - *A complete-then-crash never re-runs.* `boot` and `claimNext` reconcile
 *     the queue against the done cache: a queue item whose key already resolved
 *     to `done` in `seen` is skipped (never reset to pending, never claimed),
 *     so a worker that finished and cached its result before the DO evicted is
 *     not re-executed on resume.
 *
 * Typical wiring (the combinator form — splice ~3 hooks into a host machine):
 *
 *   const intake = createIntake<StripeEvent, ChargeResult>({
 *     keyOf: (e) => e.id,          // Stripe's idempotency key
 *     ttlMs: 24 * 60 * 60 * 1000,  // a replayed webhook 24h after it COMPLETED is re-run
 *   });
 *
 *   // in `init`:
 *   intake: intake.init(),
 *   // in `update`, on the inbound-webhook Msg:
 *   const [next, cmds] = intake.receive(state.intake, payload, at, id);
 *   // …route `IntakeProcess` to your worker, `IntakeReplay` to the responder.
 *   // on the worker's done Msg:
 *   const [next, _] = intake.complete(state.intake, key, result, at);
 *   // once, after boot (DO reload), before resuming the drain:
 *   const [next, _] = intake.boot(state.intake);
 *
 * Escape hatch: reach the raw L1 ops via `@demlik/tea/idempotency` and
 * `@demlik/tea/work-queue` and thread them by hand.
 */

import { type IdempotencyStore, initStore, remember } from "../idempotency";
import type { Cmd } from "../index";
import type { QueueItem } from "../work-queue";
import { enqueueOp, patchItemOp } from "../work-queue/ops";

/**
 * A cached intake entry: either a key whose work is still in flight
 * (`pending`) or one whose work has finished and whose `result` is held for
 * replay to later duplicates (`done`). Discriminated on `phase` — `pending`
 * carries no payload, `done` carries the result `R`.
 *
 * Lives inside the `seen` half of the slice (`IdempotencyStore<IntakeEntry<R>>`).
 * It is the dedupe ledger's *value*; the ledger's *key* is `keyOf(payload)`.
 */
export type IntakeEntry<R> =
  | { readonly phase: "pending" }
  | { readonly phase: "done"; readonly result: R };

/**
 * The intake knob's config — `keyOf` derives the idempotency key from a
 * payload, `ttlMs` (optional) ages a *completed* cached key out so a webhook
 * replayed long after the work finished is treated as new and re-processed.
 *
 * **The TTL clock starts at `complete`, not at `receive`.** A `pending` entry
 * (work still in flight) NEVER ages out, no matter how slow the worker is —
 * ageing a pending key would let the duplicate re-enqueue the in-flight
 * payload and double-process it. Only a `done` entry expires, measured from
 * the `at` passed to `complete` (the moment the result was cached). Inside the
 * window a duplicate replays the cached result; at/after the window it is
 * re-accepted and re-processed.
 *
 * Omit `ttlMs` for a cache whose `done` entries never expire by age (keys live
 * forever — fine for a bounded universe of ids, unbounded growth otherwise).
 *
 * The TTL is owned HERE, not delegated to the composed `IdempotencyStore`: the
 * store's uniform per-entry TTL cannot tell `pending` from `done`, so intake
 * keeps the store TTL-free and applies the phase-aware rule itself (see
 * `liveEntry`).
 */
export interface IntakeConfig<P> {
  /** Derive the idempotency key from a payload. Must be pure + deterministic. */
  readonly keyOf: (payload: P) => string;
  /**
   * Age a *completed* key out after this many ms, measured from the `at`
   * passed to `complete`. Pending keys never age out.
   */
  readonly ttlMs?: number;
}

/**
 * The Model slice this knob owns. `seen` is the dedupe + last-result cache
 * (the `../idempotency` brick); `queue` is the pending-work list (the
 * `../work-queue` brick). Both are plain serializable values — the whole slice
 * round-trips through `JSON` so it survives eviction and replays exactly.
 */
export interface IntakeState<P, R> {
  readonly seen: IdempotencyStore<IntakeEntry<R>>;
  readonly queue: readonly QueueItem<P>[];
}

// === Cmds the verbs reify ===
//
// The knob contract pins verbs to `(state, …) => [State, Cmd[]]`, so a verb's
// *decision* (new vs. duplicate-pending vs. duplicate-done) cannot be a return
// value — it is emitted as a Cmd the runtime's interpret handler performs.
// Each Cmd is plain data (invariant 1): the payload / key / result it carries
// are values, never closures.

/** A genuinely-new payload was accepted and enqueued — go run the work. */
export interface IntakeProcessCmd<P> extends Cmd<"intake:process"> {
  /** The dedupe key the payload was filed under. */
  readonly key: string;
  /** The enqueued queue-item id (the same `id` passed to `receive`). */
  readonly itemId: string;
  /** The original payload, for the worker to process. */
  readonly payload: P;
}

/**
 * A duplicate of an already-completed key arrived — replay the cached result
 * to the caller instead of re-running the side effect.
 */
export interface IntakeReplayCmd<R> extends Cmd<"intake:replay"> {
  /** The dedupe key whose cached result is being replayed. */
  readonly key: string;
  /** The result the ORIGINAL request produced, recalled from the cache. */
  readonly result: R;
}

/** The Cmd union the intake verbs emit. */
export type IntakeCmd<P, R> = IntakeProcessCmd<P> | IntakeReplayCmd<R>;

/**
 * Build an idempotent-intake knob from `config`. Returns the uniform L2
 * contract — `init()` + the verbs (`receive`, `complete`, `boot`, `claimNext`).
 * No `subs` / `handlers`: intake owns no timers and does no I/O of its own (the
 * composed bricks are pure-ops; the worker that runs `IntakeProcess` and the
 * responder that runs `IntakeReplay` live in the host's interpret map).
 */
export function createIntake<P, R>(config: IntakeConfig<P>) {
  const { keyOf, ttlMs } = config;

  /**
   * The empty slice: a TTL-free idempotency store (intake owns the TTL itself —
   * see `liveEntry`, because the store cannot tell `pending` from `done`) plus
   * an empty work queue. The rehydrate path is the host's `init(loaded)` — it
   * passes the persisted slice straight back, this is only the fresh-boot value.
   */
  function init(): IntakeState<P, R> {
    return {
      seen: initStore<IntakeEntry<R>>(),
      queue: [],
    };
  }

  /**
   * The live cached entry for `key` at clock reading `at`, or `undefined` if
   * the key is absent or its `done` window has elapsed. This is intake's
   * phase-aware expiry rule, applied HERE rather than by the store's uniform
   * per-entry TTL:
   *
   *   - **`pending`** — work is in flight; NEVER expires. Ageing a pending key
   *     would let a slow worker's payload be re-enqueued and double-processed.
   *   - **`done`** — expires `ttlMs` after the `atMs` the result was cached at
   *     (the `at` passed to `complete`). Half-open, matching the store /
   *     rate-limit window edge: `at - atMs >= ttlMs` reads as expired. No
   *     `ttlMs` ⇒ a `done` entry never expires by age.
   *
   * PURE — reads `state.seen.entries` directly (no `Date.now`), never mutates.
   */
  function liveEntry(
    store: IdempotencyStore<IntakeEntry<R>>,
    key: string,
    at: number,
  ): IntakeEntry<R> | undefined {
    const cached = store.entries[key];
    if (cached === undefined) return undefined;
    const entry = cached.value;
    if (entry.phase === "pending") return entry; // in flight — never ages out
    if (ttlMs !== undefined && at - cached.atMs >= ttlMs) return undefined;
    return entry;
  }

  /**
   * Whether the queue item `it`'s key has already resolved to a live `done`
   * entry in `seen` (the work completed and its result is cached). Such an
   * item must NOT be re-armed by `boot` or claimed by `claimNext` — doing so
   * re-runs work whose result is already known (the complete-then-crash bug).
   *
   * `at = +Infinity` is the right reading for the reconcile check: a `done`
   * entry counts as done for reconciliation regardless of how far past its
   * replay TTL it is. (TTL governs whether a *duplicate receive* re-processes,
   * not whether a *queued, already-completed* item should re-run — that one
   * never should.)
   */
  function isAlreadyDone(state: IntakeState<P, R>, it: QueueItem<P>): boolean {
    return state.seen.entries[keyOf(it.input)]?.value.phase === "done";
  }

  /**
   * Receive a payload at clock reading `at`, filing it under the queue-item
   * id `id`. PURE — returns a NEW slice; the input is untouched.
   *
   * Three outcomes, each reified as a Cmd (see the Cmd union above):
   *
   *   1. **New key** (`liveEntry` is absent at `at`) — `remember` the key as
   *      `pending`, `enqueue` the payload onto the work queue, and emit
   *      `intake:process`. The only path that grows either half of the slice.
   *   2. **Duplicate, still pending** — the original is in flight. Drop
   *      silently: the slice is returned unchanged and no Cmd is emitted, so
   *      the duplicate neither re-enqueues nor double-processes. A pending
   *      entry never ages out, so this holds no matter how slow the worker is.
   *   3. **Duplicate, already done (within TTL)** — emit `intake:replay`
   *      carrying the cached `result` so the caller gets the original response.
   *      The slice is unchanged (a replay touches neither cache nor queue). A
   *      `done` key past its `ttlMs` window reads as absent and falls to (1).
   *
   * `id` is injected (work-queue's `genId` reads `Date.now()` / `crypto`, so
   * it cannot be called inside a pure verb). Generate it at the effect
   * boundary and thread it in; it becomes the enqueued item's id AND the
   * `itemId` on the emitted `intake:process` Cmd, so the worker can address the
   * exact queue item it must `complete`.
   */
  function receive(
    state: IntakeState<P, R>,
    payload: P,
    at: number,
    id: string,
  ): readonly [IntakeState<P, R>, readonly IntakeCmd<P, R>[]] {
    const key = keyOf(payload);

    // Duplicate path — the key has a live entry at `at` (pending never ages;
    // done ages only past `ttlMs` measured from `complete`).
    const entry = liveEntry(state.seen, key, at);
    if (entry !== undefined) {
      if (entry.phase === "done") {
        // Replay the original result; touch nothing.
        return [state, [{ type: "intake:replay", key, result: entry.result }]];
      }
      // phase === "pending": original is in flight — drop silently.
      return [state, []];
    }

    // New path — record the key as pending, enqueue the payload, process it.
    const seenNext = remember(state.seen, key, { phase: "pending" }, at);
    const { next: queueNext, item } = enqueueOp<P>(
      state.queue,
      payload,
      at,
      id,
    );
    const nextState: IntakeState<P, R> = { seen: seenNext, queue: queueNext };
    return [
      nextState,
      [{ type: "intake:process", key, itemId: item.id, payload }],
    ];
  }

  /**
   * Record the finished `result` for `key` at clock reading `at`. PURE —
   * returns a NEW slice; the input is untouched. Emits no Cmds (completion is
   * a pure cache write; the host marks the queue item done via the work-queue
   * adapter at the effect boundary).
   *
   * Swaps the key's cached entry from `pending` to `done` so every subsequent
   * `receive` of the same key replays this `result`. `remember` stamps the
   * entry's `atMs` to `at`, which is the moment intake's `done`-TTL clock
   * starts (see `liveEntry`): a completed key stays replayable for `ttlMs`
   * past completion, not past first receipt.
   *
   * `complete` does NOT remove the queue item — the queue is the host's drain
   * ledger, and which items leave it (and when) is the host's call via the
   * work-queue adapter. `complete` owns the cache half only.
   */
  function complete(
    state: IntakeState<P, R>,
    key: string,
    result: R,
    at: number,
  ): readonly [IntakeState<P, R>, readonly IntakeCmd<P, R>[]] {
    const seenNext = remember(state.seen, key, { phase: "done", result }, at);
    return [{ ...state, seen: seenNext }, []];
  }

  /**
   * Resume after a boot (Durable-Object reload / process restart). PURE —
   * returns a NEW slice; the input is untouched. Emits no Cmds.
   *
   * Resets every `running` queue item back to `pending` so the host's drain
   * re-claims it — EXCEPT an item whose key already resolved to `done` in
   * `seen`. That item's worker finished and cached its result before the crash;
   * re-arming it would re-run completed work (the complete-then-crash bug). It
   * is left as-is (and `claimNext` will likewise skip it), so the host drains
   * it via `markDone` without ever re-executing the side effect.
   *
   * A `running` item still `pending` in the cache is one a now-dead worker
   * claimed but never finished — that one IS reset, so it gets re-claimed.
   *
   * Returns the same reference when nothing changed (no running item needed
   * re-arming) so the host can skip a redundant save.
   *
   * Call once from a `boot` Msg the host dispatches after `run(...)` returns —
   * never from `init`'s rehydrate branch (that branch must be a pure
   * passthrough; see the substrate's `init` contract).
   */
  function boot(
    state: IntakeState<P, R>,
  ): readonly [IntakeState<P, R>, readonly IntakeCmd<P, R>[]] {
    // Selection lives HERE (the done-cache reconcile is intake's own rule); the
    // status FLIP is delegated to `../work-queue/ops`. A blanket `resetRunningOp`
    // would re-arm completed-then-crashed items (it cannot see the done cache),
    // so intake picks the items and `patchItemOp` performs each transition —
    // the same spread the work-queue lifecycle uses, not a re-rolled one.
    let queue = state.queue;
    let changed = false;
    for (const it of state.queue) {
      if (it.status !== "running") continue;
      // Reconcile against the done cache: a completed-then-crashed item must
      // NOT be re-armed (it would re-run already-cached work).
      if (isAlreadyDone(state, it)) continue;
      const flip = patchItemOp<P>(queue, it.id, (item) => ({
        ...item,
        status: "pending",
        startedAt: undefined,
      }));
      queue = flip.next;
      changed = changed || flip.changed;
    }
    if (!changed) return [state, []];
    return [{ ...state, queue }, []];
  }

  /**
   * Claim the next pending queue item, flipping it `running` and stamping
   * `startedAt` to `at`. PURE — returns a NEW slice plus the claimed item, or
   * `null` if nothing claimable remains.
   *
   * "Claimable" is a pending item WHOSE KEY IS NOT ALREADY `done` in `seen`.
   * An item whose key completed before a crash (its `intake:process` ran, work
   * finished, result cached, but the item never left the queue) is skipped —
   * claiming it would re-run already-cached work. Such items are inert here;
   * the host drains them via `markDone`.
   *
   * This is the drain side of the intake, the mirror of `receive`'s enqueue.
   * It is a pure helper (not a verb that emits Cmds) because "what to do with
   * the claimed item" is the host's decision — typically: dispatch the worker,
   * await it, then call `complete`. Threading it through the slice keeps the
   * claim durable: the `running` stamp survives eviction, and `boot` re-arms
   * it if the worker died.
   */
  function claimNext(
    state: IntakeState<P, R>,
    at: number,
  ): {
    readonly state: IntakeState<P, R>;
    readonly claimed: QueueItem<P>;
  } | null {
    // Selection lives HERE (skip an item whose key already resolved `done`);
    // the status FLIP is delegated to `../work-queue/ops`. `claimNextOp` claims
    // the first PENDING item blind to the done cache, which would re-run
    // already-cached work — so intake selects the eligible item and `patchItemOp`
    // performs the running-stamp transition (the work-queue lifecycle's own
    // spread, not a re-rolled one).
    const target = state.queue.find(
      (it) => it.status === "pending" && !isAlreadyDone(state, it),
    );
    if (target === undefined) return null;
    // The patch closure is the single place the claimed item is materialized;
    // capture it here so the result needs no re-scan of the new queue.
    let claimed: QueueItem<P> = target;
    const { next } = patchItemOp<P>(state.queue, target.id, (item) => {
      claimed = { ...item, status: "running", startedAt: at };
      return claimed;
    });
    return { state: { ...state, queue: next }, claimed };
  }

  return { init, receive, complete, boot, claimNext };
}
