import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  createTokenRefresh,
  initTokenRefresh,
  refreshTokenCmd,
  type Token,
  type TokenState,
  tokenRefreshedMsg,
  tokenRefreshFailedMsg,
} from "./index";

// A token expiring at t=1000. Reused across the timing assertions so the skew
// math is observable against a fixed deadline.
const tok = (expiresAt: number, value = "abc"): Token => ({ value, expiresAt });

// No-skew knob: needsRefresh triggers exactly at the hard expiry, so the
// timing assertions test the raw `at >= expiresAt` edge.
const noSkew = createTokenRefresh();
// Refresh-ahead knob: opens the refresh window `skewMs` before expiry.
const skewed = createTokenRefresh({ skewMs: 100 });
// Over-large skew: skewMs > expiresAt drives the skewed trigger negative, so a
// freshly minted token is already due — exercises the negative-trigger branch.
const skewMega = createTokenRefresh({ skewMs: 500 });

describe("initTokenRefresh", () => {
  it("starts with no token and not stale", () => {
    expect(initTokenRefresh()).toEqual({ token: null, stale: false });
  });

  it("is the same slice the knob's init returns", () => {
    expect(createTokenRefresh().init()).toEqual(initTokenRefresh());
  });
});

describe("needsRefresh — the three reasons to refresh", () => {
  it("is true when no token is held, at any time", () => {
    const s = initTokenRefresh();
    expect(noSkew.needsRefresh(s, 0)).toBe(true);
    expect(noSkew.needsRefresh(s, 1_000_000)).toBe(true);
  });

  it("is true when the token is marked stale, even before expiry", () => {
    const s: TokenState = { token: tok(1000), stale: true };
    // at=500 is well before expiry=1000, yet the 401 flag forces a refresh.
    expect(noSkew.needsRefresh(s, 500)).toBe(true);
  });

  it("(no skew) flips to true exactly at expiry — half-open edge", () => {
    const s: TokenState = { token: tok(1000), stale: false };
    expect(noSkew.needsRefresh(s, 999)).toBe(false);
    expect(noSkew.needsRefresh(s, 1000)).toBe(true); // `at >= expiresAt`
    expect(noSkew.needsRefresh(s, 1001)).toBe(true);
  });

  it("(skew) opens the refresh window skewMs ahead of expiry", () => {
    const s: TokenState = { token: tok(1000), stale: false };
    // skewMs=100 → refresh due at >= 900.
    expect(skewed.needsRefresh(s, 899)).toBe(false);
    expect(skewed.needsRefresh(s, 900)).toBe(true);
  });
});

describe("on401 — reactive staleness", () => {
  it("marks a fresh token stale without touching its value or expiry", () => {
    const before: TokenState = { token: tok(1000, "secret"), stale: false };
    const after = noSkew.on401(before);
    expect(after.stale).toBe(true);
    expect(after.token).toEqual(tok(1000, "secret"));
  });

  it("does not mutate its input", () => {
    const before = Object.freeze<TokenState>({
      token: tok(1000),
      stale: false,
    });
    const after = noSkew.on401(before);
    expect(after).not.toBe(before);
    expect(before.stale).toBe(false); // input untouched
  });

  it("is idempotent — a second 401 returns the same shape", () => {
    const once = noSkew.on401({ token: tok(1000), stale: false });
    const twice = noSkew.on401(once);
    expect(twice).toEqual(once);
  });
});

describe("refreshed — installing a new credential", () => {
  it("replaces the token and clears stale", () => {
    const before: TokenState = { token: tok(1000, "old"), stale: true };
    const after = noSkew.refreshed(before, tok(5000, "new"));
    expect(after).toEqual({ token: tok(5000, "new"), stale: false });
  });

  it("does not mutate its input", () => {
    const before = Object.freeze<TokenState>({ token: null, stale: true });
    const after = noSkew.refreshed(before, tok(5000));
    expect(after).not.toBe(before);
    expect(before.token).toBeNull();
  });

  it("makes needsRefresh false for any time below the new skewed expiry", () => {
    const after = skewed.refreshed(initTokenRefresh(), tok(5000));
    // new expiry 5000, skew 100 → fresh until 4900.
    expect(skewed.needsRefresh(after, 4899)).toBe(false);
    expect(skewed.needsRefresh(after, 4900)).toBe(true);
  });
});

