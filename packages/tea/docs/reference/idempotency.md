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
  boot: (
    state: IntakeState<P, R>,
  ) => readonly [IntakeState<P, R>, readonly IntakeCmd<P, R>[]];
  claimNext: (
    state: IntakeState<P, R>,
    at: number,
  ) => {
    readonly claimed: QueueItem<P>;
    readonly state: IntakeState<P, R>;
  } | null;
  complete: (
    state: IntakeState<P, R>,
    key: string,
    result: R,
    at: number,
  ) => readonly [IntakeState<P, R>, readonly IntakeCmd<P, R>[]];
  init: () => IntakeState<P, R>;
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
  readonly keyOf: (payload: P) => string;
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
  readonly itemId: string;
  readonly key: string;
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
function intakeReplayDef<R>(): CmdDef<"intake:replay", { readonly key: string; readonly result: R }, undefined, never>
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
