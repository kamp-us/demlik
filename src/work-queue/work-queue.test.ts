import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { memoryStore } from "../mem";
import { createQueue, type QueueItem } from "./index";
import {
  claimNextOp,
  enqueueOp,
  markDoneOp,
  patchItemOp,
  removeOp,
  resetRunningOp,
} from "./ops";

// `I` for these tests is a plain JSON-serializable payload — the work queue is
// generic in the input, and a string is the smallest honest stand-in for the
// audit-specific shapes real callers thread through.
type Input = string;

// ===========================================================================
// Pure ops — the BLESSED delegation surface (`@demlik/tea/work-queue/ops`).
// L2 compositions import these directly; they are tested directly here.
// ===========================================================================

describe("work-queue ops (pure surface)", () => {
  it("enqueueOp appends a pending item and returns it", () => {
    const { next, item } = enqueueOp<Input>([], "a", 100, "id-1");
    expect(next).toEqual([item]);
    expect(item).toEqual({
      id: "id-1",
      status: "pending",
      input: "a",
      enqueuedAt: 100,
    });
    // Input queue is never mutated — a new array is returned.
    const queue: readonly QueueItem<Input>[] = [];
    enqueueOp<Input>(queue, "b", 1, "id-2");
    expect(queue).toEqual([]);
  });

  it("claimNextOp flips the first pending item to running and stamps startedAt", () => {
    const seeded = enqueueOp<Input>(
      enqueueOp<Input>([], "a", 1, "1").next,
      "b",
      2,
      "2",
    ).next;
    const result = claimNextOp<Input>(seeded, 50);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.claimed).toEqual({
      id: "1",
      status: "running",
      input: "a",
      enqueuedAt: 1,
      startedAt: 50,
    });
    // Only the first pending item is claimed.
    expect(result.next[1]?.status).toBe("pending");
    // The original slice is untouched.
    expect(seeded[0]?.status).toBe("pending");
  });

  it("claimNextOp returns null when no pending item exists", () => {
    expect(claimNextOp<Input>([], 1)).toBeNull();
    const running =
      claimNextOp<Input>(enqueueOp<Input>([], "a", 1, "1").next, 5)?.next ?? [];
    // Once the only item is running, a second claim finds nothing pending.
    expect(claimNextOp<Input>(running, 9)).toBeNull();
  });

  it("markDoneOp removes the matching item; done runs leave the queue", () => {
    const seeded = enqueueOp<Input>([], "a", 1, "1").next;
    const { next, changed } = markDoneOp<Input>(seeded, "1");
    expect(changed).toBe(true);
    expect(next).toEqual([]);
  });

  it("markDoneOp reports no change on an unknown id (adapter skips the save)", () => {
    const seeded = enqueueOp<Input>([], "a", 1, "1").next;
    const { next, changed } = markDoneOp<Input>(seeded, "missing");
    expect(changed).toBe(false);
    expect(next).toEqual(seeded);
  });

  it("patchItemOp applies the patch to the matched item only", () => {
    const seeded = enqueueOp<Input>(
      enqueueOp<Input>([], "a", 1, "1").next,
      "b",
      2,
      "2",
    ).next;
    const { next, changed } = patchItemOp<Input>(seeded, "2", (item) => ({
      ...item,
      status: "failed",
      finishedAt: 99,
      error: "boom",
    }));
    expect(changed).toBe(true);
    expect(next[0]).toEqual(seeded[0]);
    expect(next[1]).toEqual({
      id: "2",
      status: "failed",
      input: "b",
      enqueuedAt: 2,
      finishedAt: 99,
      error: "boom",
    });
  });

  it("patchItemOp reports no change on an unknown id", () => {
    const seeded = enqueueOp<Input>([], "a", 1, "1").next;
    const { next, changed } = patchItemOp<Input>(seeded, "missing", (i) => i);
    expect(changed).toBe(false);
    expect(next).toEqual(seeded);
  });

  it("resetRunningOp flips every running item back to pending and clears startedAt", () => {
    let queue = enqueueOp<Input>([], "a", 1, "1").next;
    queue = claimNextOp<Input>(queue, 5)?.next ?? queue;
    expect(queue[0]?.status).toBe("running");
    const { next, changed } = resetRunningOp<Input>(queue);
    expect(changed).toBe(true);
    expect(next[0]).toEqual({
      id: "1",
      status: "pending",
      input: "a",
      enqueuedAt: 1,
    });
    // `startedAt` is cleared to `undefined` — JSON drops it on the next save,
    // so the reloaded slice carries no stale start stamp.
    expect(next[0]?.startedAt).toBeUndefined();
  });

  it("resetRunningOp reports no change when nothing is running", () => {
    const seeded = enqueueOp<Input>([], "a", 1, "1").next;
    const { next, changed } = resetRunningOp<Input>(seeded);
    expect(changed).toBe(false);
    expect(next).toEqual(seeded);
  });

  it("removeOp hard-deletes regardless of status", () => {
    let queue = enqueueOp<Input>([], "a", 1, "1").next;
    queue = claimNextOp<Input>(queue, 5)?.next ?? queue;
    const { next, changed } = removeOp<Input>(queue, "1");
    expect(changed).toBe(true);
    expect(next).toEqual([]);
  });

  it("removeOp reports no change on an unknown id", () => {
    const seeded = enqueueOp<Input>([], "a", 1, "1").next;
    const { next, changed } = removeOp<Input>(seeded, "missing");
    expect(changed).toBe(false);
    expect(next).toEqual(seeded);
  });
});

