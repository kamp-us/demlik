# @demlik/tea/work-queue

> a substrate-agnostic work-queue lifecycle over `Store<S>`: enqueue, claim the next item, mark it done, failed or cancelled, and reset whatever was running when the process went away.

Tier: `battery`

```ts
import { … } from "@demlik/tea/work-queue";
```

## Exports (12)

| Symbol | Kind | Tier | Summary |
| --- | --- | --- | --- |
| [`claimNextOp`](#claimNextOp) | Function | battery | Claim the first pending item by flipping it to `running` and stamping `startedAt`. |
| [`createQueue`](#createQueue) | Function | battery | Adapter that binds the pure ops to an injected `Store<QueueItem<I>[]>`. |
| [`EnqueueInput`](#EnqueueInput) | Type | battery | Caller-facing enqueue payload. |
| [`enqueueOp`](#enqueueOp) | Function | battery | Append a new pending item. |
| [`markDoneOp`](#markDoneOp) | Function | battery | Done items leave the queue — completed runs live wherever the caller persists their output. |
| [`patchItemOp`](#patchItemOp) | Function | battery | Generic single-item status transition. |
| [`queueAdapter`](#queueAdapter) | Function | battery | The canonical `QueueAdapter<I>`, binding each verb to its blessed op. |
| [`QueueAdapter`](#QueueAdapter) | Interface | battery | The verb interface over a `QueueItem<I>[]` slice. |
| [`QueueItem`](#QueueItem) | Interface | battery | A single queue entry. |
| [`QueueItemStatus`](#QueueItemStatus) | Type | battery | Where a queue item is in its lifecycle: `pending`, `running`, `done`, `failed` or `cancelled`. |
| [`removeOp`](#removeOp) | Function | battery | Hard-delete an item regardless of status. |
| [`resetRunningOp`](#resetRunningOp) | Function | battery | Reset every `running` item back to `pending`, clearing `startedAt`. |

## Declarations

<a id="claimNextOp"></a>

### `claimNextOp`

```ts
function claimNextOp<I>(
  queue: readonly QueueItem<I>[],
  now: number,
): { claimed: QueueItem<I>; next: QueueItem<I>[] } | null
```

<a id="createQueue"></a>

### `createQueue`

```ts
function createQueue<I>(
  store: Store<QueueItem<I>[]>,
): {
  bindOutput: (id: string, value: string) => Promise<void>;
  claimNext: () => Promise<QueueItem<I> | null>;
  enqueue: (input: I) => Promise<QueueItem<I>>;
  list: () => Promise<QueueItem<I>[]>;
  markCancelled: (id: string) => Promise<void>;
  markDone: (id: string) => Promise<void>;
  markFailed: (id: string, error: string) => Promise<void>;
  removeItem: (id: string) => Promise<void>;
  resetRunningToPending: () => Promise<void>;
  retryItem: (id: string) => Promise<void>;
}
```

<a id="EnqueueInput"></a>

### `EnqueueInput`

```ts
type EnqueueInput<I> = I
```

<a id="enqueueOp"></a>

### `enqueueOp`

```ts
function enqueueOp<I>(
  queue: readonly QueueItem<I>[],
  input: I,
  now: number,
  id: string,
): { item: QueueItem<I>; next: QueueItem<I>[] }
```

<a id="markDoneOp"></a>

### `markDoneOp`

```ts
function markDoneOp<I>(
  queue: readonly QueueItem<I>[],
  id: string,
): { changed: boolean; next: QueueItem<I>[] }
```

<a id="patchItemOp"></a>

### `patchItemOp`

```ts
function patchItemOp<I>(
  queue: readonly QueueItem<I>[],
  id: string,
  patch: (item: QueueItem<I>) => QueueItem<I>,
): { changed: boolean; next: QueueItem<I>[] }
```

<a id="queueAdapter"></a>

### `queueAdapter`

```ts
function queueAdapter<I>(): QueueAdapter<I>
```

<a id="QueueAdapter"></a>

### `QueueAdapter`

```ts
interface QueueAdapter<I> {
  /**
   * Claim the first `pending` item — flip it `running`, stamp `startedAt` to
   * `now` — or `null` if nothing is pending.
   */
  claim(
    queue: readonly QueueItem<I>[],
    now: number,
  ): { claimed: QueueItem<I>; next: QueueItem<I>[] } | null;
  /** Append a new `pending` item stamped `now` under `id`. */
  enqueue(
    queue: readonly QueueItem<I>[],
    input: I,
    now: number,
    id: string,
  ): { item: QueueItem<I>; next: QueueItem<I>[] };
  /** Drop the item `id` from the queue (completed runs leave the queue). */
  markDone(
    queue: readonly QueueItem<I>[],
    id: string,
  ): { changed: boolean; next: QueueItem<I>[] };
  /**
   * Single-item transition: replace the item `id` with `patch(item)`. The
   * closure is the only place a `QueueItem` literal is constructed, so the
   * field shape stays out of the consumer's hands except through this verb.
   */
  patch(
    queue: readonly QueueItem<I>[],
    id: string,
    patch: (item: QueueItem<I>) => QueueItem<I>,
  ): { changed: boolean; next: QueueItem<I>[] };
}
```

<a id="QueueItem"></a>

### `QueueItem`

```ts
interface QueueItem<I> {
  readonly enqueuedAt: number;
  readonly error?: string;
  readonly finishedAt?: number;
  readonly id: string;
  readonly input: I;
  readonly output?: string;
  readonly startedAt?: number;
  readonly status: QueueItemStatus;
}
```

<a id="QueueItemStatus"></a>

### `QueueItemStatus`

```ts
type QueueItemStatus = "pending" | "running" | "done" | "failed" | "cancelled"
```

<a id="removeOp"></a>

### `removeOp`

```ts
function removeOp<I>(
  queue: readonly QueueItem<I>[],
  id: string,
): { changed: boolean; next: QueueItem<I>[] }
```

<a id="resetRunningOp"></a>

### `resetRunningOp`

```ts
function resetRunningOp<I>(
  queue: readonly QueueItem<I>[],
): { changed: boolean; next: QueueItem<I>[] }
```
