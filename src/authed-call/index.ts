/**
 * @demlik/tea/authed-call — resilient-call with one extra dimension: a bearer
 * credential that must be minted before a call goes out and re-minted when the
 * server says it is no longer good (a 401). It is composition #10 in the specs:
 * *extends resilient-call; needs the L1 `token-refresh` brick*.
 *
 * The recipe — two existing bricks, stacked, nothing hand-wired:
 *
 *   - `../resilient-call` owns ALL the call resilience: cache → circuit-breaker
 *     → rate-limit → exponential-backoff retry, plus the per-call deadline. This
 *     knob does not re-implement a single line of it. The `attempt` / `succeed`
 *     / `fail` / `onTimer` verbs here are thin delegations that thread the
 *     composed slice's `resilience` field through the resilient-call verb of the
 *     same name. Whatever resilience config a consumer passes flows straight
 *     down — every `ResilientConfig` field is still optional, still "omit a
 *     brick → omit its gate".
 *
 *   - `../token-refresh` owns the credential lifecycle: the `{ token, stale }`
 *     slice and the decisions about *when* a token must be refreshed (expiry
 *     skew, or a reactive 401). This knob adds the one verb resilient-call has
 *     no concept of — `on401` — and routes the refresh I/O through token-
 *     refresh's `refresh_token` handler.
 *
 * So the slice is exactly *resilient-call's slice + token-refresh's slice*:
 *
 *   { resilience: ResilientState<I,R>, auth: TokenState }
 *
 * and the verb set is *resilient-call's four verbs + `on401`*, precisely the
 * spec's "resilient-call's + `on401(s)` (refresh → retry once)".
 *
 * ## The 401 dance — "refresh → retry once"
 *
 * A 401 is special: it is not a transient failure (backing off and retrying the
 * SAME credential just earns another 401), and it is not a terminal failure (a
 * fresh token usually fixes it). So `on401(s, key, at)` does three things:
 *
 *   1. marks the held token `stale` (via token-refresh's `on401`) and emits a
 *      `refresh_token` Cmd to mint a new one;
 *   2. parks the in-flight call in a per-key `authRetry` budget so that, *once*,
 *      the refresh landing re-issues that call with the new credential;
 *   3. caps that to a SINGLE auth-retry per call. A second 401 on the same call
 *      after we already refreshed and retried does NOT loop — it settles the
 *      call `failed` (errors are data: the failure is recorded, never swallowed
 *      or spun on forever). The budget resets on the next fresh `attempt`.
 *
 * When the refresh resolves, the consumer folds `refreshed` into the auth slice
 * and calls `onRefreshed(s, at)`, which re-attempts every parked call through
 * the resilient gate with the new token in hand.
 *
 * ## The two non-negotiables (canon — inherited from both bricks)
 *
 *   - **Durable** — the slice is `ResilientState` (plain data) + `TokenState`
 *     (plain data) + a plain `Record<string, number>` retry budget. All JSON-
 *     serializable, so it survives a Durable Object eviction / reload.
 *   - **Replayable** — every verb returns `readonly [State, Cmd[]]` and never
 *     reads the wall clock or RNG. Time arrives as an `at` parameter; the RNG
 *     for retry jitter is injected once at `createAuthedCall(config, rng)` and
 *     handed straight to the resilient-call knob. The only clock / network reads
 *     live in `handlers` (the effect boundary) — resilient-call's `run` port and
 *     token-refresh's `refresh` port.
 *
 * ## Typical wiring
 *
 *   const ac = createAuthedCall<string, Resp>({
 *     refresh: () => sdk.mintToken(),
 *     retry: defaultRetryPolicy,
 *     circuit: { threshold: 5, cooldownMs: 30_000 },
 *     deadline: { ms: 5_000 },
 *     skewMs: 30_000,
 *   });
 *
 *   // in the machine:
 *   init: () => [ac.init(), []],
 *   update: {
 *     fetch:   (s, m) => ac.attempt(s, m.key, m.input, m.at),
 *     call_ok: (s, m) => ac.succeed(s, m.key, m),
 *     call_err:(s, m) => ac.fail(s, m.key, m),
 *     got_401: (s, m) => ac.on401(s, m.key, m.at),
 *     token_refreshed: (s, m) => ac.onRefreshed(ac.installToken(s, m.token), m.at),
 *     retry_due: (s, m) => ac.onTimer(s, m),
 *   },
 *   subscriptions: (s) => ac.subs(s),
 *   subscribe: { deadline: subscribeDeadline },
 *   interpret: ac.handlers({ run: ctx.call, refresh: () => sdk.mintToken() }),
 */

