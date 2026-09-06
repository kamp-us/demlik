import * as fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import {
  cacheEvictionSub,
  cacheEvictionSubscribe,
  cacheEvictMsg,
  evictExpired,
  get,
  has,
  initCache,
  remove,
  set,
  type TtlCache,
} from "./index";

describe("get / set / has", () => {
  it("round-trips a value set within its TTL", () => {
    const c = set(initCache<number>(), "k", 42, 0, 1000);
    expect(get(c, "k", 0)).toBe(42);
    expect(get(c, "k", 999)).toBe(42);
    expect(has(c, "k", 999)).toBe(true);
  });

  it("get / has return absent for an unknown key", () => {
    const c = initCache<string>();
    expect(get(c, "missing", 0)).toBeUndefined();
    expect(has(c, "missing", 0)).toBe(false);
  });

  it("re-set overwrites value and restarts the TTL clock", () => {
    let c = set(initCache<string>(), "k", "old", 0, 1000);
    c = set(c, "k", "new", 500, 1000); // expiresAtMs now 1500, not 1000
    expect(get(c, "k", 500)).toBe("new");
    expect(get(c, "k", 1000)).toBe("new"); // would have expired under the first set
    expect(get(c, "k", 1500)).toBeUndefined();
  });

  it("different keys carry independent per-entry TTLs", () => {
    let c = set(initCache<string>(), "hot", "h", 0, 100);
    c = set(c, "cold", "c", 0, 10_000);
    // At t=100 the hot entry is gone (half-open), the cold one survives.
    expect(get(c, "hot", 100)).toBeUndefined();
    expect(get(c, "cold", 100)).toBe("c");
  });
});

describe("expiry (half-open: nowMs >= expiresAtMs is expired)", () => {
  it("misses at exactly expiresAtMs", () => {
    const c = set(initCache<string>(), "k", "v", 0, 1000);
    expect(get(c, "k", 999)).toBe("v");
    expect(has(c, "k", 999)).toBe(true);
    // Exactly the expiry instant — gone.
    expect(get(c, "k", 1000)).toBeUndefined();
    expect(has(c, "k", 1000)).toBe(false);
    expect(get(c, "k", 1001)).toBeUndefined();
  });
});

describe("evictExpired", () => {
  it("drops only the expired entries", () => {
    let c = set(initCache<string>(), "a", "1", 0, 100); // expiresAtMs 100
    c = set(c, "b", "2", 0, 1000); // expiresAtMs 1000
    // At t=100, "a" is expired (half-open), "b" survives.
    const evicted = evictExpired(c, 100);
    expect(Object.keys(evicted.entries).sort()).toEqual(["b"]);
    expect(get(evicted, "b", 100)).toBe("2");
  });

  it("drops nothing when no entry is expired", () => {
    let c = set(initCache<string>(), "a", "1", 0, 1000);
    c = set(c, "b", "2", 0, 1000);
    const evicted = evictExpired(c, 500);
    expect(Object.keys(evicted.entries).sort()).toEqual(["a", "b"]);
  });
});

describe("remove", () => {
  it("drops a key regardless of expiry", () => {
    const c = set(initCache<string>(), "k", "v", 0, 1000);
    const removed = remove(c, "k");
    expect(get(removed, "k", 0)).toBeUndefined();
    expect(has(removed, "k", 0)).toBe(false);
  });

  it("removing an absent key returns an equivalent cache", () => {
    const c = set(initCache<string>(), "k", "v", 0, 1000);
    const removed = remove(c, "missing");
    expect(removed.entries).toEqual(c.entries);
  });
});

describe("immutability (no input mutation)", () => {
  it("set never mutates the input cache", () => {
    const c0 = initCache<string>();
    const before: TtlCache<string> = { entries: { ...c0.entries } };
    set(c0, "k", "v", 0, 1000);
    expect(c0).toEqual(before);
  });

  it("remove never mutates the input cache", () => {
    const c0 = set(initCache<string>(), "k", "v", 0, 1000);
    const before: TtlCache<string> = { entries: { ...c0.entries } };
    remove(c0, "k");
    expect(c0).toEqual(before);
  });

  it("evictExpired never mutates the input cache", () => {
    let c = set(initCache<string>(), "a", "1", 0, 100);
    c = set(c, "b", "2", 0, 1000);
    const before: TtlCache<string> = { entries: { ...c.entries } };
    evictExpired(c, 100);
    expect(c).toEqual(before);
  });
});

describe("cacheEvictMsg", () => {
  it("tags the msg with the cache id", () => {
    expect(cacheEvictMsg("session")).toEqual({
      type: "cache_evict",
      id: "session",
    });
  });
});

describe("eviction Sub", () => {
  it("dispatches cache_evict periodically while subscribed", () => {
    vi.useFakeTimers();
    try {
      const dispatch = vi.fn();
      const sub = cacheEvictionSub("session", 1000);
      const cleanup = cacheEvictionSubscribe(sub, undefined, dispatch);

      vi.advanceTimersByTime(999);
      expect(dispatch).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1); // hits 1000 — first tick
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenLastCalledWith({
        type: "cache_evict",
        id: "session",
      });

      vi.advanceTimersByTime(2000); // two more ticks
      expect(dispatch).toHaveBeenCalledTimes(3);

      cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleanup stops the interval — no further dispatches", () => {
    vi.useFakeTimers();
    try {
      const dispatch = vi.fn();
      const cleanup = cacheEvictionSubscribe(
        cacheEvictionSub("c", 1000),
        undefined,
        dispatch,
      );

      vi.advanceTimersByTime(1000);
      expect(dispatch).toHaveBeenCalledTimes(1);

      cleanup();
      vi.advanceTimersByTime(5000); // would be 5 more ticks if still armed
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries a stable id and type for reconcile-by-id (no churn)", () => {
    const a = cacheEvictionSub("session", 1000);
    const b = cacheEvictionSub("session", 1000);
    // Same id + type across calls — the reconcile pass leaves it running.
    expect(a.id).toBe(b.id);
    expect(a.type).toBe("cache");
    expect(a.intervalMs).toBe(1000);
  });
});

describe("property: get after set within TTL always returns the set value", () => {
  it("for any key, value, nowMs, ttlMs>0 and any read at [nowMs, nowMs+ttlMs)", () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.integer(),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        // A read offset strictly inside [0, ttlMs): readAt = nowMs + offset,
        // offset < ttlMs guarantees the entry is unexpired at readAt.
        fc.double({ min: 0, max: 0.999_999, noNaN: true }),
        (key, value, nowMs, ttlMs, offsetFrac) => {
          const c = set(initCache<number>(), key, value, nowMs, ttlMs);
          const readAt = nowMs + Math.floor(offsetFrac * ttlMs);
          expect(get(c, key, readAt)).toBe(value);
          expect(has(c, key, readAt)).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });
});