describe("ensureFresh — the call-boundary verb", () => {
  it("emits a single refresh_token Cmd when a refresh is due", () => {
    const [next, cmds] = noSkew.ensureFresh(initTokenRefresh(), 0);
    expect(cmds).toEqual([refreshTokenCmd()]);
    // Slice unchanged — the refresh lands later via `refreshed`.
    expect(next).toEqual(initTokenRefresh());
  });

  it("emits no Cmd when the held token is still fresh", () => {
    const s: TokenState = { token: tok(1000), stale: false };
    const [next, cmds] = noSkew.ensureFresh(s, 500);
    expect(cmds).toEqual([]);
    expect(next).toBe(s); // returned unchanged by reference
  });

  it("emits a refresh_token Cmd after a 401, even with time to spare", () => {
    const s = noSkew.on401({ token: tok(1000), stale: false });
    const [, cmds] = noSkew.ensureFresh(s, 0);
    expect(cmds).toEqual([refreshTokenCmd()]);
  });
});

describe("config — skewMs clamping", () => {
  it("defaults skew to 0 (refresh exactly at expiry)", () => {
    const s: TokenState = { token: tok(1000), stale: false };
    expect(createTokenRefresh().needsRefresh(s, 999)).toBe(false);
    expect(createTokenRefresh().needsRefresh(s, 1000)).toBe(true);
  });

  it("clamps a negative skew to 0 (a skew past expiry is meaningless)", () => {
    const negative = createTokenRefresh({ skewMs: -500 });
    const s: TokenState = { token: tok(1000), stale: false };
    // Negative skew clamped → behaves like skew 0, NOT like expiry+500.
    expect(negative.needsRefresh(s, 999)).toBe(false);
    expect(negative.needsRefresh(s, 1000)).toBe(true);
  });

  it("clamps a NaN skew to 0 (a miswired config never poisons the comparison)", () => {
    const nan = createTokenRefresh({ skewMs: Number.NaN });
    const s: TokenState = { token: tok(1000), stale: false };
    // NaN > 0 is false → skew collapses to 0. If NaN leaked into the trigger,
    // `at >= expiresAt - NaN` would be `at >= NaN` → always false → fresh
    // forever; the clamp keeps needsRefresh total and behaving like skew 0.
    expect(nan.needsRefresh(s, 999)).toBe(false);
    expect(nan.needsRefresh(s, 1000)).toBe(true);
  });

  it("clamps an Infinity skew to itself (positive skew, refreshes immediately)", () => {
    // +Infinity > 0 is true, so it is NOT clamped — a huge skew legitimately
    // pulls the refresh-ahead window arbitrarily early. expiresAt - Infinity is
    // -Infinity, so `at >= -Infinity` is true for every finite `at`.
    const inf = createTokenRefresh({ skewMs: Number.POSITIVE_INFINITY });
    const s: TokenState = { token: tok(1000), stale: false };
    expect(inf.needsRefresh(s, 0)).toBe(true);
  });
});

describe("needsRefresh — non-finite expiry fails safe toward refreshing", () => {
  it("treats a NaN expiry as needing a refresh, not fresh-forever", () => {
    const s: TokenState = { token: tok(Number.NaN), stale: false };
    // `at >= NaN` is false; the guard overrides it so a broken expiry mints.
    expect(noSkew.needsRefresh(s, 0)).toBe(true);
    expect(noSkew.needsRefresh(s, 1_000_000)).toBe(true);
    // A skew knob must reach the same verdict — the guard precedes the skew math.
    expect(skewed.needsRefresh(s, 0)).toBe(true);
  });

  it("treats a +Infinity expiry as needing a refresh, not fresh-forever", () => {
    const s: TokenState = {
      token: tok(Number.POSITIVE_INFINITY),
      stale: false,
    };
    // `at >= Infinity - skewMs` is `at >= Infinity` → false; guard overrides it.
    expect(noSkew.needsRefresh(s, 0)).toBe(true);
    expect(skewed.needsRefresh(s, 1_000_000)).toBe(true);
  });

  it("treats a -Infinity expiry as needing a refresh", () => {
    // `at >= -Infinity` is already true, but the guard makes the intent explicit
    // and uniform across all non-finite expiries.
    const s: TokenState = {
      token: tok(Number.NEGATIVE_INFINITY),
      stale: false,
    };
    expect(noSkew.needsRefresh(s, 0)).toBe(true);
  });
});