import type { Cmd } from "../index";
import {
  createResilientCall,
  type DeadlineExceeded,
  type DeadlineSub,
  deadlineSub,
  type FailMsg,
  type ResilientConfig,
  type ResilientPorts,
  type ResilientState,
  type ResilientTimerMsg,
  type RunCmd,
  type SucceedMsg,
  subscribeDeadline,
} from "../resilient-call";
import {
  createTokenRefresh,
  type RefreshTokenCmd,
  refreshTokenCmd,
  type Token,
  type TokenRefreshConfig,
  type TokenRefreshMsg,
  type TokenRefreshPorts,
  type TokenState,
} from "../token-refresh";

// ===========================================================================
// Config — the knob. The resilient-call config PLUS the two token-refresh
// fields. Every field optional except `refresh` (the credential is the whole
// point: without a mint port there is nothing to authenticate with).
// ===========================================================================

/**
 * The authed-call knob. It is `ResilientConfig` widened by the token dimension:
 *
 *   - `refresh` — the ONLY required field: the port that mints a fresh `Token`.
 *     Identical to token-refresh's `TokenRefreshPorts.refresh`; it is hoisted
 *     onto the config (not the ports) so the consumer spells the credential
 *     source once, the same way `rng` is curried onto the factory.
 *   - `skewMs` — token-refresh's refresh-ahead skew (optional, defaults to 0).
 *   - every `ResilientConfig` field (`retry` / `circuit` / `rateLimit` /
 *     `cache` / `deadline`) — passed straight through to the resilient-call
 *     knob, each still optional, each still "omit a brick → omit its gate".
 */
export interface AuthedConfig extends ResilientConfig, TokenRefreshConfig {
  /** Mint a fresh credential. The single DI seam the auth dimension adds. */
  readonly refresh: () => Promise<Token>;
}

// ===========================================================================
// Slice — resilient-call's slice + token-refresh's slice + the auth-retry
// budget. A flat record, every field plain data.
// ===========================================================================

/**
 * The composed slice. Three plain-data fields, no closures:
 *
 *   - `resilience` — resilient-call's entire slice (circuit, bucket, retry,
 *     cache, calls). Owned and mutated only via resilient-call's verbs.
 *   - `auth` — token-refresh's `{ token, stale }` slice. Owned and mutated only
 *     via token-refresh's verbs.
 *   - `authRetry` — per-key count of auth-retries (401 → refresh → retry) spent
 *     on a call. Caps the dance at one retry per call so a credential the server
 *     keeps rejecting cannot spin forever. A key absent from the record has
 *     spent zero. Cleared when a call settles or a fresh `attempt` starts.
 *
 * `pendingAuthRetry` carries the inputs of calls parked waiting for the refresh
 * to land, keyed so `onRefreshed` can re-issue exactly those calls. Plain data —
 * `input` is the same payload the call was issued with.
 */
export interface AuthedState<I, R> {
  readonly resilience: ResilientState<I, R>;
  readonly auth: TokenState;
  readonly authRetry: Readonly<Record<string, number>>;
  readonly pendingAuthRetry: Readonly<Record<string, I>>;
}

// ===========================================================================
// Cmds + Msgs. The union of both bricks' Cmds/Msgs plus a 401 trigger Msg.
// ===========================================================================

/** The two effects this knob emits: resilient-call's run, token-refresh's mint. */
export type AuthedCmd<I> = RunCmd<I> | RefreshTokenCmd;

