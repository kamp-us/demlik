/**
 * Pure queue-lifecycle ops over `QueueItem<I>[]` — the BLESSED delegation
 * surface for this package.
 *
 * Each op is `(queue, ...args) => { next, result? }`. No I/O, no Date.now
 * indirection beyond a plain call site — the adapter in `./index.ts` injects
 * `Store<QueueItem<I>[]>` and orchestrates `load → mutate → save`.
 *
 * Substrate-agnostic by construction: nothing here references chrome.storage,
 * Cloudflare, or any concrete persistence layer. The audit-specific shape
 * (journeyId, projectId, ...) is lifted into the caller's `I` parameter.
 *
 * Importable two ways. The `createQueue(...)` adapter in `./index.ts` binds
 * these ops to a `Store` for in-process use (same one-shape-per-package rule
 * as `@demlik/tea/do`). L2 compositions that own their own Model slice
 * (`monitored-run`, `idempotent-intake`, …) instead reach these ops directly
 * via the `@demlik/tea/work-queue/ops` subpath, so a status flip is delegated
 * here rather than re-rolled per call site.
 */

import { at } from "../at";
import type { QueueItem } from "./index";

/** Append a new pending item. Returns the new queue and the created item. */
export function enqueueOp<I>(
  queue: readonly QueueItem<I>[],
  input: I,
  now: number,
  id: string,
): { next: QueueItem<I>[]; item: QueueItem<I> } {
  const item: QueueItem<I> = {
    id,
    status: "pending",
    input,
    enqueuedAt: now,
  };
  return { next: [...queue, item], item };
}

/**
 * Claim the first pending item by flipping it to `running` and stamping
 * `startedAt`. Returns the new queue and the claimed item, or `null` if no
 * pending item exists.
 */
export function claimNextOp<I>(
  queue: readonly QueueItem<I>[],
  now: number,
): { next: QueueItem<I>[]; claimed: QueueItem<I> } | null {
  const idx = queue.findIndex((i) => i.status === "pending");
  // `at` collapses "no pending item" (idx === -1) into the same `undefined`
  // early-out, so the element is typed `QueueItem<I>` below without a non-null
  // assertion; `idx` stays around for the write.
  const target = at(queue, idx);
  if (target === undefined) return null;
  const claimed: QueueItem<I> = {
    ...target,
    status: "running",
    startedAt: now,
  };
  const next = queue.slice();
  next[idx] = claimed;
  return { next, claimed };
}

/**
 * Done items leave the queue — completed runs live wherever the caller
 * persists their output. Returns the new queue (or the original reference if
 * no item matched, so the adapter can skip a save).
 */
export function markDoneOp<I>(
  queue: readonly QueueItem<I>[],
  id: string,
): { next: QueueItem<I>[]; changed: boolean } {
  const next = queue.filter((i) => i.id !== id);
  return { next, changed: next.length !== queue.length };
}

/**
 * Generic single-item status transition. Used by `markFailed`,
 * `markCancelled`, `retryItem`, `bindOutput`. The patch closure receives the
 * matched item and returns its replacement; returning the same reference is
 * fine (the adapter only saves on `changed`).
 */
export function patchItemOp<I>(
  queue: readonly QueueItem<I>[],
  id: string,
  patch: (item: QueueItem<I>) => QueueItem<I>,
): { next: QueueItem<I>[]; changed: boolean } {
  const idx = queue.findIndex((i) => i.id === id);
  // `at` collapses the no-match case into an `undefined` early-out, narrowing
  // `target` to `QueueItem<I>` for `patch` without a non-null assertion; `idx`
  // stays around for the write.
  const target = at(queue, idx);
  if (target === undefined) return { next: queue.slice(), changed: false };
  const next = queue.slice();
  next[idx] = patch(target);
  return { next, changed: true };
}

/** Reset every `running` item back to `pending`, clearing `startedAt`. */
export function resetRunningOp<I>(queue: readonly QueueItem<I>[]): {
  next: QueueItem<I>[];
  changed: boolean;
} {
  let changed = false;
  const next = queue.map((i): QueueItem<I> => {
    if (i.status !== "running") return i;
    changed = true;
    return { ...i, status: "pending", startedAt: undefined };
  });
  return { next, changed };
}

/** Hard-delete an item regardless of status. */
export function removeOp<I>(
  queue: readonly QueueItem<I>[],
  id: string,
): { next: QueueItem<I>[]; changed: boolean } {
  const next = queue.filter((i) => i.id !== id);
  return { next, changed: next.length !== queue.length };
}
