import * as fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineMachine, replay, run } from "../index";
import { bindMachine } from "../testing";
import {
  type RefreshTokenCmd,
  refreshTokenCmd,
  type Token,
  type TokenRefreshMsg,
  tokenRefreshedMsg,
} from "../token-refresh";
import {
  type AuthedState,
  createAuthedCall,
  deadlineSub,
  type FailMsg,
  type ResilientTimerMsg,
  type RunCmd,
  type SucceedMsg,
} from "./index";

// ---------------------------------------------------------------------------
// A token expiring at t=1000, reused across the credential-timing assertions.
// ---------------------------------------------------------------------------
const tok = (expiresAt: number, value = "abc"): Token => ({ value, expiresAt });

// rng pinned to 0 → "full" jitter collapses backoff to exactly 0, so retryAtMs
// == at: deterministic, observable timer targets in assertions.
const rngZero = () => 0;

const refresh = async () => tok(10_000, "fresh");

// A full resilient config + auth fields. retry/maxAttempts 3 so we can tell a
// 401 (terminal after one refresh) apart from a transient failure (backs off).
const fullConfig = {
  refresh,
  cache: { ttlMs: 1_000 },
  circuit: { threshold: 2, cooldownMs: 500 },
  rateLimit: { capacity: 5, refillPerSec: 1 },
  retry: {
    baseMs: 100,
    factor: 2,
    capMs: 10_000,
    maxAttempts: 3,
    jitter: "full" as const,
  },
  deadline: { ms: 5_000 },
  skewMs: 100,
};

// ---------------------------------------------------------------------------
// A minimal host machine wiring the composed slice as a single `authed` field.
// Input/result are both `string`. Every Msg carries `at` so the reducer never
// reads a clock (invariant 2).
// ---------------------------------------------------------------------------
interface HostState {
  readonly authed: AuthedState<string, string>;
}
type HostMsg =
  | { type: "attempt"; key: string; input: string; at: number }
  | { type: "unauthorized"; key: string; at: number }
  | { type: "token_refreshed"; token: Token; at: number }
  | SucceedMsg<string>
  | FailMsg
  | ResilientTimerMsg;
type HostCmd = RunCmd<string> | { type: "refresh_token" };

function makeMachine(
  config: Parameters<typeof createAuthedCall>[0] = fullConfig,
  rng = rngZero,
) {
  const ac = createAuthedCall<string, string>(config, rng);
  const machine = defineMachine<
    HostState,
    HostMsg,
    HostCmd,
    ReturnType<typeof ac.subs>[number],
    object
  >({
    init: (loaded) =>
      loaded !== null ? [loaded, []] : [{ authed: ac.init() }, []],
    update: {
      attempt: (s, m) => {
        const [slice, cmds] = ac.attempt(s.authed, m.key, m.input, m.at);
        return [{ authed: slice }, cmds];
      },
      resilient_ok: (s, m) => {
        const [slice, cmds] = ac.succeed(s.authed, m.key, m);
        return [{ authed: slice }, cmds];
      },
      resilient_err: (s, m) => {
        const [slice, cmds] = ac.fail(s.authed, m.key, m);
        return [{ authed: slice }, cmds];
      },
      unauthorized: (s, m) => {
        const [slice, cmds] = ac.on401(s.authed, m.key, m.at);
        return [{ authed: slice }, cmds];
      },
      token_refreshed: (s, m) => {
        const [slice, cmds] = ac.onRefreshed(
          ac.installToken(s.authed, m.token),
          m.at,
        );
        return [{ authed: slice }, cmds];
      },
      deadline_exceeded: (s, m) => {
        const [slice, cmds] = ac.onTimer(s.authed, m);
        return [{ authed: slice }, cmds];
      },
    },
    subscriptions: (s) => ac.subs(s.authed),
    subscribe: { deadline: () => () => {} },
  });
  return { ac, machine };
}

const ctx = {} as object;

// Recursively freeze a slice's whole reachable graph. A shallow `Object.freeze`
// locks only the top-level record and lets a nested splice (e.g. into
// `s.resilience.calls.k` or `s.authRetry`) slip through silently; freezing the
// whole graph makes ANY nested mutation throw in strict mode, so the
// "verbs never mutate" property genuinely catches deep writes, not just
// top-level reassignment. Mirrors the package's own dev-mode `deepFreeze`.
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      deepFreeze(v);
    }
    Object.freeze(value);
  }
  return value;
}

const okMsg = (key: string, result: string, at = 0): SucceedMsg<string> => ({
  type: "resilient_ok",
  key,
  result,
  at,
});
const errMsg = (key: string, error: unknown, at = 0): FailMsg => ({
  type: "resilient_err",
  key,
  error,
  at,
});