/**
 * Every Msg the knob's verbs fold. Resilient-call's settle + timer Msgs, token-
 * refresh's refresh-result Msgs, and the 401 trigger the consumer dispatches
 * when a guarded call comes back unauthorized.
 */
export type Unauthorized = {
  readonly type: "unauthorized";
  readonly key: string;
  readonly at: number;
};

/**
 * The plain-data error a 401 we cannot fix settles with. A `{_tag, ...}`
 * sentinel — NEVER a `new Error(...)` — so the slice stays JSON-serializable
 * (an Error object round-trips to `{}` under JSON and carries a stack trace,
 * both of which break the slice's durability invariant once it is persisted
 * into a `Store<S>` and reloaded). Mirrors resilient-call's `DeadlineExceededError`
 * sentinel discipline. `key` echoes the call that was rejected so a consumer can
 * attribute the failure.
 */
export type UnauthorizedError = {
  readonly _tag: "unauthorized";
  readonly key: string;
};

/** Ports `handlers` needs — resilient-call's run port AND token-refresh's refresh port. */
export interface AuthedPorts<I, R> extends ResilientPorts<I, R> {
  /** Mint a fresh credential. Mirrors `AuthedConfig.refresh` for symmetry at the splice site. */
  readonly refresh: () => Promise<Token>;
}

// ===========================================================================
// The knob factory.
// ===========================================================================

/**
 * Build an authed-call knob from `config`. `rng` is injected for retry jitter
 * and threaded straight into the underlying resilient-call knob — pass a fixed
 * `() => 0.5` in tests to pin backoff; defaults to `Math.random` (read only at
 * the verb boundary inside resilient-call, never in a brick op).
 *
 * Returns the uniform L2 knob contract, widened by the auth verbs (`on401`,
 * `onRefreshed`, `installToken`). `I` is the port input type, `R` the result.
 */