// ===========================================================================
// Adapter — `createQueue(store)`, the in-process surface.
// ===========================================================================

describe("createQueue adapter", () => {
  it("enqueue persists a pending item and list reads it back", async () => {
    const store = memoryStore<QueueItem<Input>[]>();
    const q = createQueue<Input>(store);
    const item = await q.enqueue("a");
    expect(item.status).toBe("pending");
    expect(await q.list()).toEqual([item]);
  });

  it("claimNext flips pending → running; a drained queue yields null", async () => {
    const q = createQueue<Input>(memoryStore<QueueItem<Input>[]>());
    await q.enqueue("a");
    const claimed = await q.claimNext();
    expect(claimed?.status).toBe("running");
    expect(await q.claimNext()).toBeNull();
  });

  it("markDone removes the item from the queue", async () => {
    const q = createQueue<Input>(memoryStore<QueueItem<Input>[]>());
    const { id } = await q.enqueue("a");
    await q.markDone(id);
    expect(await q.list()).toEqual([]);
  });

  it("markFailed stamps failed + finishedAt + error", async () => {
    const q = createQueue<Input>(memoryStore<QueueItem<Input>[]>());
    const { id } = await q.enqueue("a");
    await q.claimNext();
    await q.markFailed(id, "boom");
    const [item] = await q.list();
    expect(item?.status).toBe("failed");
    expect(item?.error).toBe("boom");
    expect(typeof item?.finishedAt).toBe("number");
  });

  it("markCancelled stamps cancelled + finishedAt", async () => {
    const q = createQueue<Input>(memoryStore<QueueItem<Input>[]>());
    const { id } = await q.enqueue("a");
    await q.markCancelled(id);
    const [item] = await q.list();
    expect(item?.status).toBe("cancelled");
    expect(typeof item?.finishedAt).toBe("number");
  });

  it("resetRunningToPending re-pends in-flight items (crash recovery)", async () => {
    const q = createQueue<Input>(memoryStore<QueueItem<Input>[]>());
    await q.enqueue("a");
    await q.claimNext();
    await q.resetRunningToPending();
    const [item] = await q.list();
    expect(item?.status).toBe("pending");
    expect(item?.startedAt).toBeUndefined();
  });

  it("retryItem clears terminal fields and re-pends", async () => {
    const q = createQueue<Input>(memoryStore<QueueItem<Input>[]>());
    const { id } = await q.enqueue("a");
    await q.claimNext();
    await q.markFailed(id, "boom");
    await q.retryItem(id);
    const [item] = await q.list();
    expect(item).toEqual({
      id,
      status: "pending",
      input: "a",
      enqueuedAt: item?.enqueuedAt,
    });
  });

  it("bindOutput attaches a correlation token without changing status", async () => {
    const q = createQueue<Input>(memoryStore<QueueItem<Input>[]>());
    const { id } = await q.enqueue("a");
    await q.claimNext();
    await q.bindOutput(id, "trace-123");
    const [item] = await q.list();
    expect(item?.status).toBe("running");
    expect(item?.output).toBe("trace-123");
  });

  it("removeItem hard-deletes the item", async () => {
    const q = createQueue<Input>(memoryStore<QueueItem<Input>[]>());
    const { id } = await q.enqueue("a");
    await q.removeItem(id);
    expect(await q.list()).toEqual([]);
  });
});