describe("createAuthedCall — init", () => {
  it("composes resilient-call's slice + token-refresh's slice + empty auth bookkeeping", () => {
    const ac = createAuthedCall<string, string>(fullConfig, rngZero);
    const s = ac.init();
    // resilient slice present and at its own init.
    expect(s.resilience.calls).toEqual({});
    expect(s.resilience.circuit).toEqual({ phase: "closed", failures: 0 });
    expect(s.resilience.bucket.tokens).toBe(5);
    // token slice present and at its own init.
    expect(s.auth).toEqual({ token: null, stale: false });
    // auth-retry bookkeeping empty.
    expect(s.authRetry).toEqual({});
    expect(s.pendingAuthRetry).toEqual({});
  });
});

describe("createAuthedCall — delegated resilient verbs", () => {
  it("attempt delegates the gate: emits the run cmd and enters running", () => {
    const ac = createAuthedCall<string, string>(fullConfig, rngZero);
    const [s, cmds] = ac.attempt(ac.init(), "k", "payload", 42);
    expect(cmds).toEqual([
      { type: "resilient_run", key: "k", input: "payload" },
    ]);
    expect(s.resilience.calls.k).toEqual({
      phase: "running",
      input: "payload",
      deadlineAtMs: 5_042,
    });
  });

  it("succeed delegates: closes the breaker, fills cache, settles succeeded", () => {
    const ac = createAuthedCall<string, string>(fullConfig, rngZero);
    let s = ac.init();
    [s] = ac.attempt(s, "k", "in", 0);
    [s] = ac.succeed(s, "k", okMsg("k", "VALUE", 0));
    expect(s.resilience.calls.k).toEqual({
      phase: "succeeded",
      result: "VALUE",
    });
    // Re-attempt before ttl serves the cache (no effect).
    const [, cmds] = ac.attempt(s, "k", "in", 100);
    expect(cmds).toEqual([]);
  });

  it("fail (non-401) delegates: backs off into waiting_retry via the retry policy", () => {
    const ac = createAuthedCall<string, string>(fullConfig, rngZero);
    let s = ac.init();
    [s] = ac.attempt(s, "k", "in", 100);
    [s] = ac.fail(s, "k", errMsg("k", "5xx", 100));
    // rngZero → delay 0 → retryAtMs == at; deadline preserved.
    expect(s.resilience.calls.k).toEqual({
      phase: "waiting_retry",
      input: "in",
      retryAtMs: 100,
      deadlineAtMs: 5_100,
    });
    // The auth dimension is untouched by a generic failure.
    expect(s.auth).toEqual({ token: null, stale: false });
  });

  it("onTimer delegates: the retry timer re-runs the gate for the waiting key", () => {
    const ac = createAuthedCall<string, string>(fullConfig, rngZero);
    let s = ac.init();
    [s] = ac.attempt(s, "k", "in", 0);
    [s] = ac.fail(s, "k", errMsg("k", "e", 0));
    const [s2, cmds] = ac.onTimer(s, {
      type: "deadline_exceeded",
      id: "resilient:retry:k",
      atMs: 0,
    });
    expect(cmds).toEqual([{ type: "resilient_run", key: "k", input: "in" }]);
    expect(s2.resilience.calls.k.phase).toBe("running");
  });

  it("subs are exactly resilient-call's — auth arms no timers", () => {
    const ac = createAuthedCall<string, string>(fullConfig, rngZero);
    let s = ac.init();
    [s] = ac.attempt(s, "k", "in", 100);
    expect(ac.subs(s)).toEqual([deadlineSub("resilient:deadline:k", 5_100)]);
    [s] = ac.fail(s, "k", errMsg("k", "e", 100));
    expect(ac.subs(s)).toEqual([
      deadlineSub("resilient:retry:k", 100),
      deadlineSub("resilient:deadline:k", 5_100),
    ]);
  });
});

