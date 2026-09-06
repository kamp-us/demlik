/**
 * cockatiel circuit-breaker TEST VECTORS, ported against tea's pure verbs.
 *
 * Provenance: vectors B1–B10 were extracted by a `canon` pass into
 * `.patterns/cockatiel/circuit-breaker-vectors.md` (with brick↔verb routing in
 * `.patterns/cockatiel/index.md` and the no-counterpart list in
 * `.patterns/cockatiel/gaps.md`). The motivation is ADR 0001
 * (`.decisions/0001-no-offtheshelf-resilience.md`, consequence #1):
 * tea builds resilience in-house, so it must inherit cockatiel's battle-tested
 * edge cases rather than its code.
 *
 * These drive the PURE verbs directly. cockatiel uses sinon fake timers
 * (`clock.tick`); tea's verbs take time as DATA (`nowMs`/`at` arg), so the
 * cooldown boundaries are plain numbers here — no real or fake clock.
 *
 * Two documented tea-vs-cockatiel normalizations are baked into the assertions:
 *   - Cutoff is `elapsed >= cooldownMs` admits (tea uses `>=`; cockatiel's
 *     Open→HalfOpen edge is `elapsed < duration` → throw, i.e. `>=` admits —
 *     they agree on the inclusive lower edge).
 *   - `cooldownMs` is a fixed policy scalar (cockatiel's `ConstantBackoff` is
 *     exactly this case; its growing-backoff variants are flagged GAP below).
 *
 * Gap vectors (B5/B6/B6b/B7/B8/B9, `isolate()`) have NO tea verb counterpart;
 * each is left as a visible `it.todo` / `describe.skip` placeholder citing
 * gaps.md so it can never be mistaken for coverage.
 */

import { describe, expect, it } from "vitest";
import {
  type CircuitPolicy,
  type CircuitState,
  canPass,
  initCircuit,
  onFailure,
  onSuccess,
} from "./index";

// Matches cockatiel's `ConsecutiveBreaker(N)` family with the canonical
// single-probe half-open default (`halfOpenSampling: { calls: 1, threshold: 0 }`),
// which is the ONLY sampling config tea models 1:1.
const policy: CircuitPolicy = {
  failureThreshold: 3,
  cooldownMs: 1000,
  halfOpenMaxProbes: 1,
};

// ===========================================================================
// PORTED & PASSING
// ===========================================================================

describe("B1 — closed → open at the consecutive failure threshold", () => {
  // cockatiel: ConsecutiveBreaker(3).failure() returns true on the 3rd call;
  // a single success() resets the consecutive run.
  // tea: onFailure folds; the threshold-th failure trips to open(nowMs).
  it("trips on the threshold-th failure, not the (threshold-1)-th", () => {
    let s: CircuitState = initCircuit();
    s = onFailure(s, policy, 0);
    expect(s).toEqual({ phase: "closed", failures: 1 }); // 1st — survives
    s = onFailure(s, policy, 0);
    expect(s).toEqual({ phase: "closed", failures: 2 }); // 2nd — survives
    s = onFailure(s, policy, 500);
    expect(s).toEqual({ phase: "open", openedAtMs: 500 }); // 3rd — TRIPS, stamped
  });

  it("a single success fully resets the consecutive run", () => {
    let s: CircuitState = initCircuit();
    s = onFailure(s, policy, 0);
    s = onFailure(s, policy, 0); // 2 failures, one short of tripping
    s = onSuccess(s, policy);
    expect(s).toEqual({ phase: "closed", failures: 0 }); // reset to 0
    // Now the full threshold is needed again to trip.
    s = onFailure(s, policy, 0);
    s = onFailure(s, policy, 0);
    expect(s.phase).toBe("closed");
    s = onFailure(s, policy, 700);
    expect(s).toEqual({ phase: "open", openedAtMs: 700 }); // trips again
  });

  it("an open breaker fast-fails before cooldown (fn never invoked)", () => {
    // cockatiel: the 3rd execute on an Open breaker rejects with
    // BrokenCircuitError and does NOT call the guarded stub (`s.calledTwice`).
    // tea: canPass(open, …) within cooldown returns [open, false] — the caller
    // branches on false and never emits the guarded effect.
    let s: CircuitState = initCircuit();
    s = onFailure(s, policy, 0);
    s = onFailure(s, policy, 0);
    s = onFailure(s, policy, 0);
    expect(s).toEqual({ phase: "open", openedAtMs: 0 });
    const [next, allowed] = canPass(s, policy, 1); // 1ms < cooldownMs
    expect(allowed).toBe(false);
    expect(next).toEqual(s); // state unchanged — no probe admitted
  });
});

