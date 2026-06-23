/**
 * @demlik/tea/work-queue/adapter — the verb seam over the pure queue ops.
 *
 * The pure ops in `./ops` are the BLESSED transitions, but their names and
 * argument tuples (`enqueueOp(queue, input, now, id)`, `claimNextOp(queue,
 * now)`, …) and their `{ next, item }` / `{ next, changed }` result shapes are
 * the STORE's vocabulary, not the consumer's. An L2 composition that owns a
 * `QueueItem<I>[]` slice (`monitored-run`, `saga`, `idempotent-intake`,
 * `fan-out`) used to import those ops by name and call them directly, so a
 * change to the op surface — or to `QueueItem`'s fields — cascaded to every
 * call site.
 *
 * `QueueAdapter<I>` is the insulating interface: four VERBS (`enqueue` /
 * `claim` / `markDone` / `patch`) that consumers depend on instead of the raw
 * ops. The verbs keep the ops' pure `(queue, …) => { next, … }` contract — they
 * are pure array transforms, no I/O, no `Date.now` (the clock is injected as
 * `now`, exactly as the ops require it) — so a consumer folding the adapter
 * through its reducer stays inside invariant 2 (pure transitions).
 *
 * `queueAdapter<I>()` is the canonical implementation, a thin binding of the
 * blessed ops. Because the verbs are the only surface consumers touch, a
 * `QueueItem` shape change (a new field, a renamed status, a different op
 * signature) is now absorbed HERE — re-bind the verb once — rather than at the
 * 4 consumer call sites. The `patch` verb deliberately takes the same
 * `(item) => item` closure `patchItemOp` does, so the one place a `QueueItem`
 * literal is spread stays the consumer's patch closure, never a re-rolled
 * record.
 *
 * This is an INTERNAL seam (no public-API port): consumers import the adapter
 * from this subpath the same way they imported the ops. The ops remain
 * exported for the in-process `createQueue` adapter (`./index`) and for any
 * call site that genuinely wants the op directly.
 */

import type { QueueItem } from "./index";
import { claimNextOp, enqueueOp, markDoneOp, patchItemOp } from "./ops";

/**
 * The verb interface over a `QueueItem<I>[]` slice. Each verb mirrors a blessed
 * op's pure contract but speaks the consumer's lifecycle vocabulary, so the
 * consumer never names a `*Op` function or reaches into a `QueueItem` field it
 * did not put there.
 */
export interface QueueAdapter<I> {
  /** Append a new `pending` item stamped `now` under `id`. */
  enqueue(
    queue: readonly QueueItem<I>[],
    input: I,
    now: number,
    id: string,
  ): { next: QueueItem<I>[]; item: QueueItem<I> };

  /**
   * Claim the first `pending` item — flip it `running`, stamp `startedAt` to
   * `now` — or `null` if nothing is pending.
   */
  claim(
    queue: readonly QueueItem<I>[],
    now: number,
  ): { next: QueueItem<I>[]; claimed: QueueItem<I> } | null;

  /** Drop the item `id` from the queue (completed runs leave the queue). */
  markDone(
    queue: readonly QueueItem<I>[],
    id: string,
  ): { next: QueueItem<I>[]; changed: boolean };

  /**
   * Single-item transition: replace the item `id` with `patch(item)`. The
   * closure is the only place a `QueueItem` literal is constructed, so the
   * field shape stays out of the consumer's hands except through this verb.
   */
  patch(
    queue: readonly QueueItem<I>[],
    id: string,
    patch: (item: QueueItem<I>) => QueueItem<I>,
  ): { next: QueueItem<I>[]; changed: boolean };
}

/**
 * The canonical `QueueAdapter<I>`, binding each verb to its blessed op. Pure
 * and stateless — call once at module scope in a consumer and fold its verbs
 * through the reducer. A `QueueItem` shape change is absorbed by re-binding a
 * verb here, not at the consumers.
 */
export function queueAdapter<I>(): QueueAdapter<I> {
  return {
    enqueue: (queue, input, now, id) => enqueueOp<I>(queue, input, now, id),
    claim: (queue, now) => claimNextOp<I>(queue, now),
    markDone: (queue, id) => markDoneOp<I>(queue, id),
    patch: (queue, id, patch) => patchItemOp<I>(queue, id, patch),
  };
}