describe("createAuthedCall — the 401 dance (refresh → retry once)", () => {
  it("first 401 marks the token stale, emits a refresh, and parks the call", () => {
    const ac = createAuthedCall<string, string>(fullConfig, rngZero);
    let s = ac.init();
    [s] = ac.attempt(s, "k", "in", 0);
    const [s2, cmds] = ac.on401(s, "k", 0);
    expect(cmds).toEqual([refreshTokenCmd()]);
    expect(s2.auth.stale).toBe(true); // token-refresh's on401 fired
    expect(s2.authRetry.k).toBe(1); // one auth-retry spent
    expect(s2.pendingAuthRetry.k).toBe("in"); // input parked for re-issue
    // The resilient call is still running — the 401 did NOT settle it.
    expect(s2.resilience.calls.k.phase).toBe("running");
  });

  it("the refresh landing re-issues the parked call with the new token in hand", () => {
    const ac = createAuthedCall<string, string>(fullConfig, rngZero);
    let s = ac.init();
    [s] = ac.attempt(s, "k", "in", 0);
    [s] = ac.on401(s, "k", 0);
    // Install the freshly minted token, then re-fire parked calls.
    const installed = ac.installToken(s, tok(10_000, "new"));
    expect(installed.auth).toEqual({ token: tok(10_000, "new"), stale: false });
    const [s2, cmds] = ac.onRefreshed(installed, 10);
    // The parked call is re-issued through the resilient gate.
    expect(cmds).toEqual([{ type: "resilient_run", key: "k", input: "in" }]);
    expect(s2.pendingAuthRetry).toEqual({}); // parked set cleared
    expect(s2.authRetry.k).toBe(1); // budget preserved — a 2nd 401 is terminal
  });

  it("a second 401 (budget spent) settles the call FAILED — no second refresh, no loop", () => {
    const ac = createAuthedCall<string, string>(fullConfig, rngZero);
    let s = ac.init();
    [s] = ac.attempt(s, "k", "in", 0);
    [s] = ac.on401(s, "k", 0); // 1st: refresh
    [s] = ac.onRefreshed(ac.installToken(s, tok(10_000, "new")), 10); // re-issue
    // The re-issued call comes back 401 again.
    const [s2, cmds] = ac.on401(s, "k", 20);
    expect(cmds).toEqual([]); // NO second refresh
    // Settled with a plain-data sentinel (NOT a `new Error`), so the slice stays
    // JSON-serializable for a Durable Object reload.
    expect(s2.resilience.calls.k).toEqual({
      phase: "failed",
      error: { _tag: "unauthorized", key: "k" },
    });
    // Auth bookkeeping forgotten on settle.
    expect(s2.authRetry.k).toBeUndefined();
    expect(s2.pendingAuthRetry.k).toBeUndefined();
  });

  it("a 401 on a key with no running call settles failed and refreshes nothing", () => {
    const ac = createAuthedCall<string, string>(fullConfig, rngZero);
    const [s, cmds] = ac.on401(ac.init(), "ghost", 0);
    expect(cmds).toEqual([]);
    expect(s.resilience.calls.ghost).toEqual({
      phase: "failed",
      error: { _tag: "unauthorized", key: "ghost" },
    });
  });

  it("a fresh attempt resets the auth-retry budget so a new call gets its own 401 retry", () => {
    const ac = createAuthedCall<string, string>(fullConfig, rngZero);
    let s = ac.init();
    [s] = ac.attempt(s, "k", "in", 0);
    [s] = ac.on401(s, "k", 0); // budget now 1
    expect(s.authRetry.k).toBe(1);
    // A brand-new attempt for the same key resets the budget.
    [s] = ac.attempt(s, "k", "in2", 100);
    expect(s.authRetry.k).toBeUndefined();
    expect(s.pendingAuthRetry.k).toBeUndefined();
  });

  it("onRefreshed with nothing parked is a no-op (proactive expiry refresh path)", () => {
    const ac = createAuthedCall<string, string>(fullConfig, rngZero);
    const installed = ac.installToken(ac.init(), tok(10_000, "new"));
    const [s, cmds] = ac.onRefreshed(installed, 0);
    expect(cmds).toEqual([]);
    expect(s).toBe(installed); // unchanged by reference — costs nothing
  });

  it("succeed forgets a key's parked 401 input even mid-dance", () => {
    const ac = createAuthedCall<string, string>(fullConfig, rngZero);
    let s = ac.init();
    [s] = ac.attempt(s, "k", "in", 0);
    [s] = ac.on401(s, "k", 0); // parked
    // The original in-flight effect actually came back OK (raced the refresh).
    [s] = ac.succeed(s, "k", okMsg("k", "OK", 0));
    expect(s.resilience.calls.k).toEqual({ phase: "succeeded", result: "OK" });
    expect(s.authRetry.k).toBeUndefined();
    expect(s.pendingAuthRetry.k).toBeUndefined();
  });
});

describe("createAuthedCall — needsRefresh (re-exposed token-refresh verb)", () => {
  it("is true with no token, and opens skewMs ahead of expiry once one is held", () => {
    const ac = createAuthedCall<string, string>(fullConfig, rngZero);
    expect(ac.needsRefresh(ac.init(), 0)).toBe(true); // no token
    const held = ac.installToken(ac.init(), tok(1_000));
    // skewMs 100 → refresh due at >= 900.
    expect(ac.needsRefresh(held, 899)).toBe(false);
    expect(ac.needsRefresh(held, 900)).toBe(true);
  });
});