describe("needsRefresh — negative skewed-expiry trigger", () => {
  it("is due at at=0 when the skewed trigger went negative", () => {
    // expiresAt 100, skewMs 500 → trigger = 100 - 500 = -400. Any real epoch
    // `at` (>= 0) is >= -400, so the token is due from the very first call.
    const s: TokenState = { token: tok(100), stale: false };
    expect(skewMega.needsRefresh(s, 0)).toBe(true);
    expect(skewMega.needsRefresh(s, 50)).toBe(true);
  });

  it("a zero expiry with skew is due immediately (trigger = -skewMs)", () => {
    const s: TokenState = { token: tok(0), stale: false };
    // trigger = 0 - 500 = -500; at=0 >= -500 → due.
    expect(skewMega.needsRefresh(s, 0)).toBe(true);
  });
});

describe("handlers — the refresh port splice", () => {
  it("routes a resolved port to a token_refreshed Msg", async () => {
    const minted = tok(9999, "minted");
    const tr = createTokenRefresh();
    const interpret = tr.handlers({ refresh: async () => minted });

    const msg = await interpret.refresh_token(refreshTokenCmd(), {});
    expect(msg).toEqual(tokenRefreshedMsg(minted));
  });

  it("routes a rejected port to a token_refresh_failed Msg without throwing", async () => {
    const boom = new Error("mint failed");
    const tr = createTokenRefresh();
    const interpret = tr.handlers({
      refresh: async () => {
        throw boom;
      },
    });

    // tryInterpret never rejects — the rejection becomes a Msg (errors are data).
    const msg = await interpret.refresh_token(refreshTokenCmd(), {});
    expect(msg).toEqual(tokenRefreshFailedMsg(boom));
  });

  it("preserves the original error identity for instanceof checks in onErr", async () => {
    class AuthError extends Error {}
    const err = new AuthError("nope");
    const tr = createTokenRefresh();
    const interpret = tr.handlers({
      refresh: async () => {
        throw err;
      },
    });

    const msg = await interpret.refresh_token(refreshTokenCmd(), {});
    expect(msg.type).toBe("token_refresh_failed");
    if (msg.type === "token_refresh_failed") {
      expect(msg.error).toBe(err); // same reference, not wrapped
    }
  });
});

describe("property: refreshed → fresh, then on401 → stale (the full cycle)", () => {
  it("after refreshed the token is fresh until skewed expiry; on401 re-arms refresh", () => {
    const skewArb = fc.integer({ min: 0, max: 10_000 });
    const expiryArb = fc.integer({ min: 0, max: 1_000_000 });

    fc.assert(
      fc.property(skewArb, expiryArb, (skewMs, expiresAt) => {
        const tr = createTokenRefresh({ skewMs });
        const fresh = tr.refreshed(initTokenRefresh(), tok(expiresAt, "v"));

        // Just-installed credential is not stale.
        expect(fresh.stale).toBe(false);

        // The refresh trigger is exactly the skewed expiry. Below it: fresh.
        const trigger = expiresAt - skewMs;
        if (trigger - 1 >= 0) {
          expect(tr.needsRefresh(fresh, trigger - 1)).toBe(false);
        }
        // At/after the trigger: due. (Guard against negative `at`, which is
        // never a real epoch reading.)
        if (trigger >= 0) {
          expect(tr.needsRefresh(fresh, trigger)).toBe(true);
        }

        // A 401 forces a refresh at ANY time, regardless of the skewed window.
        const rejected = tr.on401(fresh);
        expect(tr.needsRefresh(rejected, 0)).toBe(true);
      }),
    );
  });
});