export function createAuthedCall<I, R>(
  config: AuthedConfig,
  rng: () => number = Math.random,
) {
  // Delegate ALL call resilience to the root composition. The resilient config
  // is exactly `config` minus the two auth-only fields — but since
  // `ResilientConfig` only reads the brick fields it knows, passing the wider
  // `config` is harmless. We pass it directly so future resilient bricks flow
  // through without a re-spread.
  const rc = createResilientCall<I, R>(config, rng);
  // Delegate the credential lifecycle to the L1 token brick.
  const tr = createTokenRefresh({ skewMs: config.skewMs });

  /** The starting slice — both bricks' inits plus empty auth-retry bookkeeping. */
  function init(): AuthedState<I, R> {
    return {
      resilience: rc.init(),
      auth: tr.init(),
      authRetry: {},
      pendingAuthRetry: {},
    };
  }

  // Rebuild the host record after a resilient-call verb, preserving the auth
  // dimension. The single seam where a `[ResilientState, Cmd[]]` becomes a
  // `[AuthedState, Cmd[]]`.
  function liftResilient(
    s: AuthedState<I, R>,
    [resilience, cmds]: readonly [ResilientState<I, R>, readonly RunCmd<I>[]],
  ): readonly [AuthedState<I, R>, readonly AuthedCmd<I>[]] {
    return [{ ...s, resilience }, cmds];
  }

  // Drop a key from a `Record` immutably.
  function without<V>(
    rec: Readonly<Record<string, V>>,
    key: string,
  ): Readonly<Record<string, V>> {
    const { [key]: _dropped, ...rest } = rec;
    return rest;
  }

  // === Verb: attempt =======================================================

  /**
   * Start (or restart) the call for `key`. Delegates the gate entirely to
   * resilient-call. A fresh attempt resets this key's auth-retry budget (a new
   * logical call gets its own single 401 retry) and drops any stale parked
   * input. PURE — `at` is the only clock.
   *
   * Note this knob does NOT proactively refresh on expiry inside `attempt`: the
   * expiry-driven refresh is the consumer's call-boundary concern (token-refresh
   * exposes `ensureFresh` for exactly that, re-exported below). `attempt` owns
   * the *reactive* path — it issues the call, and a 401 coming back triggers the
   * refresh. Keeping the two seams separate means a consumer who wants only
   * reactive auth (no proactive refresh) wires nothing extra.
   */
  function attempt(
    s: AuthedState<I, R>,
    key: string,
    input: I,
    at: number,
  ): readonly [AuthedState<I, R>, readonly AuthedCmd<I>[]] {
    const cleared: AuthedState<I, R> = {
      ...s,
      authRetry: without(s.authRetry, key),
      pendingAuthRetry: without(s.pendingAuthRetry, key),
    };
    return liftResilient(
      cleared,
      rc.attempt(cleared.resilience, key, input, at),
    );
  }

  // === Verb: succeed =======================================================

  /**
   * Record a success for `key`: delegate to resilient-call (closes the breaker,
   * fills the cache, resets retry) and clear this key's auth-retry bookkeeping —
   * the call settled, so its 401 budget and any parked input are forgotten.
   * PURE.
   */
  function succeed(
    s: AuthedState<I, R>,
    key: string,
    msg: SucceedMsg<R>,
  ): readonly [AuthedState<I, R>, readonly AuthedCmd<I>[]] {
    const settled: AuthedState<I, R> = {
      ...s,
      authRetry: without(s.authRetry, key),
      pendingAuthRetry: without(s.pendingAuthRetry, key),
    };
    return liftResilient(settled, rc.succeed(settled.resilience, key, msg));
  }

  // === Verb: fail ==========================================================

  /**
   * Record a NON-auth failure for `key` (a 5xx, a network drop — anything that
   * is not a 401). Delegate to resilient-call's `fail`, which trips the breaker
   * and backs off / settles per the retry policy. The auth dimension is
   * untouched: a generic failure says nothing about the credential. PURE.
   *
   * A 401 is NOT routed here — the consumer dispatches `unauthorized` and the
   * machine calls `on401` instead. Routing a 401 through `fail` would burn the
   * resilient retry budget on a credential that a plain re-issue cannot fix.
   */
  function fail(
    s: AuthedState<I, R>,
    key: string,
    msg: FailMsg,
  ): readonly [AuthedState<I, R>, readonly AuthedCmd<I>[]] {
    // If the resilient verb settles this call, forget its auth bookkeeping too.
    const [resilience, cmds] = rc.fail(s.resilience, key, msg);
    const next = settleAuthIfDone({ ...s, resilience }, key, resilience);
    return [next, cmds];
  }

  // === Verb: on401 =========================================================

  /**
   * The auth dimension's one verb: the server rejected `key`'s call as
   * unauthorized. "Refresh → retry once":
   *
   *   - First 401 on this call → mark the token stale, emit a `refresh_token`
   *     Cmd, and PARK the call's input so the refresh landing re-issues it. The
   *     resilient call phase is left as-is (still `running`, or `waiting_retry`
   *     if a transient failure had already backed it off); the in-flight
   *     resilient effect is abandoned in favour of the post-refresh re-issue.
   *   - Second 401 (the budget is already spent) → settle the call `failed`
   *     with the unauthorized error. No second refresh, no loop. Errors are
   *     data: the failure is recorded on the resilient slice, visible to the
   *     consumer.
   *
   * A 401 is NOT a downstream-health signal — a credential the server rejected
   * says nothing about the backend's health. So the terminal path routes through
   * resilient-call's `settleFailed` (which settles `failed` WITHOUT tripping the
   * shared breaker or advancing this key's retry counter), never `fail` (which
   * would punish a healthy target and burn the retry budget on a request that a
   * plain re-issue cannot fix).
   *
   * PURE — `at` is carried for symmetry with the other verbs (the refresh Cmd
   * itself carries no time; the refresh port stamps its own result Msg).
   */
  function on401(
    s: AuthedState<I, R>,
    key: string,
    at: number,
  ): readonly [AuthedState<I, R>, readonly AuthedCmd<I>[]] {
    void at; // carried for symmetry; the async refresh's result Msg stamps the clock.
    const spent = s.authRetry[key] ?? 0;
    const call = s.resilience.calls[key];
    // A 401 can arrive while the call is `running` OR after a transient failure
    // backed it off to `waiting_retry`; both hold the input needed to re-issue.
    // Reading only `running` would drop a 401 that races a backoff — the call
    // would never refresh.
    const input =
      call?.phase === "running" || call?.phase === "waiting_retry"
        ? call.input
        : undefined;

    // Budget exhausted (already refreshed + retried once), or nothing to
    // re-issue: settle the call failed with the unauthorized error. Through
    // `settleFailed`, NOT `fail` — a 401 is not a breaker / retry signal.
    if (spent >= 1 || input === undefined) {
      const error: UnauthorizedError = { _tag: "unauthorized", key };
      const [settled] = rc.settleFailed(s.resilience, key, error);
      return [
        {
          ...s,
          resilience: settled,
          authRetry: without(s.authRetry, key),
          pendingAuthRetry: without(s.pendingAuthRetry, key),
        },
        [],
      ];
    }

    // First 401: mark stale, park the call, ask for a fresh token.
    return [
      {
        ...s,
        auth: tr.on401(s.auth),
        authRetry: { ...s.authRetry, [key]: spent + 1 },
        pendingAuthRetry: { ...s.pendingAuthRetry, [key]: input },
      },
      [refreshTokenCmd()],
    ];
  }

  // === Verb: installToken ==================================================

  /**
   * Fold a freshly minted `token` into the auth slice (delegates to token-
   * refresh's `refreshed`: installs the token, clears `stale`). PURE. Call this
   * from the `token_refreshed` reducer cell, then chain `onRefreshed` to re-fire
   * the parked calls. Split from `onRefreshed` so a consumer can install a token
   * without auto-retrying (e.g. a proactive expiry refresh with nothing parked).
   */
  function installToken(s: AuthedState<I, R>, token: Token): AuthedState<I, R> {
    return { ...s, auth: tr.refreshed(s.auth, token) };
  }

  // === Verb: onRefreshed ===================================================

  /**
   * Re-issue every call parked by a 401 now that a fresh token has landed. Runs
   * each parked input back through resilient-call's `attempt` gate (so the
   * circuit / rate-limit / cache are all re-checked against the new `at`),
   * clears the parked set, and accumulates the run Cmds. The auth-retry COUNT is
   * preserved (each re-issued call has already spent one auth-retry, so a second
   * 401 on it settles failed). PURE — `at` is the gate's clock.
   *
   * No parked calls → a no-op that returns the slice unchanged by reference, so
   * a proactive (expiry) refresh with nothing in flight costs nothing.
   */
  function onRefreshed(
    s: AuthedState<I, R>,
    at: number,
  ): readonly [AuthedState<I, R>, readonly AuthedCmd<I>[]] {
    const parked = Object.entries(s.pendingAuthRetry);
    if (parked.length === 0) return [s, []];

    let resilience = s.resilience;
    const cmds: AuthedCmd<I>[] = [];
    for (const [key, input] of parked) {
      const [next, runCmds] = rc.attempt(resilience, key, input, at);
      resilience = next;
      cmds.push(...runCmds);
    }
    return [{ ...s, resilience, pendingAuthRetry: {} }, cmds];
  }

  // === Verb: onTimer =======================================================

  /**
   * A retry / deadline timer fired — delegate straight to resilient-call. If the
   * delegated verb settled the call, forget its auth bookkeeping. PURE.
   */
  function onTimer(
    s: AuthedState<I, R>,
    msg: ResilientTimerMsg,
  ): readonly [AuthedState<I, R>, readonly AuthedCmd<I>[]] {
    const [resilience, cmds] = rc.onTimer(s.resilience, msg);
    const next = settleAuthIfDone({ ...s, resilience }, undefined, resilience);
    return [next, cmds];
  }

  // --- helpers --------------------------------------------------------------

  // After a resilient verb, drop auth bookkeeping for any key the resilient
  // slice now reports as settled (succeeded / failed). `onlyKey` narrows the
  // scan to one key when the verb targeted one (fail); `undefined` scans all
  // (onTimer can settle a deadline on any key).
  function settleAuthIfDone(
    s: AuthedState<I, R>,
    onlyKey: string | undefined,
    resilience: ResilientState<I, R>,
  ): AuthedState<I, R> {
    let authRetry = s.authRetry;
    let pendingAuthRetry = s.pendingAuthRetry;
    const keys = onlyKey !== undefined ? [onlyKey] : Object.keys(authRetry);
    for (const key of keys) {
      const phase = resilience.calls[key]?.phase;
      if (phase === "succeeded" || phase === "failed") {
        authRetry = without(authRetry, key);
        pendingAuthRetry = without(pendingAuthRetry, key);
      }
    }
    return { ...s, authRetry, pendingAuthRetry };
  }

  // === Subs ================================================================

  /**
   * Pre-wired subscriptions — exactly resilient-call's (retry + deadline timers
   * keyed per call). The auth dimension arms NO timers: a refresh is a one-shot
   * Cmd, not a recurring sub, and the parked-call re-issue is driven by the
   * `token_refreshed` Msg, not a timer. Wire `subscribe: { deadline:
   * subscribeDeadline }`.
   */
  function subs(s: AuthedState<I, R>): readonly DeadlineSub[] {
    return rc.subs(s.resilience);
  }

  // === Handlers ============================================================

  /**
   * Pre-wired interpret handlers: resilient-call's `resilient_run` (wraps the
   * `run` port) AND token-refresh's `refresh_token` (wraps the `refresh` port).
   * Both route Ok/Err through `tryInterpret`, stamping `Date.now()` at the
   * effect boundary — the only clock reads in the whole module. Assign to the
   * machine's `interpret`:
   *
   *   interpret: ac.handlers({ run: ctx.call, refresh: () => sdk.mintToken() })
   */
  function handlers(ports: AuthedPorts<I, R>) {
    const trPorts: TokenRefreshPorts = { refresh: ports.refresh };
    return {
      ...rc.handlers({ run: ports.run }),
      ...tr.handlers(trPorts),
    };
  }

  return {
    init,
    attempt,
    succeed,
    fail,
    on401,
    installToken,
    onRefreshed,
    onTimer,
    /** token-refresh's call-boundary verb, re-exposed for proactive expiry refresh. */
    needsRefresh: (s: AuthedState<I, R>, at: number) =>
      tr.needsRefresh(s.auth, at),
    subs,
    handlers,
  };
}

