/**
 * @demlik/tea/token-refresh — a credential's lifecycle as pure state + verbs,
 * with the actual token fetch deferred to a single injected port.
 *
 * This is the L1 brick `authed-call` (#10 in the composition specs) stacks on:
 * a token slice `{ token, stale }` plus pure transitions that decide *when* a
 * credential must be re-minted, and one `handlers(ports)` splice that performs
 * the re-mint. It follows the uniform knob contract every composition wears —
 * `createTokenRefresh(config) → { init, <verbs>, handlers }` — so a consumer
 * spreads ~3 hooks into their machine instead of hand-wiring the refresh dance.
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
 *     parameter the caller stamps; the network fetch enters ONLY at the
 *     `handlers` boundary. This keeps the substrate's purity invariants intact
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
 *   // when the refresh port resolves:
 *   token_refreshed: (s, msg) => [{ ...s, auth: tr.refreshed(s.auth, msg.token) }, []],
 *
 *   // splice the I/O:
 *   interpret: { ...tr.handlers({ refresh: () => mySdk.mintToken() }) },
 *
 * NOT a substrate primitive: from `../index` it reuses only the `Cmd` /
 * `Interpret` types and the `tryInterpret` Railway helper (a runtime function,
 * not a type) that every effectful brick uses — and no sibling brick. It is a
 * leaf utility consumers reach via the `@demlik/tea/token-refresh` subpath.
 */

import { type Cmd, type Interpret, tryInterpret } from "../index";

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
 * (no closure — invariant 1) carrying nothing: the refresh port takes no input,
 * and the slice the result installs is read off the follow-up Msg, not this
 * Cmd. The consumer unions this into their machine's Cmd type and lets
 * `handlers` interpret it.
 */
export interface RefreshTokenCmd extends Cmd<"refresh_token"> {}

/** Construct a `refresh_token` Cmd. */
export function refreshTokenCmd(): RefreshTokenCmd {
  return { type: "refresh_token" };
}

/**
 * The Msg the refresh port dispatches on success — carries the freshly minted
 * `Token`. The consumer unions this into their Msg type and handles it by
 * folding `refreshed(state, msg.token)` into the slice.
 */
export interface TokenRefreshedMsg {
  readonly type: "token_refreshed";
  readonly token: Token;
}

/** Construct a `token_refreshed` Msg carrying the new token. */
export function tokenRefreshedMsg(token: Token): TokenRefreshedMsg {
  return { type: "token_refreshed", token };
}

/**
 * The Msg the refresh port dispatches on failure — carries the rejection so the
 * consumer's reducer can decide whether to back off, surface an error, or give
 * up (errors are data: it is dispatched, never swallowed). The slice itself is
 * left untouched by a failed refresh — the held token (if any) stays held and
 * stale stays set, so the consumer can retry; clearing it is the consumer's
 * policy, expressed in their reducer.
 */
export interface TokenRefreshFailedMsg {
  readonly type: "token_refresh_failed";
  readonly error: unknown;
}

/** Construct a `token_refresh_failed` Msg carrying the rejection. */
export function tokenRefreshFailedMsg(error: unknown): TokenRefreshFailedMsg {
  return { type: "token_refresh_failed", error };
}

/** The two Msgs the refresh port can produce. Union for a consumer's Msg type. */
export type TokenRefreshMsg = TokenRefreshedMsg | TokenRefreshFailedMsg;

/** The ports this knob's `handlers` splice needs — the single refresh DI seam. */
export interface TokenRefreshPorts {
  /**
   * Mint a fresh credential. Called ONLY from the `refresh_token` interpret
   * handler — never from a verb — so the network I/O and any clock the issuer
   * reads stay at the effect boundary. May reject; the rejection is routed to
   * `token_refresh_failed` (errors are data), never thrown into the runtime.
   */
  readonly refresh: () => Promise<Token>;
}

/**
 * The knob: hand it a config, get back the slice initializer, the pure verbs,
 * and the `handlers` splice. Mirrors every L2 composition's uniform contract so
 * the call sites read identically across bricks.
 *
 * @example
 *   const tr = createTokenRefresh({ skewMs: 30_000 });
 *   const s0 = tr.init();
 *   const [s1, cmds] = tr.ensureFresh(s0, Date.now()); // cmds = [refreshTokenCmd()]
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
   */
  function refreshed(state: TokenState, token: Token): TokenState {
    return { ...state, token, stale: false };
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
  ): readonly [TokenState, readonly Cmd[]] {
    if (needsRefresh(state, at)) {
      return [state, [refreshTokenCmd()]];
    }
    return [state, []];
  }

  /**
   * The interpret splice: wraps the injected `refresh` port and routes its
   * Ok/Err to `token_refreshed` / `token_refresh_failed` Msgs via the core's
   * `tryInterpret` Railway helper. Spread the result into a consumer's
   * `interpret` map:
   *
   *   interpret: { ...other, ...tr.handlers({ refresh: () => sdk.mintToken() }) }
   *
   * The port is the ONLY place the network (and any clock the issuer reads) is
   * touched — every verb above stays pure. `tryInterpret` guarantees the
   * handler never rejects: a port rejection becomes a `token_refresh_failed`
   * Msg (errors are data), so the runtime's dispatch loop is never poisoned by
   * an unhandled rejection.
   */
  function handlers(
    ports: TokenRefreshPorts,
  ): Interpret<TokenRefreshMsg, RefreshTokenCmd, unknown> {
    return {
      refresh_token: tryInterpret<
        RefreshTokenCmd,
        Token,
        TokenRefreshMsg,
        unknown
      >(
        () => ports.refresh(),
        (token) => tokenRefreshedMsg(token),
        (error) => tokenRefreshFailedMsg(error),
      ),
    };
  }

  return {
    /** The slice initializer — spread into the consumer's `init`. */
    init: initTokenRefresh,
    needsRefresh,
    on401,
    refreshed,
    ensureFresh,
    handlers,
  };
}

/** The shape `createTokenRefresh` returns — useful for typing a held knob. */
export type TokenRefresh = ReturnType<typeof createTokenRefresh>;
