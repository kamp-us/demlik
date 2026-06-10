import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  backoffDelay,
  initRetry,
  nextDelayMs,
  type RetryPolicy,
  recordFailure,
  shouldRetry,
} from "./index";

/**
 * Cockatiel test-vector port — retry/backoff bricks.
 *
 * These replay cockatiel's battle-tested retry/backoff edge cases (the vectors
 * canon'd into `.patterns/cockatiel/retry-vectors.md`, R1–R8) against tea's pure
 * verbs `initRetry` / `recordFailure` / `shouldRetry` / `nextDelayMs` /
 * `backoffDelay`. Per ADR 0001 consequence #1, this is how the in-house brick
 * inherits cockatiel's proven coverage without installing the dependency.
 *
 * Two documented convention differences are normalized in the harness, NOT
 * asserted against cockatiel's raw numbers (see `.patterns/cockatiel/gaps.md`
 * G-RT2):
 *
 *   1. Attempt cap. cockatiel `maxAttempts: N` ⇒ original call + N retries ⇒
 *      N+1 fn invocations. tea `maxAttempts: N` ⇒ `shouldRetry` allows indices
 *      `0..N-1` ⇒ N invocations total. So a cockatiel callCount of C maps to a
 *      tea policy with `maxAttempts: C`. The harness asserts tea's actual
 *      numbers.
 *   2. onRetry index. cockatiel's `onRetry({ attempt })` is 1-based; tea's
 *      `state.attempt` is a 0-based failure count (1,2,3,… after each
 *      `recordFailure`). The harness maps cockatiel attempt `n` ⇄ tea
 *      `state.attempt === n` after the n-th `recordFailure`.
 *
 * Jitter is pinned by injecting a fixed `rng` (`() => 0`, `() => 0.9999999`) —
 * never `Math.random` — so delays are deterministic and replay-equal. tea has
 * only none/full/equal jitter; cockatiel's DEFAULT is decorrelated, for which
 * only the bounds + no-NaN invariant port (not an exact sequence).
 */

// Deterministic RNGs pinning the jitter to each extreme of [0, 1). Matches the
// style of the sibling `index.test.ts`.
const rngZero = () => 0;
const rngNearOne = () => 0.9999999;

// ---------------------------------------------------------------------------
// R1 — exponential schedule with NO jitter (the canonical delay vector).
// cockatiel: ExponentialBackoff defaults { initialDelay: 128, exponent: 2,
// maxDelay: 30000 } ⇒ expectDurations [128,256,...,16384,30000,30000,30000].
// The k=8 clamp (128*2^8 = 32768 > 30000 → 30000) is the load-bearing edge.
// ---------------------------------------------------------------------------
describe("R1 — exact exponential schedule (no jitter), cap clamp at k=8", () => {
  const policy: RetryPolicy = {
    baseMs: 128,
    factor: 2,
    capMs: 30_000,
    // High enough that the schedule walk is never cut short by the attempt cap;
    // R1 is a pure-delay vector, the cap is exercised by R4.
    maxAttempts: 100,
    jitter: "none",
  };

  it("reproduces cockatiel's canonical [128..16384,30000,30000,30000] for k=0..10", () => {
    const expected = [128, 256, 512, 1024, 2048, 4096, 8192, 16384, 30000, 30000, 30000];
    const actual = expected.map((_, k) => backoffDelay(k, policy));
    expect(actual).toEqual(expected);
  });

  it("clamps exactly at k=8 — k=7 is the last sub-cap value (16384), k=8 is 30000", () => {
    expect(backoffDelay(7, policy)).toBe(16_384); // 128 * 2**7, still under cap
    expect(backoffDelay(8, policy)).toBe(30_000); // 128 * 2**8 = 32768, clamped
    expect(backoffDelay(50, policy)).toBe(30_000); // stays clamped forever
  });
});