describe("createAuthedCall — handlers splice both ports", () => {
  it("routes a resolving run port to resilient_ok", async () => {
    const ac = createAuthedCall<string, string>(fullConfig, rngZero);
    const h = ac.handlers({ run: async (input) => `r:${input}`, refresh });
    const msg = await h.resilient_run(
      { type: "resilient_run", key: "k", input: "hi" },
      {} as never,
    );
    expect(msg?.type).toBe("resilient_ok");
    if (msg?.type === "resilient_ok") expect(msg.result).toBe("r:hi");
  });

  it("routes the refresh port to token_refreshed", async () => {
    const minted = tok(9999, "minted");
    const ac = createAuthedCall<string, string>(fullConfig, rngZero);
    const h = ac.handlers({
      run: async () => "x",
      refresh: async () => minted,
    });
    const msg = await h.refresh_token(refreshTokenCmd(), {} as never);
    expect(msg).toEqual(tokenRefreshedMsg(minted));
  });

  it("routes a rejecting refresh port to token_refresh_failed without throwing", async () => {
    const boom = new Error("mint down");
    const ac = createAuthedCall<string, string>(fullConfig, rngZero);
    const h = ac.handlers({
      run: async () => "x",
      refresh: async () => {
        throw boom;
      },
    });
    const msg = await h.refresh_token(refreshTokenCmd(), {} as never);
    expect(msg?.type).toBe("token_refresh_failed");
    if (msg?.type === "token_refresh_failed") expect(msg.error).toBe(boom);
  });
});

describe("createAuthedCall — wired in a machine (replay)", () => {
  const { machine } = makeMachine();
  const bound = bindMachine(machine, ctx);

  it("attempt → 401 → emits run then refresh through the reducer", () => {
    bound.expectCmdSequence(
      {
        msgs: [
          { type: "attempt", key: "k", input: "in", at: 0 },
          { type: "unauthorized", key: "k", at: 0 },
        ],
      },
      [{ type: "resilient_run", key: "k", input: "in" }, refreshTokenCmd()],
    );
  });

  it("attempt → 401 → token_refreshed re-issues the run cmd", () => {
    const { cmds, state } = bound.replay({
      msgs: [
        { type: "attempt", key: "k", input: "in", at: 0 },
        { type: "unauthorized", key: "k", at: 0 },
        { type: "token_refreshed", token: tok(10_000, "new"), at: 10 },
      ],
    });
    // replay accumulates cmds across the whole sequence: the original run, the
    // refresh the 401 asked for, then the re-issued run after the token landed.
    expect(cmds).toEqual([
      { type: "resilient_run", key: "k", input: "in" },
      refreshTokenCmd(),
      { type: "resilient_run", key: "k", input: "in" },
    ]);
    expect(state.authed.auth).toEqual({
      token: tok(10_000, "new"),
      stale: false,
    });
    expect(state.authed.pendingAuthRetry).toEqual({});
  });

  it("the full happy path: attempt → 401 → refresh → re-attempt → ok settles succeeded", () => {
    const { state, subs } = bound.replay({
      msgs: [
        { type: "attempt", key: "k", input: "in", at: 0 },
        { type: "unauthorized", key: "k", at: 0 },
        { type: "token_refreshed", token: tok(10_000, "new"), at: 10 },
        { type: "resilient_ok", key: "k", result: "DONE", at: 20 },
      ],
    });
    expect(state.authed.resilience.calls.k).toEqual({
      phase: "succeeded",
      result: "DONE",
    });
    expect(state.authed.authRetry).toEqual({});
    expect(subs).toEqual([]); // settled → no timers
  });
});

// ---------------------------------------------------------------------------
// Properties — invariants over arbitrary verb sequences.
// ---------------------------------------------------------------------------

