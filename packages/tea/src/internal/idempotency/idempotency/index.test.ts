import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  evictExpired,
  type IdempotencyStore,
  initStore,
  recall,
  remember,
  seen,
} from "./index";

describe("seen / recall", () => {
  it("seen is false before remember, true after", () => {
    const s0 = initStore<string>();
    expect(seen(s0, "k", 0)).toBe(false);
    const s1 = remember(s0, "k", "v", 0);
    expect(seen(s1, "k", 0)).toBe(true);
  });

  it("recall round-trips the remembered value", () => {
    const s = remember(initStore<{ n: number }>(), "k", { n: 42 }, 0);
    expect(recall(s, "k", 0)).toEqual({ n: 42 });
  });

  it("recall returns undefined for an unknown key", () => {
    expect(recall(initStore<string>(), "missing", 0)).toBeUndefined();
  });
});

describe("ttl expiry", () => {
  it("seen flips false once ttlMs elapses", () => {
    const s = remember(initStore<string>({ ttlMs: 1000 }), "k", "v", 0);
    // Inside the window — still seen.
    expect(seen(s, "k", 999)).toBe(true);
    expect(recall(s, "k", 999)).toBe("v");
    // Exactly ttlMs old — half-open cutoff expires it.
    expect(seen(s, "k", 1000)).toBe(false);
    expect(recall(s, "k", 1000)).toBeUndefined();
  });

  it("evictExpired physically drops aged entries and rebuilds order", () => {
    let s = initStore<string>({ ttlMs: 1000 });
    s = remember(s, "a", "1", 0);
    s = remember(s, "b", "2", 500);
    // At t=1000, "a" (age 1000) is expired, "b" (age 500) survives.
    const evicted = evictExpired(s, 1000);
    expect(Object.keys(evicted.entries)).toEqual(["b"]);
    expect(evicted.order).toEqual(["b"]);
  });

  it("a backwards clock never expires an entry", () => {
    const s = remember(initStore<string>({ ttlMs: 1000 }), "k", "v", 5000);
    // nowMs before atMs → negative age → never expired.
    expect(seen(s, "k", 4000)).toBe(true);
  });

  it("no-ttl store never expires by age", () => {
    const s = remember(initStore<string>(), "k", "v", 0);
    expect(seen(s, "k", Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(evictExpired(s, Number.MAX_SAFE_INTEGER)).toBe(s);
  });
});

describe("capacity eviction", () => {
  it("drops the oldest entry beyond capacity", () => {
    let s = initStore<string>({ capacity: 2 });
    s = remember(s, "a", "1", 0);
    s = remember(s, "b", "2", 1);
    s = remember(s, "c", "3", 2); // pushes "a" out
    expect(seen(s, "a", 2)).toBe(false);
    expect(seen(s, "b", 2)).toBe(true);
    expect(seen(s, "c", 2)).toBe(true);
    expect(s.order).toEqual(["b", "c"]);
  });

  it("expiry eviction frees slots before capacity eviction runs", () => {
    let s = initStore<string>({ capacity: 2, ttlMs: 1000 });
    s = remember(s, "a", "1", 0); // expires at 1000
    s = remember(s, "b", "2", 0); // expires at 1000
    // At t=1000 both are expired; remembering "c" prunes them first, so "c" is
    // the lone survivor rather than evicting a live entry.
    s = remember(s, "c", "3", 1000);
    expect(Object.keys(s.entries)).toEqual(["c"]);
    expect(s.order).toEqual(["c"]);
  });
});

describe("overwrite semantics", () => {
  it("re-remembering updates value, refreshes atMs, moves to newest", () => {
    let s = initStore<string>({ capacity: 3, ttlMs: 1000 });
    s = remember(s, "a", "1", 0);
    s = remember(s, "b", "2", 10);
    // Re-remember "a" at a later time with a new value.
    s = remember(s, "a", "1-updated", 20);
    // Value overwritten.
    expect(recall(s, "a", 20)).toBe("1-updated");
    // atMs refreshed — "a" survives past its original t=0+1000 expiry.
    expect(seen(s, "a", 1000)).toBe(true);
    // Moved to newest in order (was oldest, now last).
    expect(s.order).toEqual(["b", "a"]);
  });

  it("a re-remembered key is not the capacity-eviction victim", () => {
    let s = initStore<string>({ capacity: 2 });
    s = remember(s, "a", "1", 0);
    s = remember(s, "b", "2", 1);
    // Touch "a" so it becomes newest; now "b" is the oldest.
    s = remember(s, "a", "1", 2);
    // Insert "c" → capacity 2 exceeded → oldest ("b") evicted, "a" kept.
    s = remember(s, "c", "3", 3);
    expect(seen(s, "a", 3)).toBe(true);
    expect(seen(s, "b", 3)).toBe(false);
    expect(seen(s, "c", 3)).toBe(true);
  });
});

describe("immutability", () => {
  it("remember never mutates the input store", () => {
    const s0 = initStore<string>({ capacity: 2 });
    const before: IdempotencyStore<string> = {
      entries: { ...s0.entries },
      order: [...s0.order],
      capacity: s0.capacity,
      ttlMs: s0.ttlMs,
    };
    remember(s0, "k", "v", 0);
    expect(s0).toEqual(before);
  });

  it("evictExpired never mutates the input store", () => {
    let s = initStore<string>({ ttlMs: 1000 });
    s = remember(s, "a", "1", 0);
    s = remember(s, "b", "2", 0);
    const snapshot = {
      entries: { ...s.entries },
      order: [...s.order],
      capacity: s.capacity,
      ttlMs: s.ttlMs,
    };
    evictExpired(s, 5000);
    expect(s).toEqual(snapshot);
  });
});

describe("property: capacity is an upper bound on entry count", () => {
  it("for any sequence of remembers, Object.keys(entries).length <= capacity", () => {
    fc.assert(
      fc.property(
        // capacity C and a sequence of (key, deltaMs) remembers. Keys are drawn
        // from a small alphabet so overwrites happen; deltas are non-negative
        // so absolute timestamps are non-decreasing.
        fc.integer({ min: 1, max: 20 }),
        fc.array(
          fc.record({
            key: fc.constantFrom(
              "a",
              "b",
              "c",
              "d",
              "e",
              "f",
              "g",
              "h",
              "i",
              "j",
              "k",
              "l",
            ),
            deltaMs: fc.integer({ min: 0, max: 5000 }),
          }),
          { maxLength: 100 },
        ),
        // Optional TTL so expiry-then-capacity interleaving is exercised too.
        fc.option(fc.integer({ min: 1, max: 10_000 }), { nil: undefined }),
        (capacity, calls, ttlMs) => {
          let store = initStore<number>({ capacity, ttlMs });
          let nowMs = 0;
          let i = 0;
          for (const { key, deltaMs } of calls) {
            nowMs += deltaMs; // non-decreasing
            store = remember(store, key, i++, nowMs);
            // The core invariant: never more than `capacity` live entries, and
            // the order ledger stays in lockstep with the entries map.
            expect(Object.keys(store.entries).length).toBeLessThanOrEqual(
              capacity,
            );
            expect(store.order.length).toBe(Object.keys(store.entries).length);
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});
