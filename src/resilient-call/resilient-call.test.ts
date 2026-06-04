import * as fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineMachine, replay, run } from "../index";
import { bindMachine } from "../testing";
import {
  createResilientCall,
  type DeadlineExceededError,
  deadlineSub,
  type FailMsg,
  type ResilientState,
  type ResilientTimerMsg,
  type RunCmd,
  type SucceedMsg,
} from "./index";

// ---------------------------------------------------------------------------
// A minimal host machine that wires the knob's slice as a single `resilience`
// field. Input is `string`, result is `string` — the resilient-fetch shape.
// Every Msg carries `at` so the reducer never reads a clock (invariant 2).
// ---------------------------------------------------------------------------

interface HostState {
  readonly resilience: ResilientState<string, string>;
}
type HostMsg =
  | { type: "attempt"; key: string; input: string; at: number }
  | SucceedMsg<string>
  | FailMsg
  | ResilientTimerMsg;
type HostCmd = RunCmd<string>;

// rng pinned to 0 → "full" jitter collapses the backoff delay to exactly 0,
// so retryAtMs == at: deterministic, observable timer targets in assertions.
const rngZero = () => 0;

const fullConfig = {
  cache: { ttlMs: 1_000 },
  circuit: { threshold: 2, cooldownMs: 500 },
  rateLimit: { capacity: 2, refillPerSec: 1 },
  retry: {
    baseMs: 100,
    factor: 2,
    capMs: 10_000,
    maxAttempts: 3,
    jitter: "full" as const,
  },
  deadline: { ms: 5_000 },
};

function makeMachine(
  config: Parameters<typeof createResilientCall>[0],
  rng = rngZero,
) {
  const rc = createResilientCall<string, string>(config, rng);
  const machine = defineMachine<
    HostState,
    HostMsg,
    HostCmd,
    ReturnType<typeof rc.subs>[number],
    object
  >({
    init: (loaded) =>
      loaded !== null ? [loaded, []] : [{ resilience: rc.init() }, []],
    update: {
      attempt: (s, m) => {
        const [slice, cmds] = rc.attempt(s.resilience, m.key, m.input, m.at);
        return [{ resilience: slice }, cmds];
      },
      resilient_ok: (s, m) => {
        const [slice, cmds] = rc.succeed(s.resilience, m.key, m);
        return [{ resilience: slice }, cmds];
      },
      resilient_err: (s, m) => {
        const [slice, cmds] = rc.fail(s.resilience, m.key, m);
        return [{ resilience: slice }, cmds];
      },
      deadline_exceeded: (s, m) => {
        const [slice, cmds] = rc.onTimer(s.resilience, m);
        return [{ resilience: slice }, cmds];
      },
    },
    subscriptions: (s) => rc.subs(s.resilience),
    subscribe: { deadline: () => () => {} },
  });
  return { rc, machine };
}

const ctx = {} as object;

describe("createResilientCall — init", () => {
  it("starts with empty calls, closed breaker, full bucket, empty cache/retry", () => {
    const rc = createResilientCall<string, string>(fullConfig, rngZero);
    const s = rc.init();
    expect(s.calls).toEqual({});
    expect(s.circuit).toEqual({ phase: "closed", failures: 0 });
    expect(s.bucket.tokens).toBe(2);
    expect(s.bucket.capacity).toBe(2);
    expect(s.cache.entries).toEqual({});
    expect(s.retry).toEqual({});
  });

  it("omitting the rateLimit brick skips the gate — every attempt passes", () => {
    const rc = createResilientCall<string, string>({}, rngZero);
    // With no rateLimit brick the bucket is never consulted, so any number of
    // attempts emit the effect — no throttling, no token accounting.
    let st = rc.init();
    for (let i = 0; i < 100; i++) {
      const [next, cmds] = rc.attempt(st, "k", "in", i);
      st = next;
      expect(cmds).toEqual([{ type: "resilient_run", key: "k", input: "in" }]);
    }
  });
});