describe("createAuthedCall — properties", () => {
  it("verbs never mutate their input state (immutability, deep)", () => {
    const ac = createAuthedCall<string, string>(fullConfig, rngZero);
    fc.assert(
      fc.property(fc.nat(100_000), fc.string(), (at, input) => {
        // Deep-freeze EVERY input handed to a verb (not just the init slice, not
        // just its top level). With the whole reachable graph frozen, a verb
        // that splices a nested field in place — `resilience.calls`,
        // `authRetry`, `pendingAuthRetry` — throws in strict mode instead of
        // silently passing. Returning a NEW state is the only way through.
        const s0 = deepFreeze(ac.init());

        const [s1] = ac.attempt(s0, "k", input, at);
        deepFreeze(s1);
        expect(s1).not.toBe(s0);

        // First 401: parks the call and bumps the per-key auth-retry budget —
        // exercises a nested write into `authRetry`/`pendingAuthRetry`.
        const [s2] = ac.on401(s1, "k", at);
        deepFreeze(s2);
        expect(s2).not.toBe(s1);

        // A transient failure from the running state backs the call off into
        // `waiting_retry` — exercises a nested write into `resilience.calls`.
        const [s3] = ac.fail(s1, "k", errMsg("k", "5xx", at));
        deepFreeze(s3);
        expect(s3).not.toBe(s1);

        // The refresh landing re-issues the parked call through the gate —
        // exercises clearing `pendingAuthRetry` and re-writing `resilience`.
        const [s4] = ac.onRefreshed(
          ac.installToken(s2, tok(1_000_000, "t")),
          at,
        );
        deepFreeze(s4);
        expect(s4).not.toBe(s2);

        // A retry timer firing re-runs the gate and settles auth bookkeeping.
        const [s5] = ac.onTimer(s3, {
          type: "deadline_exceeded",
          id: "resilient:retry:k",
          atMs: at,
        });
        deepFreeze(s5);
        expect(s5).not.toBe(s3);

        // Success settles the call and forgets its auth bookkeeping.
        const [s6] = ac.succeed(s1, "k", okMsg("k", input, at));
        expect(s6).not.toBe(s1);

        return true;
      }),
    );
  });

  it("at most one auth-retry per call: a key is re-issued by a refresh at most once", () => {
    const ac = createAuthedCall<string, string>(fullConfig, rngZero);
    type Action =
      | { kind: "attempt"; key: string; at: number }
      | { kind: "401"; key: string; at: number }
      | { kind: "refreshed"; at: number };
    const action = fc.oneof(
      fc.record({
        kind: fc.constant("attempt" as const),
        key: fc.constantFrom("a", "b"),
        at: fc.nat(20_000),
      }),
      fc.record({
        kind: fc.constant("401" as const),
        key: fc.constantFrom("a", "b"),
        at: fc.nat(20_000),
      }),
      fc.record({
        kind: fc.constant("refreshed" as const),
        at: fc.nat(20_000),
      }),
    );
    fc.assert(
      fc.property(fc.array(action, { maxLength: 40 }), (actions: Action[]) => {
        let s = ac.init();
        for (const a of actions) {
          switch (a.kind) {
            case "attempt":
              [s] = ac.attempt(s, a.key, "in", a.at);
              break;
            case "401":
              [s] = ac.on401(s, a.key, a.at);
              break;
            case "refreshed":
              [s] = ac.onRefreshed(
                ac.installToken(s, tok(1_000_000, "t")),
                a.at,
              );
              break;
          }
          // The auth-retry budget per key is never more than 1 — the dance is
          // capped at a single refresh+retry per logical call.
          for (const count of Object.values(s.authRetry)) {
            if (count > 1) return false;
          }
        }
        return true;
      }),
    );
  });

  it("DURABILITY: every reachable slice round-trips through JSON — terminal slices included", () => {
    // The package-wide invariant: a slice persisted into a `Store<S>` and
    // reloaded after a Durable Object eviction must come back IDENTICAL. That
    // holds iff the slice is pure plain data — no `Error` objects (round-trip to
    // `{}`, losing the tag), no `undefined` fields (dropped by JSON), no
    // closures. This module carries its share: drive arbitrary verb sequences
    // (including the 401 dance that settles a call with the `{_tag}` sentinel,
    // and the success/timer paths that settle TERMINAL `succeeded`/`failed`
    // calls) and assert the WHOLE slice — not just one call — round-trips equal
    // at EVERY step, so every reachable TERMINAL slice is covered.
    const ac = createAuthedCall<string, string>(fullConfig, rngZero);
    type Action =
      | { kind: "attempt"; key: string; at: number }
      | { kind: "401"; key: string; at: number }
      | { kind: "ok"; key: string; at: number }
      | { kind: "fail"; key: string; at: number }
      | { kind: "refreshed"; at: number }
      | { kind: "timer"; key: string; at: number };
    const action = fc.oneof(
      fc.record({
        kind: fc.constant("attempt" as const),
        key: fc.constantFrom("a", "b"),
        at: fc.nat(20_000),
      }),
      fc.record({
        kind: fc.constant("401" as const),
        key: fc.constantFrom("a", "b"),
        at: fc.nat(20_000),
      }),
      fc.record({
        kind: fc.constant("ok" as const),
        key: fc.constantFrom("a", "b"),
        at: fc.nat(20_000),
      }),
      fc.record({
        kind: fc.constant("fail" as const),
        key: fc.constantFrom("a", "b"),
        at: fc.nat(20_000),
      }),
      fc.record({
        kind: fc.constant("refreshed" as const),
        at: fc.nat(20_000),
      }),
      fc.record({
        kind: fc.constant("timer" as const),
        key: fc.constantFrom("a", "b"),
        at: fc.nat(20_000),
      }),
    );
    // Drive a call all the way to a TERMINAL phase so the property is not
    // satisfied vacuously by only-in-flight states: a settled call's slice is
    // what actually gets persisted between requests.
    const sawTerminal = { value: false };
    fc.assert(
      fc.property(fc.array(action, { maxLength: 50 }), (actions: Action[]) => {
        let s = ac.init();
        const assertRoundTrips = (slice: AuthedState<string, string>) => {
          const roundTripped = JSON.parse(JSON.stringify(slice));
          expect(roundTripped).toEqual(slice);
          for (const call of Object.values(slice.resilience.calls)) {
            if (call.phase === "succeeded" || call.phase === "failed") {
              sawTerminal.value = true;
            }
          }
        };
        assertRoundTrips(s);
        for (const a of actions) {
          switch (a.kind) {
            case "attempt":
              [s] = ac.attempt(s, a.key, "in", a.at);
              break;
            case "401":
              [s] = ac.on401(s, a.key, a.at);
              break;
            case "ok":
              [s] = ac.succeed(s, a.key, okMsg(a.key, "VALUE", a.at));
              break;
            case "fail":
              [s] = ac.fail(s, a.key, errMsg(a.key, { _tag: "5xx" }, a.at));
              break;
            case "refreshed":
              [s] = ac.onRefreshed(
                ac.installToken(s, tok(1_000_000, "t")),
                a.at,
              );
              break;
            case "timer":
              [s] = ac.onTimer(s, {
                type: "deadline_exceeded",
                id: `resilient:retry:${a.key}`,
                atMs: a.at,
              });
              break;
          }
          assertRoundTrips(s);
        }
        return true;
      }),
    );
    // The property is meaningful only if it actually visited terminal slices.
    expect(sawTerminal.value).toBe(true);
  });

  it("replay is deterministic: the same msg sequence yields the same final state", () => {
    const { machine } = makeMachine();
    const msgArb = fc.array(
      fc.oneof(
        fc.record({
          type: fc.constant("attempt" as const),
          key: fc.constantFrom("a", "b"),
          input: fc.constant("in"),
          at: fc.nat(10_000),
        }),
        fc.record({
          type: fc.constant("unauthorized" as const),
          key: fc.constantFrom("a", "b"),
          at: fc.nat(10_000),
        }),
        fc.record({
          type: fc.constant("token_refreshed" as const),
          token: fc.constant(tok(1_000_000, "t")),
          at: fc.nat(10_000),
        }),
      ),
      { maxLength: 25 },
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
});

// ===========================================================================
// THE SYSTEMIC ROOT TEST that was missing.
//
// Every block above hand-feeds Msgs through the reducers (or `replay`, which
// does NOT run `interpret`) and asserts the Cmds those exact Msgs emit. That is
// precisely why the breaker-pollution + dropped-refresh bugs shipped green:
// nobody ran the REAL dispatch lifecycle end to end — through `interpret`
// re-entry of BOTH ports (the run port AND the refresh port) — and asserted the
// END STATE of the SHARED circuit breaker after a 401.
//
// Here we build an actual `run()` Runtime from the knob's verbs + handlers. The
// `run` port and the `refresh` port are both wired into `interpret`, so a
// backend outcome RE-ENTERS the machine exactly as production does:
//
//   attempt → (Cmd) resilient_run → run port → (follow-up Msg) resilient_ok
//                                              / unauthorized→on401
//   on401   → (Cmd) refresh_token  → refresh port → (follow-up Msg)
//                                                    token_refreshed → re-issue
//
// We drive a two-key scenario over ONE shared breaker (threshold 1) and assert
// the breaker is still CLOSED after key "a" exhausts its 401 budget and settles
// failed — proving the terminal 401 went through `settleFailed`, not `fail`.
//
// Pre-fix (terminal 401 routed through rc.fail → onFailure): key "a"'s terminal
// 401 trips the SHARED breaker open. The follow-up attempt on the healthy key
// "b" then fast-fails into `circuit_open`, never reaching the backend. The END
// STATE assertions below FAIL against the buggy code and PASS after the fix.
// ===========================================================================

describe("createAuthedCall — wired end-to-end: a terminal 401 must not pollute the shared breaker (defects 1-3)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The wired host: input string, result string. Drives the real verbs through
  // a real runtime. `at` is supplied off a ctx clock box at the boundary so the
  // reducer stays pure (it reads `at` off the Msg / a stamped value).
  interface WState {
    readonly authed: AuthedState<string, string>;
  }
  // The 401 trigger the run port emits when the backend rejects a credential. It
  // re-enters as a follow-up Msg and is folded by on401 — exactly the production
  // path (the run port distinguishes a 401 from a generic 5xx).
  type WMsg =
    | { type: "attempt"; key: string; input: string; at: number }
    | { type: "unauthorized"; key: string; at: number }
    | { type: "nop" }
    | SucceedMsg<string>
    | FailMsg
    | TokenRefreshMsg
    | ResilientTimerMsg;
  type WCmd = RunCmd<string> | RefreshTokenCmd;

  // The downstream ports. `outcomes` is a per-key queue the run port pops: each
  // call returns "ok", throws a generic failure ("fail"), or signals a 401
  // ("401"). `calls` records which keys the backend was actually reached for —
  // ground truth for "did this attempt reach the backend or get fast-failed by
  // the breaker". `now` is the clock the interpret boundary stamps.
  interface WCtx {
    outcomes: Record<string, ("ok" | "fail" | "401")[]>;
    readonly reached: string[];
    readonly now: { value: number };
  }

  // A run port that distinguishes a 401 from a generic failure. On "401" it
  // returns a sentinel result the reducer turns into an `unauthorized` Msg —
  // modelling a guard that inspects the HTTP status. Throwing on "401" would
  // route to resilient_err (a generic failure), which is exactly NOT the 401
  // path; instead we surface it as a tagged OK value and let the host fork.
  const RUN_401 = "__401__";

  function wiredMachine(ctx: WCtx, breakerThreshold = 1) {
    const ac = createAuthedCall<string, string>(
      {
        refresh,
        // ONE shared breaker. Threshold is a knob per scenario: 1 for the
        // breaker-pollution test (a single `fail` opens it, so we can SEE a
        // terminal 401 must NOT call `fail`); higher for the waiting_retry test
        // (a generic failure backs off WITHOUT opening the breaker, isolating
        // the dropped-refresh defect from breaker behaviour).
        circuit: { threshold: breakerThreshold, cooldownMs: 1_000_000 },
        retry: {
          baseMs: 100,
          factor: 2,
          capMs: 10_000,
          maxAttempts: 3,
          jitter: "full" as const,
        },
      },
      rngZero,
    );
    return defineMachine<WState, WMsg, WCmd, never, WCtx>({
      init: (loaded) =>
        loaded !== null ? [loaded, []] : [{ authed: ac.init() }, []],
      update: {
        attempt: (s, m) => {
          const [slice, cmds] = ac.attempt(s.authed, m.key, m.input, m.at);
          return [{ authed: slice }, cmds];
        },
        // The run port resolved with the 401 sentinel → fork to on401, the real
        // production path for a credential rejection.
        resilient_ok: (s, m) => {
          if (m.result === RUN_401) {
            const [slice, cmds] = ac.on401(s.authed, m.key, m.at);
            return [{ authed: slice }, cmds];
          }
          const [slice, cmds] = ac.succeed(s.authed, m.key, m);
          return [{ authed: slice }, cmds];
        },
        resilient_err: (s, m) => {
          const [slice, cmds] = ac.fail(s.authed, m.key, m);
          return [{ authed: slice }, cmds];
        },
        unauthorized: (s, m) => {
          const [slice, cmds] = ac.on401(s.authed, m.key, m.at);
          return [{ authed: slice }, cmds];
        },
        token_refreshed: (s, m) => {
          const [slice, cmds] = ac.onRefreshed(
            ac.installToken(s.authed, m.token),
            ctx.now.value,
          );
          return [{ authed: slice }, cmds];
        },
        token_refresh_failed: (s) => [s, []],
        deadline_exceeded: (s, m) => {
          const [slice, cmds] = ac.onTimer(s.authed, m);
          return [{ authed: slice }, cmds];
        },
        nop: (s) => [s, []],
      },
      // The REAL handlers — both ports spliced. The run port re-enters via
      // resilient_ok / resilient_err; the refresh port re-enters via
      // token_refreshed / token_refresh_failed.
      interpret: ac.handlers({
        run: async (_input, key) => {
          const queue = ctx.outcomes[key] ?? [];
          const outcome = queue.shift() ?? "ok";
          ctx.reached.push(key);
          if (outcome === "fail") throw { _tag: "backend_down" };
          if (outcome === "401") return RUN_401;
          return "VALUE";
        },
        refresh,
      }),
    });
  }

  // Drain the re-entrant follow-up chain: each `await dispatch` settles only its
  // own transition; the follow-up Msg interpret returns is enqueued on the tail.
  // Pump `nop` until the backend-reached ledger stops moving — same pattern the
  // resilient-call wired test uses.
  async function drain(runtime: {
    dispatch(m: WMsg): Promise<void>;
  }): Promise<void> {
    // Capture the ledger length via a closure on the shared ctx through nops.
    let guard = 0;
    let stable = 0;
    let prev = -1;
    while (guard++ < 100 && stable < 2) {
      await runtime.dispatch({ type: "nop" });
      const len = drainLedger();
      if (len === prev) stable += 1;
      else stable = 0;
      prev = len;
    }
  }
  // Set per-test so `drain` reads the live ledger length.
  let drainLedger: () => number = () => 0;

  it("a 401 a refresh cannot fix settles key 'a' failed WITHOUT tripping the shared breaker — the healthy key 'b' still reaches the backend", async () => {
    const ctx: WCtx = {
      // Key "a": first call 401 → refresh → re-issued call 401 again (budget
      // spent → terminal). Key "b": a clean OK.
      outcomes: { a: ["401", "401"], b: ["ok"] },
      reached: [],
      now: { value: 0 },
    };
    drainLedger = () => ctx.reached.length;
    vi.spyOn(Date, "now").mockImplementation(() => ctx.now.value);

    const machine = wiredMachine(ctx);
    const runtime = run(machine, { ctx });
    await runtime.ready;

    // (1) attempt key "a" — reaches the backend, comes back 401, parks + asks
    // for a refresh; the refresh port re-enters with a fresh token and re-issues
    // "a", which comes back 401 AGAIN → budget spent → terminal settle failed.
    await runtime.dispatch({ type: "attempt", key: "a", input: "in", at: 0 });
    await drain(runtime);

    // DEFECT 1 — the systemic assertion FIRST: the SHARED breaker is still
    // CLOSED. The terminal 401 went through `settleFailed`, which never calls
    // `onFailure`. Pre-fix it went through `rc.fail` → `onFailure`, tripping the
    // threshold-1 breaker open. This is the root claim of the whole fix.
    expect(runtime.getState().authed.resilience.circuit).toEqual({
      phase: "closed",
      failures: 0,
    });

    // DEFECT 3 — key "a" settled failed with the plain-data sentinel: NOT a
    // `new Error`, so the slice round-trips through JSON for a DO reload.
    expect(runtime.getState().authed.resilience.calls.a).toEqual({
      phase: "failed",
      error: { _tag: "unauthorized", key: "a" },
    });
    // The slice is genuinely JSON-serializable — a `new Error` would round-trip
    // to `{}` and lose the tag.
    const roundTripped = JSON.parse(
      JSON.stringify(runtime.getState().authed.resilience.calls.a),
    );
    expect(roundTripped).toEqual({
      phase: "failed",
      error: { _tag: "unauthorized", key: "a" },
    });

    // (2) the consequence a consumer actually feels: a healthy key "b" attempt
    // must reach the backend and SUCCEED. Pre-fix the breaker was open, so this
    // attempt fast-fails into `circuit_open` and the backend is never reached.
    const reachedBeforeB = ctx.reached.length;
    await runtime.dispatch({ type: "attempt", key: "b", input: "in", at: 10 });
    await drain(runtime);

    expect(runtime.getState().authed.resilience.calls.b).toEqual({
      phase: "succeeded",
      result: "VALUE",
    });
    // The backend was actually reached for "b" (not fast-failed by a polluted
    // breaker).
    expect(ctx.reached.length).toBeGreaterThan(reachedBeforeB);
    expect(ctx.reached).toContain("b");

    await runtime.stop();
  });

  it("a 401 that arrives while the call is in waiting_retry still triggers a refresh + re-issue (defect 2)", async () => {
    const ctx: WCtx = {
      // Key "a": a generic failure first (→ backs off into waiting_retry), then
      // the re-issue after refresh succeeds.
      outcomes: { a: ["fail", "ok"] },
      reached: [],
      now: { value: 0 },
    };
    drainLedger = () => ctx.reached.length;
    vi.spyOn(Date, "now").mockImplementation(() => ctx.now.value);

    // Breaker threshold 5 → the single generic failure does NOT open the
    // breaker, so the re-issue after refresh can reach the backend. This test is
    // about the dropped refresh, not the breaker.
    const machine = wiredMachine(ctx, 5);
    const runtime = run(machine, { ctx });
    await runtime.ready;

    // (1) attempt "a" — backend FAILS generically → retry brick backs it off
    // into waiting_retry (NOT running). The breaker (threshold 5) does NOT trip.
    await runtime.dispatch({ type: "attempt", key: "a", input: "in", at: 0 });
    await drain(runtime);
    expect(runtime.getState().authed.resilience.calls.a.phase).toBe(
      "waiting_retry",
    );

    // (2) a 401 arrives for "a" while it is parked in waiting_retry. Pre-fix
    // (input read only from `phase === "running"`) this 401 finds input ===
    // undefined and settles the call FAILED with no refresh — the dropped
    // refresh. Post-fix the waiting_retry input is read, so the 401 marks the
    // token stale, emits a refresh, and parks the call.
    ctx.now.value = 5;
    await runtime.dispatch({ type: "unauthorized", key: "a", at: 5 });
    await drain(runtime);

    // DEFECT 2 — the refresh fired (the token landed fresh and not stale) and
    // the call was parked, NOT settled failed. After the refresh re-enters and
    // re-issues, the re-issued call succeeds.
    expect(runtime.getState().authed.auth).toEqual({
      token: tok(10_000, "fresh"),
      stale: false,
    });
    expect(runtime.getState().authed.resilience.calls.a).toEqual({
      phase: "succeeded",
      result: "VALUE",
    });
    // Backend was reached twice: the original failing call + the re-issued call.
    expect(ctx.reached).toEqual(["a", "a"]);

    await runtime.stop();
  });
});
