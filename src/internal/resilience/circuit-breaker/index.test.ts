import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type CircuitPolicy,
  type CircuitState,
  canPass,
  defaultCircuitPolicy,
  initCircuit,
  onFailure,
  onSuccess,
} from "./index";

// A small, explicit policy so the thresholds in assertions are obvious.
const policy: CircuitPolicy = {
  failureThreshold: 3,
  cooldownMs: 1000,
  halfOpenMaxProbes: 2,
};

describe("initCircuit", () => {
  it("starts closed with zero failures", () => {
    expect(initCircuit()).toEqual({ phase: "closed", failures: 0 });
  });
});

describe("closed → open trip", () => {
  it("trips to open after exactly failureThreshold failures", () => {
    let s: CircuitState = initCircuit();
    // First two failures keep it closed, incrementing the count.
    s = onFailure(s, policy, 0);
    expect(s).toEqual({ phase: "closed", failures: 1 });
    s = onFailure(s, policy, 0);
    expect(s).toEqual({ phase: "closed", failures: 2 });
    // The threshold-th (3rd) failure trips it open, stamped with nowMs.
    s = onFailure(s, policy, 500);
    expect(s).toEqual({ phase: "open", openedAtMs: 500 });
  });

  it("resets the failure count on a success before the threshold", () => {
    let s: CircuitState = initCircuit();
    s = onFailure(s, policy, 0);
    s = onFailure(s, policy, 0);
    expect(s).toEqual({ phase: "closed", failures: 2 });
    // A success breaks the consecutive run.
    s = onSuccess(s, policy);
    expect(s).toEqual({ phase: "closed", failures: 0 });
    // Now it takes the full threshold again to trip.
    s = onFailure(s, policy, 0);
    s = onFailure(s, policy, 0);
    expect(s.phase).toBe("closed");
    s = onFailure(s, policy, 700);
    expect(s).toEqual({ phase: "open", openedAtMs: 700 });
  });
});

describe("open phase fast-fails within cooldown", () => {
  it("rejects calls while open and the cooldown has not elapsed", () => {
    const open: CircuitState = { phase: "open", openedAtMs: 1000 };
    // 999ms < cooldownMs (1000) → still cooling down.
    const [next, allowed] = canPass(open, policy, 1999);
    expect(allowed).toBe(false);
    expect(next).toEqual(open); // unchanged
  });

  it("onFailure / onSuccess on open leave it unchanged", () => {
    const open: CircuitState = { phase: "open", openedAtMs: 1000 };
    expect(onFailure(open, policy, 5000)).toEqual(open);
    expect(onSuccess(open, policy)).toEqual(open);
  });
});

describe("open → half_open after cooldown", () => {
  it("transitions to half_open and admits a probe once cooldown elapses", () => {
    const open: CircuitState = { phase: "open", openedAtMs: 1000 };
    // Exactly cooldownMs later → half-open cutoff admits the first probe.
    const [next, allowed] = canPass(open, policy, 2000);
    expect(allowed).toBe(true);
    expect(next).toEqual({ phase: "half_open", probes: 1 });
  });
});

describe("half_open resolution", () => {
  it("closes the breaker on a probe success", () => {
    const halfOpen: CircuitState = { phase: "half_open", probes: 1 };
    expect(onSuccess(halfOpen, policy)).toEqual({
      phase: "closed",
      failures: 0,
    });
  });

  it("re-opens and resets the cooldown clock on a probe failure", () => {
    const halfOpen: CircuitState = { phase: "half_open", probes: 1 };
    // Re-open is stamped with the new nowMs — the cooldown restarts from here.
    expect(onFailure(halfOpen, policy, 4242)).toEqual({
      phase: "open",
      openedAtMs: 4242,
    });
  });

  it("caps admitted probes at halfOpenMaxProbes", () => {
    // Drive open → half_open(1), then admit up to the cap (2), then fast-fail.
    const open: CircuitState = { phase: "open", openedAtMs: 0 };
    let [s, allowed] = canPass(open, policy, 1000);
    expect(allowed).toBe(true);
    expect(s).toEqual({ phase: "half_open", probes: 1 });

    // 2nd probe: still under the cap of 2.
    [s, allowed] = canPass(s, policy, 1001);
    expect(allowed).toBe(true);
    expect(s).toEqual({ phase: "half_open", probes: 2 });

    // 3rd probe: at the cap → rejected, state unchanged.
    [s, allowed] = canPass(s, policy, 1002);
    expect(allowed).toBe(false);
    expect(s).toEqual({ phase: "half_open", probes: 2 });
  });
});