describe("createResilientCall — the gate (attempt)", () => {
  it("serves a fresh cache hit without emitting any effect", () => {
    const rc = createResilientCall<string, string>(fullConfig, rngZero);
    // Seed the cache via a real success first.
    const [s1] = rc.attempt(rc.init(), "k", "in", 0);
    const [s2] = rc.succeed(s1, "k", {
      type: "resilient_ok",
      key: "k",
      result: "VALUE",
      at: 0,
    });
    // Re-attempt while still fresh (ttl 1000ms) → cache hit, no effect.
    const [s3, cmds] = rc.attempt(s2, "k", "in", 500);
    expect(cmds).toEqual([]);
    expect(s3.calls.k).toEqual({ phase: "succeeded", result: "VALUE" });
  });

  it("misses the cache once the entry expires and re-issues the effect", () => {
    const rc = createResilientCall<string, string>(fullConfig, rngZero);
    const [s1] = rc.attempt(rc.init(), "k", "in", 0);
    const [s2] = rc.succeed(s1, "k", {
      type: "resilient_ok",
      key: "k",
      result: "V",
      at: 0,
    });
    // ttlMs 1000 → expired at exactly 1000 (half-open cutoff).
    const [, cmds] = rc.attempt(s2, "k", "in", 1_000);
    expect(cmds).toEqual([{ type: "resilient_run", key: "k", input: "in" }]);
  });

  it("emits the run effect and enters `running` when all gates pass", () => {
    const rc = createResilientCall<string, string>(fullConfig, rngZero);
    const [s, cmds] = rc.attempt(rc.init(), "k", "payload", 42);
    expect(cmds).toEqual([
      { type: "resilient_run", key: "k", input: "payload" },
    ]);
    expect(s.calls.k).toEqual({
      phase: "running",
      input: "payload",
      deadlineAtMs: 5_042,
    });
    expect(s.bucket.tokens).toBe(1); // one token consumed
  });

  it("fast-fails into circuit_open while the breaker is open", () => {
    // A roomy bucket (cap 10) so the rate-limit gate — which now runs BEFORE the
    // circuit probe — never interferes here; this test isolates the circuit
    // gate. The "other" attempt must therefore reach the (open) breaker with a
    // token in hand and still be inside the cooldown window (10ms < 500ms), so
    // it fast-fails rather than being admitted as a half-open probe.
    const rc = createResilientCall<string, string>(
      { ...fullConfig, rateLimit: { capacity: 10, refillPerSec: 1 } },
      rngZero,
    );
    // Trip the breaker: threshold 2 consecutive failures.
    let s = rc.init();
    [s] = rc.attempt(s, "k", "in", 0);
    [s] = rc.fail(s, "k", {
      type: "resilient_err",
      key: "k",
      error: "e1",
      at: 0,
    });
    // waiting_retry now; force a re-attempt and fail again to reach threshold.
    [s] = rc.attempt(s, "k", "in", 0);
    [s] = rc.fail(s, "k", {
      type: "resilient_err",
      key: "k",
      error: "e2",
      at: 0,
    });
    expect(s.circuit.phase).toBe("open");
    // A NEW key attempt now fast-fails the shared breaker (still cooling down).
    const [s2, cmds] = rc.attempt(s, "other", "in", 10);
    expect(cmds).toEqual([]);
    expect(s2.calls.other).toEqual({ phase: "circuit_open" });
  });

  it("rate-limit exhaustion backs off into waiting_retry (not an effect)", () => {
    const rc = createResilientCall<string, string>(fullConfig, rngZero);
    let s = rc.init();
    // capacity 2 → two attempts pass, the third is throttled.
    let cmds: readonly RunCmd<string>[];
    [s, cmds] = rc.attempt(s, "a", "in", 0);
    expect(cmds.length).toBe(1);
    [s, cmds] = rc.attempt(s, "b", "in", 0);
    expect(cmds.length).toBe(1);
    [s, cmds] = rc.attempt(s, "c", "in", 0);
    expect(cmds).toEqual([]);
    expect(s.calls.c.phase).toBe("waiting_retry");
  });
});

