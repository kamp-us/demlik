# @demlik/tea/work-queue

> a substrate-agnostic work-queue lifecycle over `Store<S>`: enqueue, claim the next item, mark it done, failed or cancelled, and reset whatever was running when the process went away.

```ts
import { … } from "@demlik/tea/work-queue";
```

## Exports (12)

| Symbol | Kind | Summary |
| --- | --- | --- |
| `claimNextOp` | Function | Claim the first pending item by flipping it to `running` and stamping `startedAt`. |
| `createQueue` | Function | Adapter that binds the pure ops to an injected `Store<QueueItem<I>[]>`. |
| `EnqueueInput` | Type | Caller-facing enqueue payload. |
| `enqueueOp` | Function | Append a new pending item. |
| `markDoneOp` | Function | Done items leave the queue — completed runs live wherever the caller persists their output. |
| `patchItemOp` | Function | Generic single-item status transition. |
| `queueAdapter` | Function | The canonical `QueueAdapter<I>`, binding each verb to its blessed op. |
| `QueueAdapter` | Interface | The verb interface over a `QueueItem<I>[]` slice. |
| `QueueItem` | Interface | A single queue entry. |
| `QueueItemStatus` | Type |  |
| `removeOp` | Function | Hard-delete an item regardless of status. |
| `resetRunningOp` | Function | Reset every `running` item back to `pending`, clearing `startedAt`. |
