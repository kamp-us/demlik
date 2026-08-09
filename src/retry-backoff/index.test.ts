import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type AnyRetryPolicy,
  asRng,
  backoffDelay,
  type DurationRetryPolicy,
  defaultRetryPolicy,
  initRetry,
  nextDelayMs,
  type RetryPolicy,
  type RetryState,
  recordFailure,
  retryElapsedMs,
  shouldRetry,
  type TimedRetryState,
  type UnboundedRetryPolicy,
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

// ---------------------------------------------------------------------------
// Duration bounding — the bound is wall-clock outage, not attempt count.
// ---------------------------------------------------------------------------

// The ladder the production incident ran on: 250ms first rung, 4s ceiling.
const ladder = {
  baseMs: 250,
  factor: 2,
  capMs: 4_000,
  jitter: "none",
} as const;

/**
 * The old bound. The incident's "4 restarts" is tea's `maxAttempts: 5` — the
 * first call plus four retries (the same off-by-one the cockatiel vectors
 * normalize) — and those four backoffs are 250+500+1000+2000 = 3.75s of
 * patience, against a peer that waits 17.5 minutes.
 */
const countBounded: RetryPolicy = { ...ladder, maxAttempts: 5 };

/** The bound that shipped: the peer's own give-up window, 17.5 minutes. */
const durationBounded: DurationRetryPolicy = {
  ...ladder,
  maxElapsedMs: 1_050_000,
};

/** Walk a streak of failures landing at the given instants. */
function streakThrough(atMs: readonly number[]): TimedRetryState {
  let state = recordFailure(initRetry(), "boom", atMs[0] as number);
  for (const at of atMs.slice(1)) state = recordFailure(state, "boom", at);
  return state;
}

describe("recordFailure with an observation instant", () => {
  it("starts the streak clock on the first failure and never moves it after", () => {
    const first = recordFailure(initRetry(), "e", 1_000);
    expect(first).toEqual({
      attempt: 1,
      lastError: "e",
      firstFailureAtMs: 1_000,
    });

    const second = recordFailure(first, "e", 9_000);
    expect(second.attempt).toBe(2);
    expect(second.firstFailureAtMs).toBe(1_000); // origin, not the latest failure
  });

  it("carries the origin forward even when a later failure omits the instant", () => {
    const timed = recordFailure(initRetry(), "e", 1_000);
    expect(recordFailure(timed, "e").firstFailureAtMs).toBe(1_000);
  });

  it("adds no streak field at all when no instant is supplied (count-only path)", () => {
    expect(recordFailure(initRetry(), "e")).toEqual({
      attempt: 1,
      lastError: "e",
    });
  });

  it("a success resets the streak: initRetry() drops the origin with it", () => {
    // The reset rule is unchanged — a successful attempt returns to initRetry(),
    // so an operation that fails occasionally never accumulates outage.
    const afterSuccess = initRetry();
    expect("firstFailureAtMs" in afterSuccess).toBe(false);
  });
});

describe("retryElapsedMs", () => {
  it("measures the streak from its first failure", () => {
    expect(retryElapsedMs(streakThrough([1_000, 5_000]), 9_000)).toBe(8_000);
  });

  it("clamps a backwards clock to 0 rather than reporting a negative outage", () => {
    expect(retryElapsedMs(streakThrough([1_000]), 500)).toBe(0);
  });
});

describe("shouldRetry under a duration bound", () => {
  it("retries the first failure of a streak — a zero-length outage", () => {
    const s = streakThrough([1_000]);
    expect(shouldRetry(s, durationBounded, 1_000)).toBe(true);
  });

  it("flips to false exactly when the elapsed outage reaches maxElapsedMs", () => {
    const policy: DurationRetryPolicy = { ...ladder, maxElapsedMs: 10_000 };
    const s = streakThrough([1_000]);
    expect(shouldRetry(s, policy, 10_999)).toBe(true); //  9_999ms elapsed
    expect(shouldRetry(s, policy, 11_000)).toBe(false); // 10_000ms elapsed
    expect(shouldRetry(s, policy, 60_000)).toBe(false);
  });

  it("maxElapsedMs: 0 is the no-patience setting — the first failure is terminal", () => {
    const s = streakThrough([1_000]);
    expect(shouldRetry(s, { ...ladder, maxElapsedMs: 0 }, 1_000)).toBe(false);
  });

  it("does not consult the attempt count when only a duration is declared", () => {
    // 200 failures, all inside the budget: the count is diagnostics here, and
    // the backoff ladder's rung index — never a terminal bound.
    const s = { attempt: 200, firstFailureAtMs: 1_000 };
    expect(shouldRetry(s, durationBounded, 60_000)).toBe(true);
  });
});