describe("createResilientCall — succeed / fail", () => {
  it("succeed closes the breaker, fills the cache, drops the retry counter", () => {
    const rc = createResilientCall<string, string>(fullConfig, rngZero);
    let s = rc.init();
    [s] = rc.attempt(s, "k", "in", 0);
    [s] = rc.fail(s, "k", {
      type: "resilient_err",
      key: "k",
      error: "e",
      at: 0,
    });
    expect(s.retry.k?.attempt).toBe(1); // one failure recorded
    [s] = rc.attempt(s, "k", "in", 0);
    [s] = rc.succeed(s, "k", {
      type: "resilient_ok",
      key: "k",
      result: "OK",
      at: 0,
    });
    expect(s.calls.k).toEqual({ phase: "succeeded", result: "OK" });
    expect(s.circuit).toEqual({ phase: "closed", failures: 0 });
    expect(s.retry.k).toBeUndefined(); // retry counter dropped
    // Cached: a re-attempt before ttl serves the cache.
    const [, cmds] = rc.attempt(s, "k", "in", 100);
    expect(cmds).toEqual([]);
  });

  it("fail schedules a retry when the policy permits, with rng-pinned delay", () => {
    const rc = createResilientCall<string, string>(fullConfig, rngZero);
    let s = rc.init();
    [s] = rc.attempt(s, "k", "in", 100);
    [s] = rc.fail(s, "k", {
      type: "resilient_err",
      key: "k",
      error: "boom",
      at: 100,
    });
    // rngZero → full jitter delay 0 → retryAtMs == at.
    expect(s.calls.k).toEqual({
      phase: "waiting_retry",
      input: "in",
      retryAtMs: 100,
      deadlineAtMs: 5_100, // deadline preserved from the original attempt
    });
  });

  it("fail settles `failed` once retries are exhausted", () => {
    const rc = createResilientCall<string, string>(fullConfig, rngZero);
    let s = rc.init();
    // maxAttempts 3 → attempts 0,1,2 retry; the 3rd recorded failure gives up.
    for (let i = 0; i < 3; i++) {
      [s] = rc.attempt(s, "k", "in", 0);
      [s] = rc.fail(s, "k", {
        type: "resilient_err",
        key: "k",
        error: `e${i}`,
        at: 0,
      });
    }
    expect(s.calls.k).toEqual({ phase: "failed", error: "e2" });
  });

  it("with no retry brick, the first failure is terminal", () => {
    const rc = createResilientCall<string, string>(
      { circuit: { threshold: 5, cooldownMs: 100 } },
      rngZero,
    );
    let s = rc.init();
    [s] = rc.attempt(s, "k", "in", 0);
    const [s2, cmds] = rc.fail(s, "k", {
      type: "resilient_err",
      key: "k",
      error: "x",
      at: 0,
    });
    expect(cmds).toEqual([]);
    expect(s2.calls.k).toEqual({ phase: "failed", error: "x" });
  });
});

describe("createResilientCall — onTimer (retry + deadline)", () => {
  it("retry timer re-runs the gate for the waiting key", () => {
    const rc = createResilientCall<string, string>(fullConfig, rngZero);
    let s = rc.init();
    [s] = rc.attempt(s, "k", "in", 0);
    [s] = rc.fail(s, "k", {
      type: "resilient_err",
      key: "k",
      error: "e",
      at: 0,
    });
    expect(s.calls.k.phase).toBe("waiting_retry");
    // Fire the retry timer → re-attempt → effect emitted again.
    const [s2, cmds] = rc.onTimer(s, {
      type: "deadline_exceeded",
      id: "resilient:retry:k",
      atMs: 0,
    });
    expect(cmds).toEqual([{ type: "resilient_run", key: "k", input: "in" }]);
    expect(s2.calls.k.phase).toBe("running");
  });

  it("deadline timer fails the call regardless of phase", () => {
    const rc = createResilientCall<string, string>(fullConfig, rngZero);
    let s = rc.init();
    [s] = rc.attempt(s, "k", "in", 0);
    const [s2, cmds] = rc.onTimer(s, {
      type: "deadline_exceeded",
      id: "resilient:deadline:k",
      atMs: 5_000,
    });
    expect(cmds).toEqual([]);
    expect(s2.calls.k.phase).toBe("failed");
  });

  it("a stale timer for a settled key is a no-op", () => {
    const rc = createResilientCall<string, string>(fullConfig, rngZero);
    let s = rc.init();
    [s] = rc.attempt(s, "k", "in", 0);
    [s] = rc.succeed(s, "k", {
      type: "resilient_ok",
      key: "k",
      result: "OK",
      at: 0,
    });
    const before = s;
    const [after, cmds] = rc.onTimer(s, {
      type: "deadline_exceeded",
      id: "resilient:retry:k",
      atMs: 0,
    });
    expect(cmds).toEqual([]);
    expect(after).toBe(before); // identity unchanged — pure no-op
  });
});