describe("B2 — open → half_open after cooldown, probe SUCCESS closes", () => {
  // cockatiel: clock.tick(1000) === halfOpenAfter → the next execute flips
  // Open→HalfOpen; the probe resolving 42 closes the breaker (onReset).
  // tea: canPass(open, …, openedAtMs + cooldownMs) admits probe 1; onSuccess
  // on half_open closes.
  it("admits the first probe exactly at the cooldown boundary, then closes on success", () => {
    const open: CircuitState = { phase: "open", openedAtMs: 1000 };
    const [halfOpen, allowed] = canPass(open, policy, 1000 + policy.cooldownMs);
    expect(allowed).toBe(true);
    expect(halfOpen).toEqual({ phase: "half_open", probes: 1 });
    // Probe succeeds → fully closed, failures reset.
    expect(onSuccess(halfOpen, policy)).toEqual({
      phase: "closed",
      failures: 0,
    });
  });

  it("the boundary is inclusive: elapsed === cooldownMs admits (tea >=, matches cockatiel)", () => {
    // cockatiel cutoff: elapsed < duration throws; elapsed === duration admits.
    const open: CircuitState = { phase: "open", openedAtMs: 0 };
    // One tick short of the boundary → still cooling down.
    expect(canPass(open, policy, policy.cooldownMs - 1)[1]).toBe(false);
    // Exactly the boundary → admitted.
    expect(canPass(open, policy, policy.cooldownMs)[1]).toBe(true);
  });
});

describe("B3 — half_open probe FAILURE re-opens", () => {
  // cockatiel: a throwing probe in HalfOpen reopens (Open), bumping attemptNo.
  // tea: onFailure on half_open → open(nowMs), restarting the cooldown clock.
  it("re-opens and re-stamps the cooldown clock on a probe failure", () => {
    const halfOpen: CircuitState = { phase: "half_open", probes: 1 };
    expect(onFailure(halfOpen, policy, 4242)).toEqual({
      phase: "open",
      openedAtMs: 4242, // fresh trip time — a fresh cooldown must elapse next
    });
  });

  it("after re-open, a fresh full cooldown is required before the next probe", () => {
    // Drive open → probe → fail → re-open, then assert the new cooldown window.
    const reopened = onFailure({ phase: "half_open", probes: 1 }, policy, 5000);
    expect(reopened).toEqual({ phase: "open", openedAtMs: 5000 });
    // 999ms into the new window → still cooling.
    expect(canPass(reopened, policy, 5000 + policy.cooldownMs - 1)[1]).toBe(
      false,
    );
    // Exactly cooldownMs into the new window → probe admitted again.
    expect(canPass(reopened, policy, 5000 + policy.cooldownMs)).toEqual([
      { phase: "half_open", probes: 1 },
      true,
    ]);
  });
});

describe("B4 — still-open before cooldown fast-fails without admitting a probe", () => {
  // cockatiel: Open case throws BrokenCircuitError when
  // Date.now() - openedAt < backoff.duration; the guarded fn is never called.
  // tea: canPass returns [open, false] — state unchanged, no probe.
  it("rejects at one tick below the cooldown and leaves the state unchanged", () => {
    const open: CircuitState = { phase: "open", openedAtMs: 1000 };
    const [next, allowed] = canPass(open, policy, 1000 + policy.cooldownMs - 1);
    expect(allowed).toBe(false);
    expect(next).toEqual(open); // unchanged — no Open→HalfOpen flip, no probe
    expect(next).toBe(open); // identity preserved: the same value is threaded
  });
});

// ===========================================================================
// ADAPTED for intentional tea divergence (clamp-don't-throw)
// ===========================================================================

