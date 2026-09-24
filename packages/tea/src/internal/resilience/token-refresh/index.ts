/**
 * internal/resilience/token-refresh — a credential's lifecycle as pure state + verbs,
 * with the actual token fetch deferred to a single injected port.
 *
 * This is the L1 brick `authed-call` (#10 in the composition specs) stacks on:
 * a token slice `{ token, stale }` plus pure transitions that decide *when* a
 * credential must be re-minted, and one `Cmd.define`d Cmd (`refresh_token`)
 * that asks for the re-mint. You write that Cmd's handler in your engine's
 * style (ADR 0021); the knob ships no I/O.
 *
 * It is a LEAF module in the same mold as `@demlik/tea/retry-backoff`: it
 * depends only on the core (`../index`), never on a sibling brick. The two
 * non-negotiables of every knob hold here by construction:
 *
 *   - **Durable** — the token slice is plain JSON-serializable data, so it
 *     survives a Durable Object eviction / page reload. A rehydrated machine
 *     resumes knowing exactly which token it holds and whether it is stale.
 *   - **Replayable** — every transition is a pure verb returning
 *     `readonly [State, Cmd[]]`. No verb reads the wall clock or performs I/O,
 *     so `replay` reconstructs the slice exactly. Time enters ONLY as an `at`
 *     parameter the caller stamps; the network fetch enters ONLY in the
 *     `refresh_token` handler you write. This keeps the substrate's purity invariants intact
 *     (invariant 2: pure transitions; invariant 4: I/O is an effect, not a
 *     reducer body).
 *
 * ## The staleness model — two independent reasons to refresh
 *
 * A token becomes unusable for two unrelated reasons, and the slice tracks both
 * without conflating them:
 *
 *   1. **Expiry** — the token has a known `expiresAt` (epoch ms). It is "near
 *      expiry" once `at >= expiresAt - skewMs`. The `skewMs` skew refreshes
 *      *ahead* of the hard deadline so an in-flight call never races a token
 *      that expires mid-request. This is the proactive, time-driven reason and
 *      is computed purely from the injected `at` — no clock in the verb.
 *
 *   2. **Server rejection (401)** — the server rejected a request the client
 *      believed was still valid (clock skew, a server-side revocation, an early
 *      rotation). `on401` flips a `stale` flag regardless of `expiresAt`. This
 *      is the reactive reason: the client's belief about validity was wrong, so
 *      the next `needsRefresh` returns true even though the clock says the
 *      token is fine.
 *
 * `needsRefresh` is the union of the two (plus "no token at all"). One source
 * of truth for "should I fetch a fresh credential before the next call?", read
 * by the consumer's reducer at the call boundary.
 *
 * Typical wiring (inside a consumer machine):
 *
 *   const tr = createTokenRefresh({ skewMs: 30_000 });
 *
 *   // in init:
 *   init: (loaded) => [loaded ?? { auth: tr.init() }, Cmd.none],
 *
 *   // in a reducer cell that is about to make an authed call:
 *   before_call: (s, msg) => {
 *     const [auth, cmds] = tr.ensureFresh(s.auth, msg.at);
 *     return [{ ...s, auth }, cmds]; // emits a refresh Cmd iff a refresh is due
 *   },
 *
 *   // on a 401 from a guarded call:
 *   got_401: (s) => [{ ...s, auth: tr.on401(s.auth) }, []],
 *
 *   // when the refresh lands (the engine mints `refresh_token_ok`):
 *   refresh_token_ok: (s, msg) => [{ ...s, auth: tr.refreshed(s.auth, msg.value) }, []],
 *
 *   // and where the machine runs, the handler you write for the Cmd:
 *   run(machine, {
 *     interpret: {
 *       refresh_token: async (_cmd, { ok, err }) => {
 *         try { return ok(await mySdk.mintToken()); }
 *         catch (cause) { return err({ _tag: "token_refresh_failed", cause }); }
 *       },
 *     },
 *   });
 *
 * NOT a substrate primitive: from `../index` it reuses only `Cmd.define` — and
 * no sibling brick. It is a leaf utility internal to the package
 * (`src/internal/resilience/`, #46).
 */

import {
  Cmd,
  type CmdOf,
  type SettledErr,
  type SettledOk,
  type TaggedError,
} from "../../../index";
import { unchecked } from "../../schema";

/**
 * A minted credential: the opaque `value` to send on the wire, and the absolute
 * `expiresAt` (epoch milliseconds — the `Date.now()` scale) the issuer stamped
 * it with. Both fields are plain data so a `Token` is trivially serializable
 * into a consumer's `Store<S>`.
 *
 * `value` is `string` because that is the universal shape of a bearer token /
 * API key / session cookie on the wire. A consumer whose refresh port yields a
 * richer object can JSON-encode it into `value`, or keep this module's slice as
 * the "is it fresh?" gate and hold the richer object elsewhere in their Model.
 */
export interface Token {
  /** The opaque credential to present on each request (bearer token, API key). */
  readonly value: string;
  /** Absolute expiry instant, epoch milliseconds. The `Date.now()` scale. */
  readonly expiresAt: number;
}

