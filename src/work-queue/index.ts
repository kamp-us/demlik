/**
 * @packageDocumentation
 * @demlik/tea/work-queue — substrate-agnostic work-queue lifecycle on `Store<S>`.
 *
 * Two public surfaces, one shape:
 *   - `createQueue(store)` (this file) is the in-process adapter — it binds the
 *     pure ops to an injected `Store` and runs `load → mutate → save`.
 *   - `@demlik/tea/work-queue/ops` (`./ops`) is the BLESSED, importable surface
 *     of those same pure ops. L2 compositions that own their own Model slice
 *     (`monitored-run`, `idempotent-intake`, …) import the ops directly and
 *     delegate status flips to them instead of re-rolling the transitions.
 * Both routes call the identical ops, so the lifecycle rules live in exactly
 * one place. This mirrors `@demlik/tea/do`'s one-shape-per-package rule.
 *
 * The package is generic in the input payload `I` (audit-specific fields go
 * here in the extension host). `output` is a free-form side-channel correlation
 * token (a backend id, URL, trace id) — typed as `string` because that's its
 * only honest type. Consumers that need structured per-item data persist it in
 * their own store and put the foreign-key string in `output`.
 */

import type { Store } from "../index";
import {
  claimNextOp,
  enqueueOp,
  markDoneOp,
  patchItemOp,
  removeOp,
  resetRunningOp,
} from "./ops";

/**
 * Generate a queue-item id at the adapter boundary. Reads `Date.now()` and
 * `Math.random()` — impure helpers belong in the adapter (`index.ts`),
 * never in `ops.ts` (which is purely-functional by contract). Uses native
 * UUID when available, falls back to timestamp + random for environments
 * without `crypto.randomUUID`.
 */
function genId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `q_${Date.now()}_${Math.random().toString(36).slice(2)}`
  );
}

export type QueueItemStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "cancelled";

/**
 * A single queue entry. Every field is `readonly`: a persisted slice is
 * immutable, so a transition returns a NEW item (the ops always spread —
 * `{ ...item, status: … }`) rather than mutating in place. This type-enforces
 * the durability invariant the consumers already honor by convention, and
 * keeps a slice round-trippable through JSON unchanged across a reload.
 */
export interface QueueItem<I> {
  readonly id: string;
  readonly status: QueueItemStatus;
  readonly input: I;
  readonly enqueuedAt: number;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly output?: string;
  readonly error?: string;
}

/**
 * Caller-facing enqueue payload. Just `I` today — kept named so future
 * variants (priority, deferUntil, …) can grow without breaking callers.
 */
export type EnqueueInput<I> = I;

/**
 * Adapter that binds the pure ops to an injected `Store<QueueItem<I>[]>`.
 *
 * `load → mutate → save` is the only durability discipline this package
 * imposes. The store decides what "save" means (chrome.storage, KV, DO
 * storage, in-memory) — that decision belongs at the caller.
 *
 * Ops that don't change the queue (e.g. `markDone` on an unknown id) skip the
 * save call so the underlying store doesn't observe a write churn.
 */
export function createQueue<I>(store: Store<QueueItem<I>[]>) {
  // `Store<S>.load()` returns `unknown` (invariant 8 boundary). Route
  // through `store.migrate(raw)` to get the typed value before any
  // queue operation reads it — same wiring the substrate's `run()` uses at
  // boot. The work queue is a substrate-agnostic primitive on top of
  // `Store<S>`, so it honors the same contract.
  async function loadParsed(): Promise<QueueItem<I>[] | null> {
    const raw = await store.load();
    return store.migrate(raw);
  }

  async function list(): Promise<QueueItem<I>[]> {
    return (await loadParsed()) ?? [];
  }

  async function enqueue(input: EnqueueInput<I>): Promise<QueueItem<I>> {
    const queue = await list();
    const { next, item } = enqueueOp<I>(queue, input, Date.now(), genId());
    await store.save(next);
    return item;
  }

  async function claimNext(): Promise<QueueItem<I> | null> {
    const queue = await list();
    const result = claimNextOp<I>(queue, Date.now());
    if (!result) return null;
    await store.save(result.next);
    return result.claimed;
  }

  // `markDone` ignores the optional second arg by design: completed runs leave
  // the queue, and the consumer is expected to persist any output (auditId,
  // etc.) wherever those completed records belong. Kept in the signature for
  // call-site readability and forward-compat with `bindOutput`.
  async function markDone(id: string): Promise<void> {
    const queue = await list();
    const { next, changed } = markDoneOp<I>(queue, id);
    if (changed) await store.save(next);
  }

  async function markFailed(id: string, error: string): Promise<void> {
    const queue = await list();
    const { next, changed } = patchItemOp<I>(queue, id, (item) => ({
      ...item,
      status: "failed",
      finishedAt: Date.now(),
      error,
    }));
    if (changed) await store.save(next);
  }

  async function markCancelled(id: string): Promise<void> {
    const queue = await list();
    const { next, changed } = patchItemOp<I>(queue, id, (item) => ({
      ...item,
      status: "cancelled",
      finishedAt: Date.now(),
    }));
    if (changed) await store.save(next);
  }

  async function resetRunningToPending(): Promise<void> {
    const queue = await list();
    const { next, changed } = resetRunningOp<I>(queue);
    if (changed) await store.save(next);
  }

  async function removeItem(id: string): Promise<void> {
    const queue = await list();
    const { next, changed } = removeOp<I>(queue, id);
    if (changed) await store.save(next);
  }

  async function retryItem(id: string): Promise<void> {
    const queue = await list();
    const { next, changed } = patchItemOp<I>(queue, id, (item) => ({
      ...item,
      status: "pending",
      startedAt: undefined,
      finishedAt: undefined,
      error: undefined,
      output: undefined,
    }));
    if (changed) await store.save(next);
  }

  // `bindOutput` attaches a side-channel correlation token (string) to a
  // running item without changing its status. The queue can't reach into
  // `I` to mutate it (the substrate is domain-agnostic), so callers that
  // need to thread a backend id / URL / trace id through the lifecycle
  // route it here. Consumers needing structured payloads should persist
  // them in their own store and put the foreign-key string in `output`.
  async function bindOutput(id: string, value: string): Promise<void> {
    const queue = await list();
    const { next, changed } = patchItemOp<I>(queue, id, (item) => ({
      ...item,
      output: value,
    }));
    if (changed) await store.save(next);
  }

  return {
    enqueue,
    claimNext,
    markDone,
    markFailed,
    markCancelled,
    resetRunningToPending,
    removeItem,
    retryItem,
    bindOutput,
    list,
  };
}