describe("B10 — parameter validation, ported as tea's CLAMP boundaries (not RangeError)", () => {
  // cockatiel throws RangeError on bad config (calls < 1, threshold outside
  // (0,1), etc.). tea deliberately CLAMPS instead — `onFailure` uses `>=` so an
  // already-met threshold trips immediately rather than over-counting; cooldown
  // and probe-cap comparisons degrade gracefully on out-of-range values.
  // See gaps.md G-CB6 and the `onFailure` source comment. These vectors assert
  // tea's real clamp contract, NOT a throw.

  it("failureThreshold: 0 trips on the first failure (no RangeError, no over-count)", () => {
    const p: CircuitPolicy = { ...policy, failureThreshold: 0 };
    // 1 >= 0 → trips immediately, stamped with nowMs.
    expect(onFailure(initCircuit(), p, 42)).toEqual({
      phase: "open",
      openedAtMs: 42,
    });
  });

  it("a negative failureThreshold also trips immediately (already-exceeded count)", () => {
    const p: CircuitPolicy = { ...policy, failureThreshold: -1 };
    expect(onFailure(initCircuit(), p, 7)).toEqual({
      phase: "open",
      openedAtMs: 7,
    });
  });

  it("a negative cooldownMs makes every elapsed satisfy the cutoff — admits immediately", () => {
    const p: CircuitPolicy = { ...policy, cooldownMs: -100 };
    const open: CircuitState = { phase: "open", openedAtMs: 1000 };
    // elapsed 0 >= -100 → first probe admitted with no wait.
    expect(canPass(open, p, 1000)).toEqual([
      { phase: "half_open", probes: 1 },
      true,
    ]);
  });

  it("halfOpenMaxProbes: 0 still admits the open→half_open entry probe, then caps", () => {
    // The `open` branch hardcodes the entry probe (`half_open(1)`) — it does NOT
    // consult halfOpenMaxProbes for the first caller (documented: 'admit this
    // caller as the first probe'). The cap only gates SUBSEQUENT half_open
    // callers. A 0-cap therefore admits exactly one probe (the entry) and
    // refuses every overflow — graceful clamp, no throw.
    const p: CircuitPolicy = { ...policy, halfOpenMaxProbes: 0 };
    const open: CircuitState = { phase: "open", openedAtMs: 1000 };
    expect(canPass(open, p, 1000 + p.cooldownMs)).toEqual([
      { phase: "half_open", probes: 1 },
      true,
    ]); // entry probe admitted regardless of the 0 cap
    // A second caller arriving on half_open(1): probes(1) < 0 is false → refused.
    expect(canPass({ phase: "half_open", probes: 1 }, p, 2001)).toEqual([
      { phase: "half_open", probes: 1 },
      false,
    ]);
  });
});

// ===========================================================================
// GAP vectors — cockatiel behaviors with NO tea verb counterpart.
// Visible in the test report; attributable to .patterns/cockatiel/gaps.md;
// impossible to mistake for coverage. NEVER silently dropped.
// ===========================================================================

// GAP: tea has no deferred queue. Overflow probes fast-fail
// ([state, false]) where cockatiel awaits a pending decision promise and
// re-executes. The cap is covered by B10/index.test.ts; the QUEUE is not.
// See .patterns/cockatiel/gaps.md G-CB2.
it.todo(
  "B5: overflow half-open probes QUEUE then re-execute — GAP, tea fast-fails, see gaps.md G-CB2",
);

// GAP: tea's half_open is a single-probe count cap; the first probe's
// outcome decides. cockatiel samples `calls` probes and closes iff
// failures <= threshold * calls. Multi-probe ratio sampling is unmodeled.
// See .patterns/cockatiel/gaps.md G-CB1.
it.todo(
  "B6: multi-probe half-open ratio sampling (calls>1) — GAP, tea is single-probe, see gaps.md G-CB1",
);
it.todo(
  "B6b: re-open when half-open sample exceeds the failure ratio — GAP, see gaps.md G-CB1",
);

// GAP: tea's cooldownMs is a fixed policy scalar (cockatiel ConstantBackoff).
// cockatiel's IterableBackoff/ExponentialBackoff grow halfOpenAfter per
// re-open and reset on close. tea has no attemptNo to chain.
// See .patterns/cockatiel/gaps.md G-CB3.
it.todo(
  "B7: growing per-re-open cooldown (backoff-driven halfOpenAfter) — GAP, tea cooldown is fixed, see gaps.md G-CB3",
);

// GAP: tea models only consecutive-failure tripping. CountBreaker opens on a
// rolling failure ratio over a ring-buffer window with a minimum-calls gate.
// No window, no minimum, no serialize round-trip in the pure verb.
// See .patterns/cockatiel/gaps.md G-CB4.
describe.skip("B8: count-window breaker (rolling sample + minimumNumberOfCalls)", () => {
  it("GAP: tea has no rolling window — see .patterns/cockatiel/gaps.md G-CB4", () => {});
});

// GAP: SamplingBreaker opens on a time-windowed rps + failure-ratio sample.
// tea has no time window or rps gate in the pure verb.
// See .patterns/cockatiel/gaps.md G-CB4.
describe.skip("B9: sampling breaker (time-windowed rps + failure ratio)", () => {
  it("GAP: tea has no time-windowed sampling — see .patterns/cockatiel/gaps.md G-CB4", () => {});
});

// GAP: cockatiel's isolate() is a manual hold-open 4th state (plus state
// serialization). tea has exactly three phases (closed/open/half_open) and no
// manual isolate. See .patterns/cockatiel/gaps.md G-CB5.
it.todo(
  "isolate(): manual hold-open Isolated state + serialization — GAP, tea has no 4th phase, see gaps.md G-CB5",
);
