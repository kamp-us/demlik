import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import {
  initBucket,
  initWindow,
  record,
  refill,
  remaining,
  type SlidingWindow,
  type TokenBucket,
  tryConsume,
} from "./index";

describe("token bucket", () => {
  it("starts full at capacity", () => {
    const b = initBucket(10, 1, 0);
    expect(b.tokens).toBe(10);
    expect(b.capacity).toBe(10);
    expect(b.lastRefillMs).toBe(0);
  });

  it("drains by n on each consume", () => {
    let [b, ok] = tryConsume(initBucket(3, 0, 0), 0);
    expect(ok).toBe(true);
    expect(b.tokens).toBe(2);

    [b, ok] = tryConsume(b, 0, 2);
    expect(ok).toBe(true);
    expect(b.tokens).toBe(0);
  });

  it("refills over elapsed time at refillPerSec", () => {
    // 5 tokens/sec, drained to 0, then 2s elapse → 10 accrued, clamped lower.
    const drained: TokenBucket = { tokens: 0, capacity: 100, refillPerSec: 5, lastRefillMs: 0 };
    const r = refill(drained, 2000);
    expect(r.tokens).toBe(10);
    expect(r.lastRefillMs).toBe(2000);
  });

  it("never exceeds capacity on refill", () => {
    const drained: TokenBucket = { tokens: 0, capacity: 4, refillPerSec: 100, lastRefillMs: 0 };
    // 1s × 100/sec = 100 accrued, clamped to capacity 4.
    expect(refill(drained, 1000).tokens).toBe(4);
  });

  it("blocks when empty and refill is zero", () => {
    let b = initBucket(2, 0, 0);
    [b] = tryConsume(b, 0);
    [b] = tryConsume(b, 0);
    expect(b.tokens).toBe(0);
    const [next, ok] = tryConsume(b, 0);
    expect(ok).toBe(false);
    expect(next.tokens).toBe(0);
  });

  it("recovers capacity once enough time elapses", () => {
    let b = initBucket(1, 1, 0); // 1 token, 1/sec
    let ok: boolean;
    [b, ok] = tryConsume(b, 0);
    expect(ok).toBe(true);
    // Immediately retry — empty, blocked.
    [b, ok] = tryConsume(b, 0);
    expect(ok).toBe(false);
    // 1s later — one token refilled, allowed.
    [b, ok] = tryConsume(b, 1000);
    expect(ok).toBe(true);
  });

  it("does not refill or remove tokens on a backwards clock", () => {
    const b: TokenBucket = { tokens: 3, capacity: 5, refillPerSec: 10, lastRefillMs: 1000 };
    const r = refill(b, 500);
    expect(r.tokens).toBe(3); // floored elapsed → no change
    expect(r.lastRefillMs).toBe(500); // still tracks latest reading
  });

  it("never mutates the input bucket", () => {
    const b = initBucket(5, 2, 1000);
    const frozen = Object.freeze({ ...b });
    refill(b, 5000);
    tryConsume(b, 5000, 3);
    expect(b).toEqual(frozen);
  });
});

describe("sliding window log", () => {
  it("starts empty", () => {
    const w = initWindow(1000, 3);
    expect(w.hits).toEqual([]);
    expect(remaining(w, 0)).toBe(3);
  });

  it("allows up to limit then blocks", () => {
    let w = initWindow(1000, 3);
    let ok: boolean;
    [w, ok] = record(w, 0);
    expect(ok).toBe(true);
    [w, ok] = record(w, 100);
    expect(ok).toBe(true);
    [w, ok] = record(w, 200);
    expect(ok).toBe(true);
    expect(remaining(w, 200)).toBe(0);
    // 4th hit within the window → blocked, hit not recorded.
    const [blocked, ok4] = record(w, 300);
    expect(ok4).toBe(false);
    expect(blocked.hits).toEqual([0, 100, 200]);
  });

  it("prunes old hits so capacity recovers after windowMs", () => {
    let w = initWindow(1000, 2);
    [w] = record(w, 0);
    [w] = record(w, 0);
    // Full at t=0.
    expect(record(w, 500)[1]).toBe(false);
    // At t=1001 both original hits (t=0) have aged past the 1000ms window.
    const [next, ok] = record(w, 1001);
    expect(ok).toBe(true);
    expect(next.hits).toEqual([1001]);
  });

  it("prunes the hit exactly windowMs old (half-open cutoff)", () => {
    let w = initWindow(1000, 1);
    [w] = record(w, 0);
    // A hit at t=0 must not count at t=1000 (t + windowMs).
    const [next, ok] = record(w, 1000);
    expect(ok).toBe(true);
    expect(next.hits).toEqual([1000]);
  });

  it("remaining reflects live hits without recording", () => {
    let w = initWindow(1000, 3);
    [w] = record(w, 0);
    [w] = record(w, 100);
    expect(remaining(w, 100)).toBe(1);
    // Reading does not consume — still 1 after a repeat read.
    expect(remaining(w, 100)).toBe(1);
    // Old hits aged out → full capacity again.
    expect(remaining(w, 2000)).toBe(3);
  });

  it("never mutates the input window", () => {
    const w: SlidingWindow = { hits: Object.freeze([0, 100]), windowMs: 1000, limit: 5 };
    const snapshot = { hits: [...w.hits], windowMs: w.windowMs, limit: w.limit };
    record(w, 200);
    remaining(w, 200);
    expect(w).toEqual(snapshot);
  });
});

describe("property: tryConsume keeps tokens within [0, capacity]", () => {
  it("for any sequence of consumes at non-decreasing timestamps", () => {
    fc.assert(
      fc.property(
        // capacity, refillPerSec, and a sequence of (deltaMs, n) calls. Deltas
        // are non-negative so the absolute timestamps are non-decreasing.
        fc.integer({ min: 1, max: 1000 }),
        fc.integer({ min: 0, max: 1000 }),
        fc.array(
          fc.record({
            deltaMs: fc.integer({ min: 0, max: 100_000 }),
            n: fc.integer({ min: 1, max: 50 }),
          }),
          { maxLength: 50 },
        ),
        (capacity, refillPerSec, calls) => {
          let bucket = initBucket(capacity, refillPerSec, 0);
          let nowMs = 0;
          for (const { deltaMs, n } of calls) {
            nowMs += deltaMs; // non-decreasing
            const [next] = tryConsume(bucket, nowMs, n);
            // The core invariant: tokens never leave [0, capacity].
            expect(next.tokens).toBeGreaterThanOrEqual(0);
            expect(next.tokens).toBeLessThanOrEqual(capacity);
            bucket = next;
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});