// ---------------------------------------------------------------------------
// R2 — jitter bounds (min/max envelope per strategy).
// cockatiel asserts 0 <= delay <= min(maxDelay, initialDelay*2^k) over a
// 100-step × 10-trial sweep. tea has none/full/equal; assert the documented
// per-strategy bound by sweeping rng at its extremes (0 and ~1).
//   - none  → exactly d
//   - full  → [0, d]   (cockatiel floors to [0,d); tea is continuous [0,d])
//   - equal → [d/2, d] (cockatiel halfJitter is [d/2,d); tea is [d/2,d])
// ---------------------------------------------------------------------------
describe("R2 — jitter bounds per strategy (rng swept to extremes)", () => {
  const base: RetryPolicy = {
    baseMs: 128,
    factor: 2,
    capMs: 30_000,
    maxAttempts: 100,
    jitter: "none",
  };

  it("none: delay equals the capped exponential d at both rng extremes", () => {
    for (let k = 0; k < 100; k++) {
      const d = backoffDelay(k, base); // undithered ceiling
      expect(backoffDelay(k, base, rngZero)).toBe(d);
      expect(backoffDelay(k, base, rngNearOne)).toBe(d);
    }
  });

  it("full: 0 <= delay <= d, rng=0 hits the floor 0, rng→1 approaches d", () => {
    const policy: RetryPolicy = { ...base, jitter: "full" };
    for (let k = 0; k < 100; k++) {
      const d = backoffDelay(k, base);
      const lo = backoffDelay(k, policy, rngZero);
      const hi = backoffDelay(k, policy, rngNearOne);
      expect(lo).toBe(0); // full jitter floor
      expect(hi).toBeGreaterThanOrEqual(0);
      expect(hi).toBeLessThanOrEqual(d); // upper bound: the capped exponential
    }
  });

  it("equal: d/2 <= delay <= d, rng=0 hits d/2, rng→1 approaches d", () => {
    const policy: RetryPolicy = { ...base, jitter: "equal" };
    for (let k = 0; k < 100; k++) {
      const d = backoffDelay(k, base);
      const lo = backoffDelay(k, policy, rngZero);
      const hi = backoffDelay(k, policy, rngNearOne);
      expect(lo).toBe(d / 2); // equal jitter floor: exactly half
      expect(hi).toBeGreaterThanOrEqual(d / 2);
      expect(hi).toBeLessThanOrEqual(d); // upper bound: the capped exponential
    }
  });

  // Property form of cockatiel's "${name} is sane" sweep: for ANY rng() in
  // [0,1), every strategy stays within [0, capMs] and never exceeds the
  // per-attempt ceiling d. This is the bounds invariant the decorrelated GAP
  // also reduces to (see R3 + the it.todo below).
  it("property: every strategy stays in [0, d] for arbitrary rng and attempt", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<RetryPolicy["jitter"]>("none", "full", "equal"),
        fc.integer({ min: 0, max: 200 }),
        fc.double({ min: 0, max: 0.9999999, noNaN: true }),
        (jitter, attempt, r) => {
          const policy: RetryPolicy = { ...base, jitter };
          const d = backoffDelay(attempt, base);
          const delay = backoffDelay(attempt, policy, () => r);
          expect(Number.isNaN(delay)).toBe(false);
          expect(delay).toBeGreaterThanOrEqual(0);
          expect(delay).toBeLessThanOrEqual(d);
          expect(delay).toBeLessThanOrEqual(base.capMs);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// R3 — no NaN / no negative at extreme params (cockatiel issue #86).
// cockatiel ran decorrelatedJitterGenerator 3000 steps with maxDelay=15min,
// initialDelay=45s and asserted delay is never NaN, never negative. tea's
// `backoffDelay` has the explicit Number.isNaN guard (baseMs===0 → 0*Infinity)
// and the factor**attempt → Infinity collapse via Math.min(capMs, …). Replay
// the *bounds + no-NaN* invariant (the decorrelated exact sequence is a GAP).
// ---------------------------------------------------------------------------
describe("R3 — no NaN / no negative under extreme params over many steps (#86)", () => {
  const ext: RetryPolicy = {
    baseMs: 45_000,
    factor: 2,
    capMs: 15 * 60_000, // 900_000
    maxAttempts: 1,
    jitter: "none",
  };

  it("never NaN, never negative, never above cap across 3000 steps (all strategies)", () => {
    for (const jitter of ["none", "full", "equal"] as const) {
      const policy: RetryPolicy = { ...ext, jitter };
      for (let k = 1; k < 3000; k++) {
        // sweep both rng extremes so jitter math is exercised at the edges
        for (const rng of [rngZero, rngNearOne]) {
          const delay = backoffDelay(k, policy, rng);
          expect(Number.isNaN(delay)).toBe(false);
          expect(delay).toBeGreaterThanOrEqual(0);
          expect(delay).toBeLessThanOrEqual(ext.capMs);
        }
      }
    }
  });

  // The baseMs===0 corner that motivates tea's explicit NaN guard:
  // 0 * (2 ** 1024) = 0 * Infinity = NaN without the guard. tea collapses it
  // to 0. cockatiel never tested baseMs=0 directly, but it's the same class of
  // bug as #86 (NaN leaking out of the exponential).
  it("baseMs=0 with an overflowing exponent collapses to 0, not NaN", () => {
    const zeroBase: RetryPolicy = { ...ext, baseMs: 0 };
    expect(backoffDelay(1024, zeroBase)).toBe(0);
    expect(Number.isNaN(backoffDelay(1024, zeroBase, rngNearOne))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R4 — attempt cap + give-up.
// cockatiel: maxAttempts:5 with an always-failing fn ⇒ callCount 6
// (original + 5 retries). NORMALIZED: cockatiel callCount C ⇄ tea
// maxAttempts:C. tea folds `recordFailure` while `shouldRetry` is true; it
// flips false at attempt === maxAttempts. Assert tea's real numbers (5 → 5).
// ---------------------------------------------------------------------------
describe("R4 — attempt cap drives give-up (off-by-one normalized to tea)", () => {
  // Fold recordFailure while shouldRetry is true; return how many failures were
  // recorded before give-up. This is tea's analogue of cockatiel's callCount.
  const runToGiveUp = (policy: RetryPolicy) => {
    let state = initRetry();
    let attempts = 0;
    const err = new Error("boom");
    while (shouldRetry(state, policy)) {
      state = recordFailure(state, err);
      attempts++;
    }
    return { state, attempts };
  };

  it("R4a — retries until success within the cap (give-up never reached)", () => {
    // Succeeds on the 3rd attempt under maxAttempts:5: only 2 failures recorded,
    // shouldRetry is still true when we stop. tea convention: 0-based attempt.
    const policy: RetryPolicy = { ...{ baseMs: 1, factor: 2, capMs: 1, maxAttempts: 5, jitter: "none" } };
    let state = initRetry();
    state = recordFailure(state, new Error("fail 1"));
    state = recordFailure(state, new Error("fail 2"));
    expect(state.attempt).toBe(2);
    expect(shouldRetry(state, policy)).toBe(true); // budget remains, success would land here
  });

  it("R4b — give-up after exactly maxAttempts failures (cockatiel callCount 6 ⇄ tea maxAttempts 6)", () => {
    // cockatiel maxAttempts:5 ⇒ 6 invocations. tea maxAttempts:6 ⇒ 6 recorded
    // failures, then shouldRetry flips false. Assert tea's number: 6.
    const policy: RetryPolicy = { baseMs: 100, factor: 2, capMs: 30_000, maxAttempts: 6, jitter: "none" };
    const { state, attempts } = runToGiveUp(policy);
    expect(attempts).toBe(6); // tea's real invocation count
    expect(state.attempt).toBe(6);
    expect(shouldRetry(state, policy)).toBe(false); // flips off at attempt === maxAttempts
  });

  it("R4c — give-up bubbles the last failure (the carried lastError survives)", () => {
    const policy: RetryPolicy = { baseMs: 1, factor: 2, capMs: 1, maxAttempts: 3, jitter: "none" };
    const last = new Error("the last one");
    let state = initRetry();
    state = recordFailure(state, new Error("first"));
    state = recordFailure(state, new Error("second"));
    state = recordFailure(state, last);
    expect(shouldRetry(state, policy)).toBe(false);
    expect(state.lastError).toBe(last); // bubbles the most recent failure on give-up
  });

  it("shouldRetry boundary: true for attempt 0..maxAttempts-1, false at maxAttempts", () => {
    const policy: RetryPolicy = { baseMs: 1, factor: 2, capMs: 1, maxAttempts: 4, jitter: "none" };
    for (let a = 0; a < 4; a++) {
      expect(shouldRetry({ attempt: a }, policy)).toBe(true);
    }
    expect(shouldRetry({ attempt: 4 }, policy)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R5 — explicit backoff sequence drives the delay between retries.
// cockatiel IterableBackoff([10,20,20]) ⇒ onRetry captures delays [10,20,20].
// tea has no IterableBackoff; the portable analogue is: the captured `delays`
// array equals [nextDelayMs(attempt 0), nextDelayMs(attempt 1), …] as the
// state advances. Use R1's exponential schedule as the expected array, driven
// by folding recordFailure and reading nextDelayMs at each step.
// ---------------------------------------------------------------------------
describe("R5 — nextDelayMs reproduces the per-attempt delay sequence", () => {
  const policy: RetryPolicy = {
    baseMs: 128,
    factor: 2,
    capMs: 30_000,
    maxAttempts: 100,
    jitter: "none",
  };

  it("captures [128,256,512,1024] as the state advances through 4 retries", () => {
    const delays: number[] = [];
    let state = initRetry();
    for (let i = 0; i < 4; i++) {
      // The delay is computed from the CURRENT state.attempt (the index of the
      // attempt about to be scheduled), mirroring cockatiel's onRetry capture
      // happening before the next call.
      delays.push(nextDelayMs(state, policy, rngZero));
      state = recordFailure(state, new Error("retry"));
    }
    expect(delays).toEqual([128, 256, 512, 1024]);
  });

  it("captured sequence equals the standalone backoffDelay schedule (R1 cross-check)", () => {
    const delays: number[] = [];
    let state = initRetry();
    for (let i = 0; i < 12; i++) {
      delays.push(nextDelayMs(state, policy, rngZero));
      state = recordFailure(state, new Error("retry"));
    }
    const standalone = delays.map((_, k) => backoffDelay(k, policy, rngZero));
    expect(delays).toEqual(standalone);
    // and it includes the cap clamp tail from R1
    expect(delays.slice(8)).toEqual([30_000, 30_000, 30_000, 30_000]);
  });
});

// ---------------------------------------------------------------------------
// R6 — attempt index surfaced per retry (onRetry counter).
// cockatiel onRetry pushes [1,2,3] — 1-based, one per retry. NORMALIZED:
// cockatiel attempt n ⇄ tea state.attempt === n AFTER the n-th recordFailure.
// So folding recordFailure 3× yields state.attempt 1,2,3 — the SAME numbers,
// because tea's failure count is 1-based once a failure has been recorded.
// ---------------------------------------------------------------------------
describe("R6 — attempt index per retry (cockatiel 1-based onRetry ⇄ tea attempt count)", () => {
  it("state.attempt is 1,2,3 after the 1st,2nd,3rd recordFailure", () => {
    const policy: RetryPolicy = { baseMs: 1, factor: 2, capMs: 1, maxAttempts: 3, jitter: "none" };
    const indices: number[] = [];
    let state = initRetry();
    expect(state.attempt).toBe(0); // initRetry: 0-based, no failures yet
    while (shouldRetry(state, policy)) {
      state = recordFailure(state, new Error("e"));
      indices.push(state.attempt); // capture AFTER recording, matching onRetry timing
    }
    // cockatiel asserts [1,2,3]; tea produces the identical sequence post-fold.
    expect(indices).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// R7 — give-up callback fires with the final failure.
// cockatiel: onGiveUp called with { error: err } carrying the last error. tea
// has no callback — the give-up signal is `shouldRetry === false` and the
// terminal-failure shape is `state.lastError`. Replay: after the final
// recordFailure, lastError === err and shouldRetry === false.
// ---------------------------------------------------------------------------
describe("R7 — terminal give-up carries the final failure (lastError + shouldRetry=false)", () => {
  it("on give-up, lastError is the final error and shouldRetry is false", () => {
    const policy: RetryPolicy = { baseMs: 1, factor: 2, capMs: 1, maxAttempts: 5, jitter: "none" };
    const err = new Error("MyErrorA");
    let state = initRetry();
    while (shouldRetry(state, policy)) {
      state = recordFailure(state, err);
    }
    expect(shouldRetry(state, policy)).toBe(false); // the give-up edge
    expect(state.lastError).toBe(err); // cockatiel's onGiveUp({ error: err }) analogue
    expect(state.attempt).toBe(5); // tea's real terminal attempt count
  });
});

// ---------------------------------------------------------------------------
// GAP VECTORS — flagged, never silently dropped (see .patterns/cockatiel/gaps.md).
// ---------------------------------------------------------------------------
describe("GAPS — cockatiel behaviors with no tea retry-verb counterpart", () => {
  // R8: cockatiel `stops retries if cancellation is requested` — an aborted
  // signal halts the loop after the in-flight attempt. tea's retry reducer has
  // no `signal`; cancellation is an effect-boundary decision (the host stops
  // calling shouldRetry). Not a pure-verb vector. See gaps.md G-RT3.
  it.todo("R8: abort mid-retry stops the loop — GAP (effect boundary, no reducer verb), see gaps.md G-RT3");

  // Decorrelated jitter (Polly DecorrelatedJitterV2) is cockatiel's DEFAULT
  // generator: stateful, history-dependent (next delay depends on the previous
  // one). tea has only stateless none/full/equal. The exact decorrelated
  // sequence cannot be reproduced; only its bounds + no-NaN invariant port —
  // and those ARE covered by R2 (bounds) and R3 (no-NaN/#86) above. See
  // gaps.md G-RT1.
  it.todo("decorrelated-jitter exact sequence — GAP (stateful, no tea counterpart); bounds covered by R2/R3, see gaps.md G-RT1");
});