/** The shape `createAuthedCall` returns — useful for typing a held knob. */
export type AuthedCall<I, R> = ReturnType<typeof createAuthedCall<I, R>>;

/**
 * Lift a knob result `[slice, cmds]` into a host `[State, cmds]` where the slice
 * lives at `state.authed`. A convenience for the common single-slice host;
 * consumers with a differently-named field spread by hand. Pure — a thin record
 * rebuild, no clock / RNG.
 */
export function liftAuthed<
  S extends { authed: AuthedState<I, R> },
  I,
  R,
  C extends Cmd,
>(
  state: S,
  [slice, cmds]: readonly [AuthedState<I, R>, readonly C[]],
): readonly [S, readonly C[]] {
  return [{ ...state, authed: slice }, cmds];
}

/**
 * Re-export the deadline Sub primitives (this knob's `subs` emits `DeadlineSub`s,
 * inherited from resilient-call) and the token-refresh Msg constructors a
 * consumer wires into their reducer, so the whole composition imports from one
 * subpath.
 */
export { subscribeDeadline, deadlineSub };
export type {
  DeadlineSub,
  DeadlineExceeded,
  ResilientState,
  TokenState,
  Token,
  TokenRefreshMsg,
  SucceedMsg,
  FailMsg,
  ResilientTimerMsg,
  RunCmd,
};
