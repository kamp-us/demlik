import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  asRng,
  backoffDelay,
  defaultRetryPolicy,
  initRetry,
  nextDelayMs,
  type RetryPolicy,
  type RetryState,
  recordFailure,
  shouldRetry,
} from "./index";

// A fixed, jitter-free policy: makes the bare exponential observable so the
// growth and cap assertions test the curve, not the randomness.
const noJitter: RetryPolicy = {
  baseMs: 100,
  factor: 2,
  capMs: 10_000,
  maxAttempts: 4,
  jitter: "none",
};

// Deterministic RNGs pinning the jitter to each extreme of [0, 1).
const rngZero = asRng(() => 0);
const rngNearOne = asRng(() => 0.9999999);

describe("backoffDelay", () => {
  it("grows exponentially by `factor` per attempt (no jitter)", () => {
    expect(backoffDelay(0, noJitter)).toBe(100); // base
    expect(backoffDelay(1, noJitter)).toBe(200); // base * 2
    expect(backoffDelay(2, noJitter)).toBe(400); // base * 4
    expect(backoffDelay(3, noJitter)).toBe(800); // base * 8
  });

  it("respects the cap once the exponential would exceed it", () => {
    // 100 * 2**7 = 12_800 > capMs (10_000) → clamped.
    expect(backoffDelay(7, noJitter)).toBe(10_000);
    // Even an attempt large enough to overflow to Infinity stays at the cap.
    expect(backoffDelay(1024, noJitter)).toBe(10_000);
  });

  it("clamps negative attempts to 0", () => {
    expect(backoffDelay(-5, noJitter)).toBe(backoffDelay(0, noJitter));
  });

  it("full jitter stays within [0, d]: rng=0 yields 0, rng→1 approaches d", () => {
    const policy: RetryPolicy = { ...noJitter, jitter: "full" };
    const d = backoffDelay(2, noJitter); // 400, the undithered ceiling
    expect(backoffDelay(2, policy, rngZero)).toBe(0);
    const high = backoffDelay(2, policy, rngNearOne);
    expect(high).toBeGreaterThan(0);
    expect(high).toBeLessThanOrEqual(d);
  });

  it("equal jitter stays within [d/2, d]: rng=0 yields d/2, rng→1 approaches d", () => {
    const policy: RetryPolicy = { ...noJitter, jitter: "equal" };
    const d = backoffDelay(2, noJitter); // 400
    expect(backoffDelay(2, policy, rngZero)).toBe(d / 2); // floor at exactly d/2
    const high = backoffDelay(2, policy, rngNearOne);
    expect(high).toBeGreaterThan(d / 2);
    expect(high).toBeLessThanOrEqual(d);
  });
});

describe("RetryState transitions", () => {
  it("initRetry starts at attempt 0 with no error", () => {
    expect(initRetry()).toEqual({ attempt: 0 });
  });

  it("recordFailure increments attempt and sets lastError without mutating input", () => {
    const before = initRetry();
    const frozen = Object.freeze({ ...before });
    const after = recordFailure(frozen, new Error("boom"));

    expect(after.attempt).toBe(1);
    expect((after.lastError as Error).message).toBe("boom");
    // Input untouched: same attempt, still no error, different reference.
    expect(frozen.attempt).toBe(0);
    expect(frozen.lastError).toBeUndefined();
    expect(after).not.toBe(frozen);
  });

  it("shouldRetry flips to false exactly at maxAttempts", () => {
    const policy: RetryPolicy = { ...noJitter, maxAttempts: 3 };
    // attempts 0,1,2 are allowed; the 3rd recorded failure refuses.
    expect(shouldRetry({ attempt: 0 }, policy)).toBe(true);
    expect(shouldRetry({ attempt: 2 }, policy)).toBe(true);
    expect(shouldRetry({ attempt: 3 }, policy)).toBe(false);
    expect(shouldRetry({ attempt: 4 }, policy)).toBe(false);
  });

  it("nextDelayMs grows as failures accumulate (drives attempt index)", () => {
    let state: RetryState = initRetry();
    expect(nextDelayMs(state, noJitter)).toBe(100); // attempt 0
    state = recordFailure(state, "e");
    expect(nextDelayMs(state, noJitter)).toBe(200); // attempt 1
    state = recordFailure(state, "e");
    expect(nextDelayMs(state, noJitter)).toBe(400); // attempt 2
  });
});

describe("backoffDelay property: 0 <= delay <= capMs for any attempt and policy", () => {
  it("holds across arbitrary attempts, policies, jitter strategies, and rng", () => {
    const policyArb = fc.record({
      baseMs: fc.double({ min: 0, max: 1_000_000, noNaN: true }),
      factor: fc.double({ min: 1, max: 10, noNaN: true }),
      capMs: fc.double({ min: 0, max: 1_000_000, noNaN: true }),
      maxAttempts: fc.integer({ min: 0, max: 100 }),
      jitter: fc.constantFrom<RetryPolicy["jitter"]>("none", "full", "equal"),
    });

    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000 }),
        policyArb,
        // rng is contractually in [0, 1); max:0.9999999 stays below 1.
        fc.double({ min: 0, max: 0.9999999, noNaN: true }),
        (attempt, policy, r) => {
          const delay = backoffDelay(
            attempt,
            policy,
            asRng(() => r),
          );
          return delay >= 0 && delay <= policy.capMs;
        },
      ),
      {
        // Regression: the two FP edge cases this property originally caught.
        // 1) subnormal d where equal-jitter rounds one ULP above capMs.
        // 2) baseMs 0 with an overflowing exponent -> 0 * Infinity === NaN.
        examples: [
          [
            0,
            {
              baseMs: 5.4e-323,
              factor: 1,
              capMs: 5.4e-323,
              maxAttempts: 0,
              jitter: "equal",
            },
            0.9166666666666667,
          ],
          [
            309,
            {
              baseMs: 0,
              factor: 9.944617333766892,
              capMs: 0,
              maxAttempts: 0,
              jitter: "none",
            },
            0,
          ],
        ],
      },
    );
  });
});

describe("defaultRetryPolicy", () => {
  it("is a coherent full-jitter policy", () => {
    expect(defaultRetryPolicy.jitter).toBe("full");
    expect(defaultRetryPolicy.baseMs).toBeLessThan(defaultRetryPolicy.capMs);
    expect(defaultRetryPolicy.maxAttempts).toBeGreaterThan(0);
  });
});