// ===========================================================================
// DURABILITY GUARD (package-wide invariant). Every reachable TERMINAL slice
// of this module must round-trip through JSON unchanged: a DO eviction +
// reload must resurrect the exact slice that was saved, never a lossy or
// mutated one. `readonly` QueueItem fields type-enforce immutability; this
// property enforces serializability. If any op ever introduced a non-plain
// value (a Date, a Map, an `Error` object — whose `JSON.stringify` is `{}`),
// this property fails.
// ===========================================================================

describe("durability guard — terminal slices round-trip through JSON", () => {
  // A driver action: each maps to exactly one blessed op. `idTag` selects an
  // existing item deterministically (by position), so failed/cancelled/retry/
  // bindOutput actually hit live items as the queue evolves.
  type Action =
    | { readonly kind: "enqueue"; readonly input: Input; readonly at: number }
    | { readonly kind: "claim"; readonly at: number }
    | { readonly kind: "done"; readonly pick: number }
    | {
        readonly kind: "fail";
        readonly pick: number;
        readonly at: number;
        readonly error: string;
      }
    | { readonly kind: "cancel"; readonly pick: number; readonly at: number }
    | { readonly kind: "reset" }
    | { readonly kind: "remove"; readonly pick: number };

  const actionArb: fc.Arbitrary<Action> = fc.oneof(
    fc.record({
      kind: fc.constant("enqueue" as const),
      input: fc.string(),
      at: fc.nat(1_000_000),
    }),
    fc.record({ kind: fc.constant("claim" as const), at: fc.nat(1_000_000) }),
    fc.record({ kind: fc.constant("done" as const), pick: fc.nat(20) }),
    fc.record({
      kind: fc.constant("fail" as const),
      pick: fc.nat(20),
      at: fc.nat(1_000_000),
      error: fc.string(),
    }),
    fc.record({
      kind: fc.constant("cancel" as const),
      pick: fc.nat(20),
      at: fc.nat(1_000_000),
    }),
    fc.record({ kind: fc.constant("reset" as const) }),
    fc.record({ kind: fc.constant("remove" as const), pick: fc.nat(20) }),
  );

  // Pick an existing item id by position (modulo length), or undefined when
  // the queue is empty. Keeps `pick`-driven actions landing on live items.
  function idAt(
    queue: readonly QueueItem<Input>[],
    pick: number,
  ): string | undefined {
    if (queue.length === 0) return undefined;
    return queue[pick % queue.length]?.id;
  }

  // Apply one action via the BLESSED ops only — the same surface L2 uses.
  function step(
    queue: readonly QueueItem<Input>[],
    action: Action,
    seq: number,
  ): QueueItem<Input>[] {
    switch (action.kind) {
      case "enqueue":
        return enqueueOp<Input>(queue, action.input, action.at, `id-${seq}`)
          .next;
      case "claim":
        return claimNextOp<Input>(queue, action.at)?.next ?? queue.slice();
      case "done": {
        const id = idAt(queue, action.pick);
        return id === undefined
          ? queue.slice()
          : markDoneOp<Input>(queue, id).next;
      }
      case "fail": {
        const id = idAt(queue, action.pick);
        if (id === undefined) return queue.slice();
        return patchItemOp<Input>(queue, id, (item) => ({
          ...item,
          status: "failed",
          finishedAt: action.at,
          error: action.error,
        })).next;
      }
      case "cancel": {
        const id = idAt(queue, action.pick);
        if (id === undefined) return queue.slice();
        return patchItemOp<Input>(queue, id, (item) => ({
          ...item,
          status: "cancelled",
          finishedAt: action.at,
        })).next;
      }
      case "reset":
        return resetRunningOp<Input>(queue).next;
      case "remove": {
        const id = idAt(queue, action.pick);
        return id === undefined
          ? queue.slice()
          : removeOp<Input>(queue, id).next;
      }
    }
  }

  it("any reachable slice (and every intermediate) round-trips equal", () => {
    fc.assert(
      fc.property(fc.array(actionArb, { maxLength: 40 }), (actions) => {
        let queue: QueueItem<Input>[] = [];
        actions.forEach((action, seq) => {
          queue = step(queue, action, seq);
          // Every step's slice — including non-terminal intermediates — is a
          // persisted boundary value, so each must survive a save/reload.
          const roundTripped: QueueItem<Input>[] = JSON.parse(
            JSON.stringify(queue),
          );
          expect(roundTripped).toEqual(queue);
        });
        return true;
      }),
    );
  });

  it("a slice driven to a terminal fixpoint round-trips equal", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string(), { minLength: 1, maxLength: 8 }),
        fc.array(actionArb, { maxLength: 40 }),
        (inputs, actions) => {
          // Seed a non-empty queue, then drive it.
          let queue: QueueItem<Input>[] = [];
          inputs.forEach((input, i) => {
            queue = enqueueOp<Input>(queue, input, i, `seed-${i}`).next;
          });
          actions.forEach((action, seq) => {
            queue = step(queue, action, inputs.length + seq);
          });
          // Drive every remaining live item to a terminal state so the slice
          // is genuinely TERMINAL: claim + fail every claimable item, until a
          // fixpoint (no claim succeeds and no pending/running item remains).
          for (let guard = 0; guard < 100; guard++) {
            const claim = claimNextOp<Input>(queue, 1_000);
            if (claim) {
              queue = patchItemOp<Input>(
                claim.next,
                claim.claimed.id,
                (item) => ({
                  ...item,
                  status: "failed",
                  finishedAt: 2_000,
                  error: "drain",
                }),
              ).next;
              continue;
            }
            const live = queue.some(
              (i) => i.status === "pending" || i.status === "running",
            );
            if (!live) break;
            // Nothing claimable but still live (shouldn't happen) — repend.
            queue = resetRunningOp<Input>(queue).next;
          }
          // The terminal slice has no pending/running items left.
          expect(
            queue.every(
              (i) => i.status === "failed" || i.status === "cancelled",
            ),
          ).toBe(true);
          const roundTripped: QueueItem<Input>[] = JSON.parse(
            JSON.stringify(queue),
          );
          expect(roundTripped).toEqual(queue);
          return true;
        },
      ),
    );
  });

  it("each terminal status, persisted via the adapter, survives a JSON reload", async () => {
    const store = memoryStore<QueueItem<Input>[]>();
    const q = createQueue<Input>(store);
    const failed = await q.enqueue("to-fail");
    const cancelled = await q.enqueue("to-cancel");
    await q.claimNext(); // claim the first (failed) item
    await q.markFailed(failed.id, "boom");
    await q.markCancelled(cancelled.id);
    const slice = await q.list();
    // The persisted slice carries both terminal statuses.
    expect(slice.map((i) => i.status).sort()).toEqual(["cancelled", "failed"]);
    const roundTripped: QueueItem<Input>[] = JSON.parse(JSON.stringify(slice));
    expect(roundTripped).toEqual(slice);
  });
});