describe("createResilientCall — subs", () => {
  it("arms a retry timer while waiting_retry and a deadline timer while active", () => {
    const rc = createResilientCall<string, string>(fullConfig, rngZero);
    let s = rc.init();
    [s] = rc.attempt(s, "k", "in", 100);
    // running → only the deadline timer.
    expect(rc.subs(s)).toEqual([deadlineSub("resilient:deadline:k", 5_100)]);
    [s] = rc.fail(s, "k", {
      type: "resilient_err",
      key: "k",
      error: "e",
      at: 100,
    });
    // waiting_retry → both retry and deadline timers.
    expect(rc.subs(s)).toEqual([
      deadlineSub("resilient:retry:k", 100),
      deadlineSub("resilient:deadline:k", 5_100),
    ]);
    [s] = rc.succeed(s, "k", {
      type: "resilient_ok",
      key: "k",
      result: "OK",
      at: 100,
    });
    // settled → no timers.
    expect(rc.subs(s)).toEqual([]);
  });

  it("omitting the deadline brick arms only retry timers", () => {
    const rc = createResilientCall<string, string>(
      {
        retry: {
          baseMs: 100,
          factor: 2,
          capMs: 1_000,
          maxAttempts: 3,
          jitter: "none",
        },
      },
      rngZero,
    );
    let s = rc.init();
    [s] = rc.attempt(s, "k", "in", 0);
    [s] = rc.fail(s, "k", {
      type: "resilient_err",
      key: "k",
      error: "e",
      at: 0,
    });
    const subs = rc.subs(s);
    expect(subs.every((sub) => sub.id.startsWith("resilient:retry:"))).toBe(
      true,
    );
    expect(subs.length).toBe(1);
  });
});

describe("createResilientCall — wired in a machine (replay)", () => {
  const { machine } = makeMachine(fullConfig);
  const bound = bindMachine(machine, ctx);

  it("init produces an empty resilience slice with no subs", () => {
    const { state, subs } = bound.replay({ msgs: [] });
    expect(state.resilience.calls).toEqual({});
    expect(subs).toEqual([]);
  });

  it("an attempt msg emits the run cmd through the reducer", () => {
    bound.expectCmdSequence(
      { msgs: [{ type: "attempt", key: "k", input: "in", at: 0 }] },
      [{ type: "resilient_run", key: "k", input: "in" }],
    );
  });

  it("attempt → fail → leaves a retry timer desired at the final state", () => {
    bound.expectActiveSubs(
      {
        msgs: [
          { type: "attempt", key: "k", input: "in", at: 0 },
          { type: "resilient_err", key: "k", error: "e", at: 0 },
        ],
      },
      [
        deadlineSub("resilient:retry:k", 0),
        deadlineSub("resilient:deadline:k", 5_000),
      ],
    );
  });

  it("attempt → ok → settles succeeded with no further subs", () => {
    const { state, subs } = bound.replay({
      msgs: [
        { type: "attempt", key: "k", input: "in", at: 0 },
        { type: "resilient_ok", key: "k", result: "DONE", at: 0 },
      ],
    });
    expect(state.resilience.calls.k).toEqual({
      phase: "succeeded",
      result: "DONE",
    });
    expect(subs).toEqual([]);
  });
});

describe("createResilientCall — handlers route Ok/Err to settle Msgs", () => {
  it("routes a resolving port to a resilient_ok msg", async () => {
    const rc = createResilientCall<string, string>(fullConfig, rngZero);
    const handler = rc.handlers({
      run: async (input) => `result:${input}`,
    }).resilient_run;
    const msg = await handler(
      { type: "resilient_run", key: "k", input: "hi" },
      {} as never,
    );
    expect(msg?.type).toBe("resilient_ok");
    if (msg?.type === "resilient_ok") {
      expect(msg.key).toBe("k");
      expect(msg.result).toBe("result:hi");
      expect(typeof msg.at).toBe("number");
    }
  });

  it("routes a rejecting port to a resilient_err msg carrying the original error", async () => {
    const rc = createResilientCall<string, string>(fullConfig, rngZero);
    const boom = new Error("backend down");
    const handler = rc.handlers({
      run: async () => {
        throw boom;
      },
    }).resilient_run;
    const msg = await handler(
      { type: "resilient_run", key: "k", input: "hi" },
      {} as never,
    );
    expect(msg?.type).toBe("resilient_err");
    if (msg?.type === "resilient_err") {
      expect(msg.error).toBe(boom); // original error passes through untouched
      expect(msg.key).toBe("k");
    }
  });
});