describe("full recovery cycle", () => {
  it("closed → open → half_open → closed end to end", () => {
    let s: CircuitState = initCircuit();
    // Trip it.
    s = onFailure(s, policy, 0);
    s = onFailure(s, policy, 0);
    s = onFailure(s, policy, 0);
    expect(s).toEqual({ phase: "open", openedAtMs: 0 });
    // Reject during cooldown.
    let allowed: boolean;
    [s, allowed] = canPass(s, policy, 500);
    expect(allowed).toBe(false);
    // Cooldown elapses → probe admitted.
    [s, allowed] = canPass(s, policy, 1000);
    expect(allowed).toBe(true);
    expect(s.phase).toBe("half_open");
    // Probe succeeds → fully closed, failures reset.
    s = onSuccess(s, policy);
    expect(s).toEqual({ phase: "closed", failures: 0 });
  });
});

describe("no input mutation", () => {
  it("onSuccess / onFailure / canPass never mutate their input state", () => {
    const closed: CircuitState = Object.freeze({
      phase: "closed",
      failures: 2,
    });
    const open: CircuitState = Object.freeze({
      phase: "open",
      openedAtMs: 1000,
    });
    const halfOpen: CircuitState = Object.freeze({
      phase: "half_open",
      probes: 1,
    });

    // Frozen snapshots — any in-place write would throw in strict mode.
    onSuccess(closed, policy);
    onFailure(closed, policy, 9999);
    canPass(closed, policy, 9999);
    onSuccess(open, policy);
    onFailure(open, policy, 9999);
    canPass(open, policy, 9999);
    onSuccess(halfOpen, policy);
    onFailure(halfOpen, policy, 9999);
    canPass(halfOpen, policy, 9999);

    expect(closed).toEqual({ phase: "closed", failures: 2 });
    expect(open).toEqual({ phase: "open", openedAtMs: 1000 });
    expect(halfOpen).toEqual({ phase: "half_open", probes: 1 });
  });

  it("defaultCircuitPolicy has the documented shape", () => {
    expect(defaultCircuitPolicy).toEqual({
      failureThreshold: 5,
      cooldownMs: 30_000,
      halfOpenMaxProbes: 1,
    });
  });
});

describe("property: open within cooldown always rejects", () => {
  it("canPass returns false whenever phase is open and elapsed < cooldownMs", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }), // cooldownMs (> 0 so a window exists)
        fc.integer({ min: 0, max: 1_000_000 }), // openedAtMs
        // elapsed strictly inside [0, cooldownMs) — keep it < cooldownMs.
        fc.integer({ min: 0, max: 999_999 }),
        fc.integer({ min: 1, max: 100 }), // failureThreshold (irrelevant here)
        fc.integer({ min: 1, max: 100 }), // halfOpenMaxProbes (irrelevant here)
        (
          cooldownMs,
          openedAtMs,
          elapsedRaw,
          failureThreshold,
          halfOpenMaxProbes,
        ) => {
          // Force elapsed strictly below the cooldown so the precondition holds.
          const elapsed = elapsedRaw % cooldownMs;
          const p: CircuitPolicy = {
            cooldownMs,
            failureThreshold,
            halfOpenMaxProbes,
          };
          const open: CircuitState = { phase: "open", openedAtMs };
          const nowMs = openedAtMs + elapsed;
          const [next, allowed] = canPass(open, p, nowMs);
          // Precondition: nowMs - openedAtMs < cooldownMs. Postcondition: rejected,
          // state unchanged.
          expect(allowed).toBe(false);
          expect(next).toEqual(open);
        },
      ),
      { numRuns: 1000 },
    );
  });
});
