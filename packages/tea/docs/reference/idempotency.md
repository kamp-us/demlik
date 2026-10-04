# @demlik/tea/idempotency

> do-it-once: dedupe by key, cache the result, and replay that result to every duplicate arrival.

Tier: `battery`

```ts
import { … } from "@demlik/tea/idempotency";
```

## Exports (16)

| Symbol | Kind | Tier | Summary |
| --- | --- | --- | --- |
| [`createIntake`](#createIntake) | Function | battery | Build an idempotent-intake knob from `config`. |
| [`evictExpired`](#evictExpired) | Function | battery | Drop every entry expired at `nowMs` (older than `ttlMs`). |
| [`IdempotencyEntry`](#IdempotencyEntry) | Interface | battery | A cached entry: the result `value` the original request produced and the clock reading `atMs` it was remembered at. |
| [`IdempotencyStore`](#IdempotencyStore) | Interface | battery | The dedupe store: a map of `key → entry`, an insertion-`order` ledger (oldest-first) that capacity eviction reads, and the two optional bounds. |
| [`initStore`](#initStore) | Function | battery | Create an empty store. |
| [`IntakeCmd`](#IntakeCmd) | Type | battery | The Cmd union the intake verbs emit. |
| [`IntakeConfig`](#IntakeConfig) | Interface | battery | The intake knob's config — `keyOf` derives the idempotency key from a payload, `ttlMs` (optional) ages a *completed* cached key out so a webhook replayed long after the work finished is treated as new and re-processed. |
| [`IntakeEntry`](#IntakeEntry) | Type | battery | A cached intake entry: either a key whose work is still in flight (`pending`) or one whose work has finished and whose `result` is held for replay to later duplicates (`done`). |
| [`IntakeProcessCmd`](#IntakeProcessCmd) | Type | battery | The Cmd intake emits for a first-time request: process `payload` for the queue item `itemId`. |
| [`intakeProcessDef`](#intakeProcessDef) | Function | battery | A genuinely-new payload was accepted and enqueued — go run the work. |
| [`IntakeReplayCmd`](#IntakeReplayCmd) | Type | battery | The Cmd intake emits for a duplicate of a completed request: hand back the cached `result` instead of redoing the work. |
| [`intakeReplayDef`](#intakeReplayDef) | Function | battery | A duplicate of an already-completed key arrived — replay the cached result to the caller instead of re-running the side effect. |
| [`IntakeState`](#IntakeState) | Interface | battery | The Model slice this knob owns. |
| [`recall`](#recall) | Function | battery | The cached `value` for `key` if present and unexpired at `nowMs`, else `undefined`. |
| [`remember`](#remember) | Function | battery | Record `key → value` at `nowMs`, then enforce both bounds. |
| [`seen`](#seen) | Function | battery | True iff `key` is present AND not expired at `nowMs`. |

## Declarations

<a id="createIntake"></a>

### `createIntake`

```ts
function createIntake<P, R>(
  config: IntakeConfig<P>,
): {
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
  boot: (
    state: IntakeState<P, R>,
  ) => readonly [IntakeState<P, R>, readonly IntakeCmd<P, R>[]];
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
  claimNext: (
    state: IntakeState<P, R>,
    at: number,
  ) => {
    readonly claimed: QueueItem<P>;
    readonly state: IntakeState<P, R>;
  } | null;
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
  complete: (
    state: IntakeState<P, R>,
    key: string,
    result: R,
    at: number,
  ) => readonly [IntakeState<P, R>, readonly IntakeCmd<P, R>[]];
  /**
   * The empty slice: a TTL-free idempotency store (intake owns the TTL itself —
   * see `liveEntry`, because the store cannot tell `pending` from `done`) plus
   * an empty work queue. The rehydrate path is the host's `init(loaded)` — it
   * passes the persisted slice straight back, this is only the fresh-boot value.
   */
  init: () => IntakeState<P, R>;
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
  receive: (
    state: IntakeState<P, R>,
    payload: P,
    at: number,
    id: string,
  ) => readonly [IntakeState<P, R>, readonly IntakeCmd<P, R>[]];
}
```

<a id="evictExpired"></a>

### `evictExpired`

```ts
function evictExpired<V>(
  store: IdempotencyStore<V>,
  nowMs: number,
): IdempotencyStore<V>
```

<a id="IdempotencyEntry"></a>

### `IdempotencyEntry`

```ts
interface IdempotencyEntry<V> {
  readonly atMs: number;
  readonly value: V;
}
```

<a id="IdempotencyStore"></a>

### `IdempotencyStore`

```ts
interface IdempotencyStore<V> {
  readonly capacity?: number;
  readonly entries: Readonly<Record<string, IdempotencyEntry<V>>>;
  readonly order: readonly string[];
  readonly ttlMs?: number;
}
```

<a id="initStore"></a>

### `initStore`

```ts
function initStore<V>(
  opts?: { capacity?: number; ttlMs?: number },
): IdempotencyStore<V>
```

<a id="IntakeCmd"></a>

### `IntakeCmd`

```ts
type IntakeCmd<P, R> = IntakeProcessCmd<P> | IntakeReplayCmd<R>
```

<a id="IntakeConfig"></a>

### `IntakeConfig`

```ts
interface IntakeConfig<P> {
  /** Derive the idempotency key from a payload. Must be pure + deterministic. */
  readonly keyOf: (payload: P) => string;
  /**
   * Age a *completed* key out after this many ms, measured from the `at`
   * passed to `complete`. Pending keys never age out.
   */
  readonly ttlMs?: number;
}
```

<a id="IntakeEntry"></a>

### `IntakeEntry`

```ts
type IntakeEntry<R> = { readonly phase: "pending" } | { readonly phase: "done"; readonly result: R }
```

<a id="IntakeProcessCmd"></a>

### `IntakeProcessCmd`

```ts
type IntakeProcessCmd<P> = CmdOf<ReturnType<typeof intakeProcessDef>>
```

<a id="intakeProcessDef"></a>

### `intakeProcessDef`

```ts
function intakeProcessDef<P>(): CmdDef<"intake:process", {
  /** The enqueued queue-item id (the same `id` passed to `receive`). */
  readonly itemId: string;
  /** The dedupe key the payload was filed under. */
  readonly key: string;
  /** The original payload, for the worker to process. */
  readonly payload: P;
}, undefined, never>
```

<a id="IntakeReplayCmd"></a>

### `IntakeReplayCmd`

```ts
type IntakeReplayCmd<R> = CmdOf<ReturnType<typeof intakeReplayDef>>
```

<a id="intakeReplayDef"></a>

### `intakeReplayDef`

```ts
function intakeReplayDef<R>(): CmdDef<"intake:replay", {
  /** The dedupe key whose cached result is being replayed. */
  readonly key: string;
  /** The result the ORIGINAL request produced, recalled from the cache. */
  readonly result: R;
}, undefined, never>
```

<a id="IntakeState"></a>

### `IntakeState`

```ts
interface IntakeState<P, R> {
  readonly queue: readonly QueueItem<P>[];
  readonly seen: IdempotencyStore<IntakeEntry<R>>;
}
```

<a id="recall"></a>

### `recall`

```ts
function recall<V>(
  store: IdempotencyStore<V>,
  key: string,
  nowMs: number,
): V | undefined
```

<a id="remember"></a>

### `remember`

```ts
function remember<V>(
  store: IdempotencyStore<V>,
  key: string,
  value: V,
  nowMs: number,
): IdempotencyStore<V>
```

<a id="seen"></a>

### `seen`

```ts
function seen<V>(
  store: IdempotencyStore<V>,
  key: string,
  nowMs: number,
): boolean
```