describe("property: needsRefresh ⇔ ensureFresh emits a Cmd", () => {
  it("ensureFresh emits exactly one refresh_token Cmd iff needsRefresh is true", () => {
    const tokenArb = fc.option(
      fc.record({
        value: fc.string(),
        expiresAt: fc.integer({ min: 0, max: 1_000_000 }),
      }),
      { nil: null },
    );
    const stateArb: fc.Arbitrary<TokenState> = fc.record({
      token: tokenArb,
      stale: fc.boolean(),
    });

    fc.assert(
      fc.property(
        stateArb,
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 5_000 }),
        (state, at, skewMs) => {
          const tr = createTokenRefresh({ skewMs });
          const due = tr.needsRefresh(state, at);
          const [next, cmds] = tr.ensureFresh(state, at);
          // The slice is always returned unchanged by ensureFresh.
          expect(next).toBe(state);
          // Cmd emission is exactly the needsRefresh decision.
          expect(cmds).toEqual(due ? [refreshTokenCmd()] : []);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// DURABILITY GUARD (package-wide invariant, token-refresh's share).
//
// Every reachable slice of THIS knob is terminal — there is no in-flight phase;
// `TokenState` is `{ token: Token | null; stale: boolean }`, a settled record
// the consumer persists into their `Store<S>`. The reachable shapes are exactly
// those the verbs produce: `init` (no token, not stale), `on401` (sets stale),
// and `refreshed` (installs a token, clears stale). The invariant: after ANY
// sequence of verbs, `JSON.parse(JSON.stringify(slice))` must deep-equal the
// slice — otherwise the persisted slice would diverge from the in-memory one
// across a Durable Object eviction / page reload, and a rehydrated machine
// would lose track of which token it holds. This guards that the slice carries
// only plain JSON data: no `undefined`, no function/closure, no `new Error(...)`
// smuggled onto a field.
// ---------------------------------------------------------------------------
describe("durability — every reachable terminal slice round-trips through JSON", () => {
  type Verb =
    | { readonly kind: "on401" }
    | { readonly kind: "refreshed"; readonly token: Token };

  // A durable token carries a FINITE expiry — the shape a healthy issuer
  // produces. Non-finite expiries (NaN/±Infinity) are a corruption JSON cannot
  // represent (it coerces them to `null`); they are guarded at READ time by
  // `needsRefresh` (fail-safe → refresh), never asserted to survive a round
  // trip. The durability invariant covers the genuinely persistable domain.
  const tokenArb: fc.Arbitrary<Token> = fc.record({
    value: fc.string(),
    expiresAt: fc.double({ min: -1_000_000, max: 1_000_000, noNaN: true }),
  });

  const verbArb: fc.Arbitrary<Verb> = fc.oneof(
    fc.constant<Verb>({ kind: "on401" }),
    tokenArb.map<Verb>((token) => ({ kind: "refreshed", token })),
  );

  it("JSON.parse(JSON.stringify(slice)) deep-equals slice after any verb path", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5_000 }),
        fc.array(verbArb, { maxLength: 12 }),
        (skewMs, verbs) => {
          const tr = createTokenRefresh({ skewMs });
          let slice: TokenState = tr.init();

          // The init slice is itself a reachable terminal slice.
          expect(JSON.parse(JSON.stringify(slice))).toEqual(slice);

          for (const verb of verbs) {
            slice =
              verb.kind === "on401"
                ? tr.on401(slice)
                : tr.refreshed(slice, verb.token);
            // After EVERY verb the whole slice must round-trip equal.
            const roundTripped: TokenState = JSON.parse(JSON.stringify(slice));
            expect(roundTripped).toEqual(slice);
          }
          return true;
        },
      ),
    );
  });
});