describe("shouldRetry when both bounds are declared", () => {
  const both: DurationRetryPolicy = {
    ...ladder,
    maxElapsedMs: 10_000,
    maxAttempts: 3,
  };

  it("permits a retry only while EVERY declared bound still permits it", () => {
    // Inside both.
    expect(shouldRetry({ attempt: 2, firstFailureAtMs: 0 }, both, 5_000)).toBe(
      true,
    );
    // Count exhausted, duration fine.
    expect(shouldRetry({ attempt: 3, firstFailureAtMs: 0 }, both, 5_000)).toBe(
      false,
    );
    // Duration exhausted, count fine.
    expect(shouldRetry({ attempt: 1, firstFailureAtMs: 0 }, both, 10_000)).toBe(
      false,
    );
    // Both exhausted.
    expect(shouldRetry({ attempt: 9, firstFailureAtMs: 0 }, both, 99_000)).toBe(
      false,
    );
  });
});

describe("shouldRetry under an explicit unbounded policy", () => {
  it("always permits another attempt", () => {
    const forever: UnboundedRetryPolicy = { ...ladder, unbounded: true };
    expect(shouldRetry(initRetry(), forever)).toBe(true);
    expect(shouldRetry({ attempt: 10_000 }, forever)).toBe(true);
  });
});

describe("the wrong policy is a type error, not a runtime surprise", () => {
  it("rejects a policy that declares no bound at all", () => {
    // @ts-expect-error — no arm of RetryBudget matches "neither bound":
    // forever-retry must be spelled `unbounded: true`.
    const unbouned: AnyRetryPolicy = { ...ladder };
    expect(unbouned).toBeDefined();
  });

  it("rejects a duration-bounded policy evaluated without a clock", () => {
    const s = streakThrough([1_000]);
    // @ts-expect-error — a policy carrying `maxElapsedMs` only matches the
    // overload that demands `nowMs`; a silently-never-firing bound cannot compile.
    // Forced through anyway (a JS caller, an `as` cast), it fails CLOSED: an
    // unmeasurable outage refuses the retry rather than retrying forever.
    expect(shouldRetry(s, durationBounded)).toBe(false);
  });

  it("rejects a duration-bounded policy evaluated against an un-timed state", () => {
    const untimed: RetryState = recordFailure(initRetry(), "e");
    // @ts-expect-error — no `firstFailureAtMs`, so there is no origin to measure
    // the outage from; `recordFailure(state, error, atMs)` is the only way in.
    expect(shouldRetry(untimed, durationBounded, 2_000)).toBe(false);
  });
});

describe("the production scenario: a nested ladder outrunning a count bound", () => {
  // The incident, replayed. A deploy restarts the far side; every attempt fails
  // for TEN MINUTES, then it comes back. The peer waits ~17.5 minutes before it
  // gives up on us, so the correct behaviour is to still be retrying at minute
  // ten and to resume from the checkpoint when the far side returns.
  //
  // Failures land on the saturated ladder cadence: the first four rungs
  // (250/500/1000/2000ms) then a 4s ceiling, i.e. the 4-attempt count bound is
  // spent 3.75 SECONDS into a 600-second outage.
  const failureInstants: number[] = [];
  let t = 0;
  for (let n = 1; failureInstants.length === 0 || t < 600_000; n++) {
    failureInstants.push(t);
    t += Math.min(250 * 2 ** (n - 1), 4_000);
  }

  it("a count bound gives up 3.75s into a 10-minute outage", () => {
    let state = initRetry();
    let gaveUpAfter: number | null = null;
    for (const at of failureInstants) {
      state = recordFailure(state, "hands unreachable", at);
      if (!shouldRetry(state, countBounded)) {
        gaveUpAfter = at;
        break;
      }
    }
    expect(state.attempt).toBe(countBounded.maxAttempts); // 4 failures, then done
    expect(gaveUpAfter).toBe(3_750); // ~3.75s of patience — the whole defect
  });

  it("the duration bound keeps retrying for the full outage and recovers", () => {
    let state: TimedRetryState | RetryState = initRetry();
    let attempts = 0;
    for (const at of failureInstants) {
      state = recordFailure(state, "hands unreachable", at);
      attempts++;
      // Still inside the peer's own 17.5-minute window ⇒ still retrying.
      expect(shouldRetry(state as TimedRetryState, durationBounded, at)).toBe(
        true,
      );
    }
    // Many more attempts than any count bound would have tolerated, and the
    // outage measured in the honest unit.
    expect(attempts).toBeGreaterThan(140);
    expect(retryElapsedMs(state as TimedRetryState, 600_000)).toBe(600_000);

    // The far side comes back at minute ten: success resets the streak, so the
    // next outage starts from a clean budget rather than a spent one.
    const afterSuccess = initRetry();
    expect(afterSuccess.attempt).toBe(0);
  });

  it("still gives up — the bound is wide, never absent", () => {
    const s = streakThrough([0]);
    expect(shouldRetry(s, durationBounded, 1_050_000)).toBe(false);
  });
});

describe("defaultRetryPolicy", () => {
  it("is a coherent full-jitter policy", () => {
    expect(defaultRetryPolicy.jitter).toBe("full");
    expect(defaultRetryPolicy.baseMs).toBeLessThan(defaultRetryPolicy.capMs);
    expect(defaultRetryPolicy.maxAttempts).toBeGreaterThan(0);
  });
});