/**
 * Pure configuration — the knob's only field. Carries no mutable state;
 * `TokenState` does. One config is shared across all the refreshes of one
 * logical credential (often a module-scope const).
 */
export interface TokenRefreshConfig {
  /**
   * Refresh-ahead skew, in milliseconds. A token is treated as needing a
   * refresh once `at >= expiresAt - skewMs`, i.e. `skewMs` BEFORE its hard
   * expiry. This buys headroom so a call that starts just under the wire never
   * races a token that lapses mid-flight, and absorbs small client/server clock
   * disagreement. `0` means "refresh exactly at expiry"; a negative value is
   * clamped to `0` (a skew that pushes the trigger past expiry is meaningless).
   *
   * @default 0
   */
  readonly skewMs?: number;
}

/**
 * The token slice this knob owns — the Model field a consumer spreads in via
 * `init()`. A two-field record rather than a phase union because the two
 * dimensions are orthogonal: a token can be present-and-fresh, present-but-stale
 * (a 401 came back), absent, or absent-and-stale (cleared after a failed
 * refresh). Every combination is meaningful, so neither field implies the
 * other's value and a discriminated union would only manufacture impossible
 * arms.
 *
 *   - `token` — the currently held credential, or `null` when none has been
 *     minted yet (fresh boot) or the last refresh failed.
 *   - `stale` — set by `on401` when the server rejected a request the client
 *     believed valid. Forces the next `needsRefresh` to true regardless of
 *     `expiresAt`; cleared by `refreshed` once a new credential lands.
 *
 * Both fields `readonly` so the whole slice threads safely through a pure
 * reducer and serializes into a `Store<S>`.
 */
export interface TokenState {
  /** The held credential, or `null` if none is available (boot / failed refresh). */
  readonly token: Token | null;
  /** Whether a 401 has marked the held token unusable ahead of its `expiresAt`. */
  readonly stale: boolean;
}

/**
 * The starting slice: no token held, not stale. The first `needsRefresh` after
 * this returns `true` (no token), so a consumer's first guarded call mints a
 * credential before going out.
 */
export function initTokenRefresh(): TokenState {
  return { token: null, stale: false };
}

/**
 * The Cmd this knob emits to ask the runtime to mint a fresh token. Plain data
 * (no closure — invariant 1) carrying nothing: the refresh takes no input, and
 * the slice the result installs is read off the settled Msg, not this Cmd.
 * List it in the machine's `cmds`; its handler returns `ok(token)` or
 * `err({ _tag: "token_refresh_failed", … })`, and the engine mints
 * `refresh_token_ok` / `refresh_token_err`.
 */
export const refreshToken = Cmd.define("refresh_token", {
  input: unchecked<Record<string, never>>(),
  ok: unchecked<Token>(),
  err: ["token_refresh_failed"],
});
export type RefreshTokenCmd = CmdOf<typeof refreshToken>;

/** Construct a `refresh_token` Cmd. */
export function refreshTokenCmd(): RefreshTokenCmd {
  return refreshToken({});
}

/**
 * The Msg the engine mints when the `refresh_token` handler returns
 * `ok(token)`: `value` is the freshly minted `Token`. Fold it with
 * `refreshed(state, msg.value)`.
 */
export type TokenRefreshedMsg = SettledOk<
  "refresh_token",
  RefreshTokenCmd,
  Token
>;

/**
 * The Msg the engine mints when the handler returns
 * `err({ _tag: "token_refresh_failed", … })` — errors are data, never
 * swallowed. The slice is left untouched by a failed refresh: the held token
 * (if any) stays held and stale stays set, so the consumer can retry; clearing
 * it is the consumer's policy, expressed in their reducer.
 */
export type TokenRefreshFailedMsg = SettledErr<
  "refresh_token",
  RefreshTokenCmd,
  TaggedError<"token_refresh_failed">
>;

/** The two Msgs a refresh can settle with. Union for a consumer's Msg type. */
export type TokenRefreshMsg = TokenRefreshedMsg | TokenRefreshFailedMsg;

/**
 * The knob: hand it a config, get back the slice initializer and the pure
 * verbs, plus the `refresh_token` Cmd def (`run`) to list in `cmds`.
 *
 * @example
 * ```ts
 * import { createTokenRefresh } from "@demlik/tea/resilience";
 *
 * const tr = createTokenRefresh({ skewMs: 30_000 });
 * const s0 = tr.init();
 * const [s1, cmds] = tr.ensureFresh(s0, Date.now()); // cmds = [refreshTokenCmd()]
 * ```
 */