// ---------------------------------------------------------------------------
// Properties — invariants that must hold over arbitrary verb sequences.
// ---------------------------------------------------------------------------

describe("createResilientCall — properties", () => {
  it("verbs never mutate their input state (immutability)", () => {
    const rc = createResilientCall<string, string>(fullConfig, rngZero);
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.string(),
        (at, input) => {
          const s0 = rc.init();
          const frozen = Object.freeze(s0);
          // attempt off a frozen slice must not throw (no in-place writes).
          const [s1, cmds] = rc.attempt(frozen, "k", input, at);
          expect(s1).not.toBe(frozen);
          // succeed / fail likewise return fresh slices.
          const [s2] = rc.succeed(s1, "k", {
            type: "resilient_ok",
            key: "k",
            result: input,
            at,
          });
          const [s3] = rc.fail(s1, "k", {
            type: "resilient_err",
            key: "k",
            error: "e",
            at,
          });
          expect(s2).not.toBe(s1);
          expect(s3).not.toBe(s1);
          return Array.isArray(cmds);
        },
      ),
    );
  });

  it("at most one run cmd is ever emitted per verb call (the gate is single-shot)", () => {
    const rc = createResilientCall<string, string>(fullConfig, rngZero);
    type Action =
      | { kind: "attempt"; key: string; at: number }
      | { kind: "ok"; key: string; at: number }
      | { kind: "err"; key: string; at: number }
      | { kind: "retry"; key: string; at: number };
    const action = fc.oneof(
      fc.record({
        kind: fc.constant("attempt" as const),
        key: fc.constantFrom("a", "b"),
        at: fc.nat(20_000),
      }),
      fc.record({
        kind: fc.constant("ok" as const),
        key: fc.constantFrom("a", "b"),
        at: fc.nat(20_000),
      }),
      fc.record({
        kind: fc.constant("err" as const),
        key: fc.constantFrom("a", "b"),
        at: fc.nat(20_000),
      }),
      fc.record({
        kind: fc.constant("retry" as const),
        key: fc.constantFrom("a", "b"),
        at: fc.nat(20_000),
      }),
    );
    fc.assert(
      fc.property(fc.array(action, { maxLength: 30 }), (actions: Action[]) => {
        let s = rc.init();
        for (const a of actions) {
          let cmds: readonly RunCmd<string>[] = [];
          switch (a.kind) {
            case "attempt":
              [s, cmds] = rc.attempt(s, a.key, "in", a.at);
              break;
            case "ok":
              [s, cmds] = rc.succeed(s, a.key, {
                type: "resilient_ok",
                key: a.key,
                result: "r",
                at: a.at,
              });
              break;
            case "err":
              [s, cmds] = rc.fail(s, a.key, {
                type: "resilient_err",
                key: a.key,
                error: "e",
                at: a.at,
              });
              break;
            case "retry":
              [s, cmds] = rc.onTimer(s, {
                type: "deadline_exceeded",
                id: `resilient:retry:${a.key}`,
                atMs: a.at,
              });
              break;
          }
          // The gate is single-shot: zero or one effect, never a fan-out.
          if (cmds.length > 1) return false;
        }
        return true;
      }),
    );
  });

  it("replay is deterministic: the same msg sequence yields the same final state", () => {
    const { machine } = makeMachine(fullConfig);
    const msgArb = fc.array(
      fc.oneof(
        fc.record({
          type: fc.constant("attempt" as const),
          key: fc.constantFrom("a", "b"),
          input: fc.constant("in"),
          at: fc.nat(10_000),
        }),
        fc.record({
          type: fc.constant("resilient_err" as const),
          key: fc.constantFrom("a", "b"),
          error: fc.constant("e"),
          at: fc.nat(10_000),
        }),
      ),
      { maxLength: 20 },
    );
    fc.assert(
      fc.property(msgArb, (msgs) => {
        const a = replay(machine, { msgs: msgs as HostMsg[], ctx });
        const b = replay(machine, { msgs: msgs as HostMsg[], ctx });
        expect(a.state).toEqual(b.state);
        return true;
      }),
    );
  });

  // -------------------------------------------------------------------------
  // DEFECT 2 — durability. A deadline-failed slice must round-trip through
  // JSON unchanged. The pre-fix code settled `error: new Error(...)`, which
  // JSON.stringify renders to `{}` (losing the message) and which carries a
  // non-serializable stack trace — so the persisted slice ≠ the in-memory
  // slice, breaking the "Durable" canon (a DO eviction/reload would resurrect
  // a different slice than was saved). The plain-data `{_tag,...}` sentinel
  // round-trips equal. This property fails against the buggy code.
  // -------------------------------------------------------------------------
  it("a deadline-failed slice round-trips through JSON unchanged (durable)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("k", "other", "page:1"),
        fc.string(),
        fc.integer({ min: 0, max: 1_000_000 }),
        (key, input, at) => {
          const rc = createResilientCall<string, string>(fullConfig, rngZero);
          let s = rc.init();
          [s] = rc.attempt(s, key, input, at);
          // Fire the overall deadline timer for the in-flight call → settles
          // `failed` with the deadline sentinel.
          const [settled] = rc.onTimer(s, {
            type: "deadline_exceeded",
            id: `resilient:deadline:${key}`,
            atMs: at + 5_000,
          });
          const call = settled.calls[key];
          // The call really did settle failed via the deadline path.
          expect(call?.phase).toBe("failed");
          // The whole slice is JSON-stable: stringify → parse → deep-equal.
          const roundTripped = JSON.parse(JSON.stringify(settled));
          expect(roundTripped).toEqual(settled);
          // And the error is the plain-data sentinel, not a wiped `{}`.
          if (call?.phase === "failed") {
            expect(call.error).toEqual({
              _tag: "deadline_exceeded",
              id: `resilient:deadline:${key}`,
              atMs: at + 5_000,
            } satisfies DeadlineExceededError);
          }
          return true;
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// DEFECT 3 — settleFailed: a terminal failure that is NOT a downstream-health
// signal. Settles `failed` WITHOUT tripping the breaker or advancing the retry
// counter, so a caller (authed-call's unfixable 401, paginated-walk's terminal
// page error) can end a call without poisoning the shared breaker or the
// per-key backoff run.
// ---------------------------------------------------------------------------

describe("createResilientCall — settleFailed (terminal, breaker-neutral)", () => {
  it("settles `failed` and emits no cmd", () => {
    const rc = createResilientCall<string, string>(fullConfig, rngZero);
    let s = rc.init();
    [s] = rc.attempt(s, "k", "in", 0);
    const [s2, cmds] = rc.settleFailed(s, "k", { _tag: "unauthorized" });
    expect(cmds).toEqual([]);
    expect(s2.calls.k).toEqual({
      phase: "failed",
      error: { _tag: "unauthorized" },
    });
  });

  it("does NOT trip the breaker, even at the failure threshold", () => {
    // threshold 2: two `fail`s would open the breaker. Two `settleFailed`s must
    // leave it exactly where it started.
    const rc = createResilientCall<string, string>(fullConfig, rngZero);
    let s = rc.init();
    [s] = rc.attempt(s, "k", "in", 0);
    [s] = rc.settleFailed(s, "k", "x1");
    [s] = rc.attempt(s, "k", "in", 0);
    [s] = rc.settleFailed(s, "k", "x2");
    expect(s.circuit).toEqual({ phase: "closed", failures: 0 });
  });

  it("does NOT advance this key's retry counter", () => {
    const rc = createResilientCall<string, string>(fullConfig, rngZero);
    let s = rc.init();
    [s] = rc.attempt(s, "k", "in", 0);
    // Seed a real failure so a retry counter exists.
    [s] = rc.fail(s, "k", {
      type: "resilient_err",
      key: "k",
      error: "e",
      at: 0,
    });
    expect(s.retry.k?.attempt).toBe(1);
    const before = s.retry.k;
    [s] = rc.settleFailed(s, "k", "terminal");
    // Phase is now terminal `failed`, but the retry counter is byte-identical.
    expect(s.calls.k).toEqual({ phase: "failed", error: "terminal" });
    expect(s.retry.k).toBe(before);
  });

  it("property: settleFailed never touches circuit or retry, only the call phase", () => {
    const rc = createResilientCall<string, string>(fullConfig, rngZero);
    fc.assert(
      fc.property(
        fc.constantFrom("a", "b"),
        fc.array(fc.constantFrom("a", "b"), { maxLength: 6 }),
        fc.string(),
        (target, failedKeys, error) => {
          // Build up arbitrary circuit/retry state via real fails, then settle.
          let s = rc.init();
          for (const k of failedKeys) {
            [s] = rc.attempt(s, k, "in", 0);
            [s] = rc.fail(s, k, {
              type: "resilient_err",
              key: k,
              error: "e",
              at: 0,
            });
          }
          const circuitBefore = s.circuit;
          const retryBefore = s.retry;
          const [s2] = rc.settleFailed(s, target, error);
          // circuit + retry references are preserved untouched.
          expect(s2.circuit).toBe(circuitBefore);
          expect(s2.retry).toBe(retryBefore);
          // only the target key's phase changed to failed.
          expect(s2.calls[target]).toEqual({ phase: "failed", error });
          return true;
        },
      ),
    );
  });
});

// ===========================================================================
// DEFECT 1 — the SYSTEMIC root test that was missing.
//
// The replay-through-helpers blocks above hand-feed Msgs and assert the Cmds
// those exact Msgs emit. That is why the gate-order bug shipped green: nobody
// ran the REAL dispatch lifecycle end to end — through `interpret` re-entry —
// and asserted the END STATE of the shared breaker.
//
// Here we build an actual `run()` Runtime from the knob's verbs + handlers and
// wire the `run` port into `interpret` so a settle Msg RE-ENTERS the machine
// exactly as production does: attempt → (Cmd) resilient_run → port → (follow-up
// Msg) resilient_ok / resilient_err → succeed / fail. We then drive the precise
// half-open + rate-limit-reject scenario and assert the breaker RECOVERS.
//
// Pre-fix (circuit probe consumed BEFORE the rate-limit gate): a rate-limited
// attempt while the breaker is `half_open` burns the lone probe slot without
// ever emitting a Cmd — no backend call, so no settle Msg moves the breaker out
// of `half_open`. The breaker wedges open forever; the final recovery attempt
// fast-fails into `circuit_open` and the end state is NOT `closed`. The
// assertion below FAILS against the buggy code and PASSES after the reorder.
// ===========================================================================

describe("createResilientCall — wired end-to-end: breaker recovers (defect 1)", () => {
  // The clock the interpret boundary stamps onto settle Msgs. Pinned so the
  // breaker's trip stamp + cooldown math are deterministic across the run.
  let nowBox = { value: 0 };
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The wired host: input string, result string. Drives the real verbs.
  interface WState {
    readonly resilience: ResilientState<string, string>;
  }
  type WMsg =
    | { type: "attempt"; key: string; input: string; at: number }
    | { type: "nop" }
    | SucceedMsg<string>
    | FailMsg
    | ResilientTimerMsg;
  type WCmd = RunCmd<string>;

  // The single downstream port. A queue of outcomes the worker pops per call —
  // the ONLY place a "backend call" happens, so its length is the ground-truth
  // "did the attempt actually reach the backend".
  interface WCtx {
    readonly outcomes: ("ok" | "fail")[];
    readonly calls: { count: number };
  }

  function wiredMachine(
    config: Parameters<typeof createResilientCall>[0],
    ctx: WCtx,
  ) {
    const rc = createResilientCall<string, string>(config, rngZero);
    return defineMachine<WState, WMsg, WCmd, never, WCtx>({
      init: (loaded) =>
        loaded !== null ? [loaded, []] : [{ resilience: rc.init() }, []],
      update: {
        attempt: (s, m) => {
          const [slice, cmds] = rc.attempt(s.resilience, m.key, m.input, m.at);
          return [{ resilience: slice }, cmds];
        },
        resilient_ok: (s, m) => {
          const [slice, cmds] = rc.succeed(s.resilience, m.key, m);
          return [{ resilience: slice }, cmds];
        },
        resilient_err: (s, m) => {
          const [slice, cmds] = rc.fail(s.resilience, m.key, m);
          return [{ resilience: slice }, cmds];
        },
        deadline_exceeded: (s, m) => {
          const [slice, cmds] = rc.onTimer(s.resilience, m);
          return [{ resilience: slice }, cmds];
        },
        nop: (s) => [s, []],
      },
      // The REAL handler — the same `tryInterpret`-wrapped port production uses —
      // routes the port outcome back as resilient_ok / resilient_err, which the
      // runtime enqueues as a follow-up Msg (re-entry).
      interpret: rc.handlers({
        run: async () => {
          ctx.calls.count += 1;
          const outcome = ctx.outcomes.shift() ?? "ok";
          if (outcome === "fail") throw { _tag: "backend_down" };
          return "VALUE";
        },
      }),
    });
  }

  // Drain the re-entrant follow-up chain: each `await dispatch` settles only its
  // own transition; the settle Msg interpret returns is enqueued on the tail.
  // Pump `nop` until the backend-call ledger stops moving — same pattern the
  // idempotent-intake wired test uses.
  async function drain(
    runtime: { dispatch(m: WMsg): Promise<void> },
    ctx: WCtx,
  ): Promise<void> {
    let prev = -1;
    let guard = 0;
    while (guard++ < 50) {
      const before = ctx.calls.count;
      await runtime.dispatch({ type: "nop" });
      const after = ctx.calls.count;
      if (after === before && after === prev) return;
      prev = after;
    }
  }

  it("a rate-limited attempt while half-open does not wedge the breaker open", async () => {
    nowBox = { value: 0 };
    vi.spyOn(Date, "now").mockImplementation(() => nowBox.value);

    const ctx: WCtx = { outcomes: [], calls: { count: 0 } };
    // threshold 1 → one failure opens the breaker. cooldown 100ms. A bucket of
    // capacity 1 refilling at 1/sec (≈0.001 token/ms) so a second attempt soon
    // after the first is rate-limited, but a full token is back by t=1000. NO
    // retry brick → a failure (real or rate-limited) settles terminally without
    // re-arming a timer, keeping the scenario hand-driven and deterministic.
    const config = {
      circuit: { threshold: 1, cooldownMs: 100, halfOpenMaxProbes: 1 },
      rateLimit: { capacity: 1, refillPerSec: 1 },
    };
    const machine = wiredMachine(config, ctx);
    const runtime = run(machine, { ctx });
    await runtime.ready;

    // (1) t=0 — first attempt reaches the backend and FAILS. threshold 1 → the
    // breaker trips OPEN. Bucket now empty.
    ctx.outcomes = ["fail"];
    await runtime.dispatch({ type: "attempt", key: "k", input: "in", at: 0 });
    await drain(runtime, ctx);
    expect(runtime.getState().resilience.circuit.phase).toBe("open");
    expect(ctx.calls.count).toBe(1); // backend hit exactly once so far

    // (2) t=100 — cooldown has elapsed, so the breaker is willing to half-open.
    // But the bucket has only ~0.1 token, so the RATE-LIMIT gate rejects this
    // attempt. Under the BUGGY order this consumes the half-open probe with no
    // backend call; under the fix the circuit is never touched. Either way the
    // backend is NOT hit (no token).
    const callsBefore = ctx.calls.count;
    await runtime.dispatch({ type: "attempt", key: "k", input: "in", at: 100 });
    await drain(runtime, ctx);
    expect(ctx.calls.count).toBe(callsBefore); // backend NOT reached — rate-limited

    // (3) t=1000 — a full token is back AND the cooldown is long elapsed. This
    // attempt must reach the backend as the half-open probe and SUCCEED, closing
    // the breaker. Under the buggy code the probe budget was already spent in
    // (2), so this attempt fast-fails into circuit_open, never reaches the
    // backend, and the breaker stays wedged open.
    ctx.outcomes = ["ok"];
    await runtime.dispatch({
      type: "attempt",
      key: "k",
      input: "in",
      at: 1000,
    });
    await drain(runtime, ctx);

    // END STATE — the systemic assertion: the breaker recovered.
    expect(runtime.getState().resilience.circuit).toEqual({
      phase: "closed",
      failures: 0,
    });
    expect(runtime.getState().resilience.calls.k).toEqual({
      phase: "succeeded",
      result: "VALUE",
    });
    // And the recovery probe actually reached the backend (proving it was not
    // fast-failed by a wedged half-open breaker).
    expect(ctx.calls.count).toBe(2);

    await runtime.stop();
  });
});
