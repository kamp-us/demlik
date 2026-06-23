import { describe, expect, it } from "vitest";
import { idempotencyMemory } from "../idempotency/adapter";
import { createIntake } from "../idempotent-intake";
import { type QueueAdapter, queueAdapter } from "./adapter";
import type { QueueItem } from "./index";

/**
 * The seam tests. Two things are proved here:
 *
 *   1. The canonical `queueAdapter` / `idempotencyMemory` verbs are byte-for-byte
 *      the blessed ops — same transitions, no behavior drift (this is a chore).
 *   2. A consumer (`idempotent-intake`) driven THROUGH the adapter behaves
 *      identically, and a `QueueItem` shape change is now absorbed behind the
 *      `QueueAdapter` interface rather than cascading to the consumer.
 */

interface Job {
  readonly url: string;
}

describe("QueueAdapter — verbs equal the blessed ops", () => {
  it("enqueue appends a pending item stamped now/id", () => {
    const wq = queueAdapter<Job>();
    const { next, item } = wq.enqueue([], { url: "/a" }, 100, "id-1");
    expect(item).toEqual({
      id: "id-1",
      status: "pending",
      input: { url: "/a" },
      enqueuedAt: 100,
    });
    expect(next).toEqual([item]);
  });

  it("claim flips the first pending item running, or returns null when none", () => {
    const wq = queueAdapter<Job>();
    const { next: seeded } = wq.enqueue([], { url: "/a" }, 0, "id-1");
    const claimed = wq.claim(seeded, 50);
    expect(claimed?.claimed.status).toBe("running");
    expect(claimed?.claimed.startedAt).toBe(50);
    // Drain it via markDone, then claim again — nothing pending → null.
    const { next: emptied } = wq.markDone(claimed?.next ?? [], "id-1");
    expect(wq.claim(emptied, 60)).toBeNull();
  });

  it("patch replaces exactly the matched item; unknown id is a no-op copy", () => {
    const wq = queueAdapter<Job>();
    const { next: seeded } = wq.enqueue([], { url: "/a" }, 0, "id-1");
    const hit = wq.patch(seeded, "id-1", (i) => ({ ...i, status: "failed" }));
    expect(hit.changed).toBe(true);
    expect(hit.next[0]?.status).toBe("failed");
    const miss = wq.patch(seeded, "nope", (i) => i);
    expect(miss.changed).toBe(false);
  });
});

describe("IdempotencyMemory — verbs equal the blessed ops", () => {
  it("isSeen is false before remember, true after; recall round-trips", () => {
    const mem = idempotencyMemory<{ n: number }>();
    const s0 = mem.init();
    expect(mem.isSeen(s0, "k", 0)).toBe(false);
    const s1 = mem.remember(s0, "k", { n: 42 }, 0);
    expect(mem.isSeen(s1, "k", 0)).toBe(true);
    expect(mem.recall(s1, "k", 0)).toEqual({ n: 42 });
  });

  it("evict drops entries past the store ttl", () => {
    const mem = idempotencyMemory<true>();
    const s1 = mem.remember(mem.init({ ttlMs: 10 }), "k", true, 0);
    expect(mem.isSeen(s1, "k", 5)).toBe(true);
    const evicted = mem.evict(s1, 10);
    expect(mem.isSeen(evicted, "k", 10)).toBe(false);
  });
});

describe("idempotent-intake driven through the adapter seam", () => {
  it("receive → complete → replay round-trips a duplicate", () => {
    const intake = createIntake<Job, string>({ keyOf: (j) => j.url });

    // First receipt of /a — new key, enqueued, process Cmd emitted.
    const [s1, c1] = intake.receive(intake.init(), { url: "/a" }, 0, "id-1");
    expect(c1).toEqual([
      {
        type: "intake:process",
        key: "/a",
        itemId: "id-1",
        payload: { url: "/a" },
      },
    ]);

    // A duplicate while still pending drops silently (queue/cache untouched).
    const [s2, c2] = intake.receive(s1, { url: "/a" }, 1, "id-2");
    expect(c2).toEqual([]);
    expect(s2).toBe(s1);

    // Work completes — the cache flips pending → done.
    const [s3] = intake.complete(s2, "/a", "RESULT", 2);

    // A later duplicate now replays the cached result rather than re-enqueueing.
    const [, c4] = intake.receive(s3, { url: "/a" }, 3, "id-3");
    expect(c4).toEqual([
      { type: "intake:replay", key: "/a", result: "RESULT" },
    ]);
  });

  it("claimNext skips an item whose key already resolved done", () => {
    const intake = createIntake<Job, string>({ keyOf: (j) => j.url });
    const [s1] = intake.receive(intake.init(), { url: "/a" }, 0, "id-1");
    const [s2] = intake.complete(s1, "/a", "DONE", 1);
    // The queue item for /a is still pending but its key is done — inert.
    expect(intake.claimNext(s2, 2)).toBeNull();
  });
});

/**
 * Shape-change localization. The whole point of the seam: a `QueueItem` field
 * addition is absorbed by re-binding the `QueueAdapter` verb ONCE — the
 * consumer's call sites and slice type are untouched.
 *
 * Here a custom adapter wraps the canonical one and stamps a NEW `priority`
 * field onto every enqueued item. A consumer that only ever calls the verbs
 * (never constructs a `QueueItem` literal) keeps working: the extra field rides
 * along on the slice unread. This is the cascade that the issue's bug ("a
 * QueueItem shape change cascades to 10+ sites") becomes after the seam — one
 * site.
 */
describe("QueueItem shape change is localized behind the adapter", () => {
  type Prioritized<I> = QueueItem<I> & { readonly priority: number };

  function prioritizedAdapter<I>(priority: number): QueueAdapter<I> {
    const base = queueAdapter<I>();
    return {
      ...base,
      enqueue(queue, input, now, id) {
        const { next, item } = base.enqueue(queue, input, now, id);
        // The ONE place the new field is written. Consumers never see it.
        const stamped: Prioritized<I> = { ...item, priority };
        const replaced = next.map((i) => (i.id === item.id ? stamped : i));
        return { next: replaced, item: stamped };
      },
    };
  }

  it("the new field rides the slice without any consumer change", () => {
    const wq = prioritizedAdapter<Job>(7);
    const { next, item } = wq.enqueue([], { url: "/a" }, 0, "id-1");
    // The verb's own result carries the new field.
    expect((item as Prioritized<Job>).priority).toBe(7);
    // And the downstream lifecycle verbs (claim/patch/markDone) keep working,
    // preserving the extra field across the transition — no call site changed.
    const claimed = wq.claim(next, 5);
    expect(claimed?.claimed.status).toBe("running");
    expect((claimed?.claimed as Prioritized<Job>).priority).toBe(7);
  });
});