export function createTokenRefresh(config: TokenRefreshConfig = {}) {
  // Clamp once at construction: a negative skew would push the refresh trigger
  // PAST expiry, which inverts the knob's intent ("refresh ahead"). NaN (a
  // miswired config) collapses to 0 so `needsRefresh`'s comparison stays total.
  const skewMs =
    config.skewMs !== undefined && config.skewMs > 0 ? config.skewMs : 0;

  /**
   * Whether the held token must be refreshed before the next guarded call, at
   * the injected instant `at` (epoch ms). PURE — reads only, no clock, no
   * mutation. True iff ANY of:
   *
   *   - no token is held (`token === null`) — nothing to present;
   *   - the token was marked `stale` by a 401 — the server disagrees with the
   *     client's belief that it is valid;
   *   - the token's `expiresAt` is not a finite number (`NaN` / `±Infinity`) —
   *     a miswired issuer or a corrupted slice; we cannot reason about when it
   *     lapses, so we fail SAFE toward minting a fresh one rather than letting
   *     `at >= NaN` (always `false`) or `at >= Infinity` (always `false`) mask
   *     a broken expiry as "fresh forever";
   *   - the token is at or past its skewed expiry (`at >= expiresAt - skewMs`)
   *     — the proactive refresh-ahead window has opened.
   *
   * The expiry cutoff is half-open (`>=`), matching the window edges in
   * `rate-limit` / `cache` / `circuit-breaker`: a token minted to expire at `t`
   * with zero skew is considered due at exactly `t`.
   */
  function needsRefresh(state: TokenState, at: number): boolean {
    if (state.token === null) return true;
    if (state.stale) return true;
    // Non-finite expiry (NaN/±Infinity) can never be compared into a "due"
    // verdict — `at >= NaN` and `at >= Infinity` are both `false`, which would
    // pin a broken token as fresh forever. Fail safe: treat it as needing a
    // refresh so the next call mints a credential with a real deadline.
    if (!Number.isFinite(state.token.expiresAt)) return true;
    return at >= state.token.expiresAt - skewMs;
  }

  /**
   * Mark the held token unusable because a request the client believed valid
   * came back 401. PURE — returns a new slice; the input is never mutated.
   * Sets `stale` regardless of `expiresAt`, so the next `needsRefresh` returns
   * true even when the clock still says the token is fine. The token VALUE is
   * kept (not nulled) — it is the consumer's last-known credential until a
   * refresh replaces it, and keeping it lets observability show what was
   * rejected.
   *
   * Idempotent: a second 401 on an already-stale slice returns the same shape.
   * A 401 with no token held is a no-op (already needs a refresh).
   */
  function on401(state: TokenState): TokenState {
    if (state.stale) return state;
    return { ...state, stale: true };
  }

  /**
   * Install a freshly minted `token`, clearing `stale`. PURE — returns a new
   * slice; the input is never mutated. This is the fold for the
   * `token_refreshed` Msg: after it, `needsRefresh(state, at)` is false for any
   * `at` below the new skewed expiry, and the stale flag is gone (the new
   * credential supersedes whatever the 401 rejected).
   *
   * This is the slice's WRITE boundary for a credential, so it is where the
   * durability invariant is paid for: it normalizes a negative-zero `expiresAt`
   * to `+0` before the value enters the slice. `-0` is the one finite double
   * JSON cannot round-trip — `JSON.stringify(-0)` is `"0"`, which parses back as
   * `+0`, so a slice carrying `-0` would diverge from its persisted form across
   * a Durable Object eviction / page reload (invariant: the boundary parses, the
   * core trusts). `-0` and `+0` denote the same epoch-ms instant, so collapsing
   * them loses no information and makes the un-round-trippable state
   * unrepresentable in the slice by construction.
   */
  function refreshed(state: TokenState, token: Token): TokenState {
    const normalized: Token = Object.is(token.expiresAt, -0)
      ? { ...token, expiresAt: 0 }
      : token;
    return { ...state, token: normalized, stale: false };
  }

  /**
   * The verb a consumer calls at the call boundary: "make sure I have a fresh
   * credential before the next request." PURE — returns `[next, cmds]`. When a
   * refresh is due (`needsRefresh(state, at)`), emits a single `refresh_token`
   * Cmd; otherwise emits none. The slice is returned UNCHANGED in both branches
   * — the refresh itself is async and lands later via `refreshed`, so there is
   * no in-flight phase to record here. (A consumer that wants single-flight —
   * "don't fire a second refresh while one is pending" — layers that in their
   * own reducer, e.g. by tracking a pending flag; this brick stays minimal and
   * lets the consumer own that policy.)
   *
   * The `at` is the caller's stamped clock reading (epoch ms), never read here —
   * keeping the verb pure and `replay`-able.
   */
  function ensureFresh(
    state: TokenState,
    at: number,
  ): readonly [TokenState, readonly RefreshTokenCmd[]] {
    if (needsRefresh(state, at)) {
      return [state, [refreshTokenCmd()]];
    }
    return [state, []];
  }

  return {
    /** The `refresh_token` Cmd def — list it in the machine's `cmds`. */
    run: refreshToken,
    /** The slice initializer — spread into the consumer's `init`. */
    init: initTokenRefresh,
    needsRefresh,
    on401,
    refreshed,
    ensureFresh,
  };
}

/** The shape `createTokenRefresh` returns — useful for typing a held knob. */
export type TokenRefresh = ReturnType<typeof createTokenRefresh>;
