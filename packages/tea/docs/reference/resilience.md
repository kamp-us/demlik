# @demlik/tea/resilience

> the call-hardening batteries: deadlines, retries, circuit breakers, rate limits, TTL caches and credential refresh, as plain functions and `Cmd.define`d Cmds you call from your own `update` (ADR 0022).

Tier: `battery`

```ts
import { … } from "@demlik/tea/resilience";
```

## Exports (95)

| Symbol | Kind | Tier | Summary |
| --- | --- | --- | --- |
| [`ArmTimer`](#ArmTimer) | Type | battery | The host-plugged timer backing. |
| [`AuthedCall`](#AuthedCall) | Type | battery | The shape `createAuthedCall` returns — useful for typing a held knob. |
| [`AuthedCmd`](#AuthedCmd) | Type | battery | The two effects this knob emits: resilient-call's run, token-refresh's mint. |
| [`AuthedConfig`](#AuthedConfig) | Type | battery | The authed-call knob. |
| [`AuthedState`](#AuthedState) | Interface | battery | The composed slice. |
| [`CacheConfig`](#CacheConfig) | Interface | battery | Per-entry TTL cache knob. |
| [`CacheEntry`](#CacheEntry) | Interface | battery | A cached entry: the `value` and the absolute clock reading `expiresAtMs` it expires at. |
| [`CacheEvictionDeps`](#CacheEvictionDeps) | Type | battery | The `deps` of an eviction Sub: which cache it ticks for (`name`, echoed as the Msg's `id`) and the tick period (`intervalMs`, which `fromInterval` reads). |
| [`cacheEvictionSub`](#cacheEvictionSub) | Function | battery | The `subs` entry for an eviction tick on the cache named `name`, every `everyMs`. |
| [`CacheEvictionSub`](#CacheEvictionSub) | Type | battery | The running eviction Sub: a `setInterval`-shaped Sub whose `deps` carry the cache's name and tick period. |
| [`cacheEvictionSubscribe`](#cacheEvictionSubscribe) | Variable | battery | The `cache` runner for the eviction Sub. |
| [`cacheEvictMsg`](#cacheEvictMsg) | Function | battery | Construct a `cache_evict` Msg for the cache identified by `id`. |
| [`CacheEvictMsg`](#CacheEvictMsg) | Interface | battery | The Msg the eviction Sub dispatches each tick. |
| [`CallBudget`](#CallBudget) | Interface | battery | What is left of one call's deadline budget, and where the currently open charging segment starts. |
| [`CallPhase`](#CallPhase) | Type | battery | Per-key call phase. |
| [`canPass`](#canPass) | Function | battery | Decide whether a call may pass, advancing the phase as a side effect of the decision. |
| [`CircuitConfig`](#CircuitConfig) | Interface | battery | Circuit-breaker knob — only the two numbers a consumer ever tunes. |
| [`CircuitPolicy`](#CircuitPolicy) | Interface | battery | Circuit-breaker policy — pure configuration, no mutable state. |
| [`CircuitState`](#CircuitState) | Type | battery | The breaker's phase. |
| [`createAuthedCall`](#createAuthedCall) | Function | battery | Build an authed-call knob from `config`. |
| [`createResilientCall`](#createResilientCall) | Function | battery | Build a resilient-call knob from `config`. |
| [`createTokenRefresh`](#createTokenRefresh) | Function | battery | The knob: hand it a config, get back the slice initializer and the pure verbs, plus the `refresh_token` Cmd def (`run`) to list in `cmds`. |
| [`deadlineExceeded`](#deadlineExceeded) | Function | battery | Construct the Msg the deadline dispatches. |
| [`DeadlineExceeded`](#DeadlineExceeded) | Type | battery | The Msg the deadline dispatches when the wall clock crosses `atMs`. |
| [`DeadlineExceededError`](#DeadlineExceededError) | Type | battery | The plain-data error a deadline-failed call settles with. |
| [`deadlineMsgType`](#deadlineMsgType) | Function | battery | The one place the named tag is spelled. |
| [`DeadlineMsgType`](#DeadlineMsgType) | Type | battery | The dispatched Msg's tag, derived from the deadline's optional name. |
| [`DeadlineNameOf`](#DeadlineNameOf) | Type | battery | The name a deadline carries for the `N` family — `undefined` for the default family (no name at all, so the bare literal is dispatched), the name itself otherwise. |
| [`DeadlineOpts`](#DeadlineOpts) | Type | battery | Additive options the `deadlineSub` factory folds onto the Sub literal. |
| [`deadlines`](#deadlines) | Function | battery | The `deps` of a `deadline` Sub: the list, or `null` when it is empty — an empty list is a Sub with nothing to arm, and an off Sub is not a live one (`driveToDone` reads live Subs to tell a waiting machine from a stalled one). |
| [`deadlinesSub`](#deadlinesSub) | Function | battery | The `subs` entry that arms whatever deadlines `select` lists at a state: subs: [deadlinesSub((s: State) => rc.subs(s.resilience))], // run(machine, { subscribe: { deadline: subscribeDeadline } }) |
| [`DeadlinesSub`](#DeadlinesSub) | Type | battery | The running `"deadline"` Sub: its `deps` is the non-empty list of deadlines to arm. |
| [`deadlineSub`](#deadlineSub) | Function | battery | Build a deadline literal. |
| [`DeadlineSub`](#DeadlineSub) | Type | battery | One deadline, as a battery lists it. |
| [`DEFAULT_RESILIENT_NAME`](#DEFAULT_RESILIENT_NAME) | Variable | battery | The family every unnamed knob speaks: `resilient_run` / `resilient_run_ok` / `resilient_run_err`. |
| [`defaultCircuitPolicy`](#defaultCircuitPolicy) | Variable | battery | Sensible defaults: trip after 5 consecutive failures, cool down for 30s, admit a single probe before deciding. |
| [`DefaultResilientName`](#DefaultResilientName) | Type | battery | The Msg-name family a resilient call uses when it is given no name: `resilient`. |
| [`evictExpired`](#evictExpired) | Function | battery | Physically drop every entry expired at `nowMs` (`nowMs >= expiresAtMs`). |
| [`FailMsg`](#FailMsg) | Type | battery | The Msg the engine mints when a resilient call's handler fails: `<name>_run_err`, carrying the Cmd and the error. |
| [`get`](#get) | Function | battery | The cached `value` for `key` iff present AND unexpired at `nowMs`, else `undefined`. |
| [`has`](#has) | Function | battery | True iff `key` is present AND unexpired at `nowMs`. |
| [`initBucket`](#initBucket) | Function | battery | Create a full bucket. |
| [`initCache`](#initCache) | Function | battery | Create an empty cache. |
| [`initCircuit`](#initCircuit) | Function | battery | The starting state: closed with zero recorded failures. |
| [`initTokenRefresh`](#initTokenRefresh) | Function | battery | The starting slice: no token held, not stale. |
| [`initWindow`](#initWindow) | Function | battery | Create an empty window. |
| [`liftAuthed`](#liftAuthed) | Function | battery | Lift a knob result `[slice, cmds]` into a host `[State, cmds]` where the slice lives at `state.authed`. |
| [`liftResilience`](#liftResilience) | Function | battery | Lift a knob result `[slice, cmds]` into a host `[State, cmds]` where the slice lives at `state.resilience`. |
| [`nextTimer`](#nextTimer) | Function | battery | The built-in `timer` Sub's deps for the SOONEST deadline in `list`, counted from `nowMs`; `null` when the list is empty (no timer armed). |
| [`onFailure`](#onFailure) | Function | battery | Record a failed guarded call. |
| [`onSuccess`](#onSuccess) | Function | battery | Record a successful guarded call. |
| [`RateLimitConfig`](#RateLimitConfig) | Interface | battery | Token-bucket rate-limit knob. |
| [`record`](#record) | Function | battery | Prune hits older than `nowMs - windowMs`, then record `nowMs` if there is room. |
| [`refill`](#refill) | Function | battery | Add the tokens accrued since `lastRefillMs`, clamped to `capacity`, and advance `lastRefillMs` to `nowMs`. |
| [`refreshToken`](#refreshToken) | Variable | battery | The Cmd this knob emits to ask the runtime to mint a fresh token. |
| [`refreshTokenCmd`](#refreshTokenCmd) | Function | battery | Construct a `refresh_token` Cmd. |
| [`RefreshTokenCmd`](#RefreshTokenCmd) | Type | battery | The `refresh_token` Cmd value that `refreshTokenCmd` builds. |
| [`remaining`](#remaining) | Function | battery | How many more hits `record` would accept at `nowMs` without blocking — `limit` minus the live (post-prune) hit count, floored at 0. |
| [`remove`](#remove) | Function | battery | Drop `key` regardless of expiry. |
| [`ResilientCallDeadlineConfig`](#ResilientCallDeadlineConfig) | Interface | battery | Overall deadline knob — a budget of IN-PROCESS time per in-flight call. |
| [`ResilientConfig`](#ResilientConfig) | Interface | battery | The resilience knob. |
| [`ResilientDeadlineType`](#ResilientDeadlineType) | Type | battery | The deadline Msg tag this knob's timers dispatch, derived from its name the same way the settle Msgs are. |
| [`ResilientErrType`](#ResilientErrType) | Type | battery | The failure settle Msg's `type` for the `N` family — minted by the engine. |
| [`ResilientOkType`](#ResilientOkType) | Type | battery | The success settle Msg's `type` for the `N` family — minted by the engine. |
| [`ResilientRunType`](#ResilientRunType) | Type | battery | The run Cmd's `type` for the `N` family. |
| [`ResilientState`](#ResilientState) | Interface | battery | The slice. |
| [`ResilientTimerMsg`](#ResilientTimerMsg) | Type | battery | The retry / deadline timer Msg — a `DeadlineExceeded` whose tag is this knob's (ResilientDeadlineType), keyed by the call `key` through the Sub `id`. |
| [`RetryExhaustedError`](#RetryExhaustedError) | Class | battery | Raised when `retryToSuccess` exhausts the retry bound without a success — the `maxAttempts`-th recorded failure refuses another attempt. |
| [`retryToSuccess`](#retryToSuccess) | Function | battery | Fire-and-await bounded retry: invoke the fallible `port`, and on each thrown failure fold it through `./retry-backoff` — record it, and if the policy still permits an attempt, back off `nextDelayMs` and retry; otherwise REJECT with RetryExhaustedError. |
| [`RetryToSuccessOptions`](#RetryToSuccessOptions) | Interface | battery | Options for retryToSuccess. |
| [`RunCmd`](#RunCmd) | Type | battery | The run Cmd value. |
| [`runCmdDef`](#runCmdDef) | Function | battery | The one effect this knob emits: "run the work for `key` with `input`". |
| [`RunCmdDef`](#RunCmdDef) | Type | battery | The type of the `Cmd.define` definition that `runCmdDef` returns for a resilient call's run Cmd. |
| [`RunErr`](#RunErr) | Type | battery | The failures a run handler may return (ADR 0021). |
| [`set`](#set) | Function | battery | Write `key → value` with an absolute expiry of `nowMs + ttlMs`. |
| [`setTimeoutArmTimer`](#setTimeoutArmTimer) | Function | battery | The `setTimeout` timer backing — for node / browser / any host whose timer is a plain `setTimeout`. |
| [`SettleMsg`](#SettleMsg) | Type | battery | What `settle` reads off a settled Msg: the call's `key` (on `cmd`), the engine's `at`, and the handler's `value` or `error`. |
| [`SettleOutcome`](#SettleOutcome) | Type | battery | How a settled call ended — the third thing `settle` hands back, and the only place the port's value can be read from. |
| [`SettleResult`](#SettleResult) | Interface | battery | What `settle` returns: the settled slice, the Cmds it emitted, and the SettleOutcome. |
| [`SlidingWindow`](#SlidingWindow) | Interface | battery | A sliding-window log: the timestamps of every hit still inside the trailing `windowMs`, capped at `limit` events per window. |
| [`subscribeDeadline`](#subscribeDeadline) | Variable | battery | The `deadline` runner for the DEFAULT `setTimeout` backing. |
| [`subscribeWith`](#subscribeWith) | Function | battery | Build the `deadline` runner from a host-plugged `armTimer`. |
| [`SucceedMsg`](#SucceedMsg) | Type | battery | The settle Msgs the engine mints from a run handler's outcome: `<name>_run_ok` carrying the handler's `value`, `<name>_run_err` carrying its declared `error`. |
| [`Token`](#Token) | Interface | battery | A minted credential: the opaque `value` to send on the wire, and the absolute `expiresAt` (epoch milliseconds — the `Date.now()` scale) the issuer stamped it with. |
| [`TokenBucket`](#TokenBucket) | Interface | battery | A token bucket: `tokens` of `capacity` available now, replenished at `refillPerSec` tokens per second. |
| [`TokenRefresh`](#TokenRefresh) | Type | battery | The shape `createTokenRefresh` returns — useful for typing a held knob. |
| [`TokenRefreshConfig`](#TokenRefreshConfig) | Interface | battery | Pure configuration — the knob's only field. |
| [`TokenRefreshedMsg`](#TokenRefreshedMsg) | Type | battery | The Msg the engine mints when the `refresh_token` handler returns `ok(token)`: `value` is the freshly minted `Token`. |
| [`TokenRefreshFailedMsg`](#TokenRefreshFailedMsg) | Type | battery | The Msg the engine mints when the handler returns `err({ _tag: "token_refresh_failed", … })` — errors are data, never swallowed. |
| [`TokenRefreshMsg`](#TokenRefreshMsg) | Type | battery | The two Msgs a refresh can settle with. |
| [`TokenState`](#TokenState) | Interface | battery | The token slice this knob owns — the Model field a consumer spreads in via `init()`. |
| [`tryConsume`](#tryConsume) | Function | battery | Refill against `nowMs`, then attempt to take `n` tokens (default 1). |
| [`TtlCache`](#TtlCache) | Interface | battery | The cache: a map of `key → entry`. |
| [`Unauthorized`](#Unauthorized) | Type | battery | Every Msg the knob's verbs fold. |
| [`UnauthorizedError`](#UnauthorizedError) | Type | battery | The plain-data error a 401 we cannot fix settles with. |

## Declarations

<a id="ArmTimer"></a>

### `ArmTimer`

```ts
type ArmTimer<M> = (id: SubId, atMs: number, msg: M, dispatch: (msg: M) => void) => () => void
```

<a id="AuthedCall"></a>

### `AuthedCall`

```ts
type AuthedCall<I, R> = ReturnType<typeof createAuthedCall>
```

<a id="AuthedCmd"></a>

### `AuthedCmd`

```ts
type AuthedCmd<I> = RunCmd<I> | RefreshTokenCmd
```

<a id="AuthedConfig"></a>

### `AuthedConfig`

```ts
type AuthedConfig = ResilientConfig & TokenRefreshConfig
```

<a id="AuthedState"></a>

### `AuthedState`

```ts
interface AuthedState<I, R> {
  readonly auth: TokenState;
  readonly authRetry: Readonly<Record<string, number>>;
  readonly pendingAuthRetry: Readonly<Record<string, I>>;
  readonly resilience: ResilientState<I, R>;
}
```

<a id="CacheConfig"></a>

### `CacheConfig`

```ts
interface CacheConfig {
  /** How long a cached success stays fresh, in ms. */
  readonly ttlMs: number;
}
```

<a id="CacheEntry"></a>

### `CacheEntry`

```ts
interface CacheEntry<V> {
  readonly expiresAtMs: number;
  readonly value: V;
}
```

<a id="CacheEvictionDeps"></a>

### `CacheEvictionDeps`

```ts
type CacheEvictionDeps = {
  readonly intervalMs: number;
  readonly name: string;
}
```

<a id="cacheEvictionSub"></a>

### `cacheEvictionSub`

```ts
function cacheEvictionSub(
  name: string,
  everyMs: number,
): {
  /**
   * The slice of state this Sub depends on. `null` or `undefined` ⇒ off in
   * this state (see `depsInactive`), so `(s) => s.optionalRunId` gates
   * correctly. Pure (invariant 2). Plain JSON-compatible data only
   * (invariant 1): the structural hash THROWS on a `Date`, `Map`, `Set`,
   * `Error` or class instance rather than collapsing them onto one id.
   */
  readonly deps: (state: unknown) => CacheEvictionDeps | null | undefined;
  readonly type: "cache";
}
```

<a id="CacheEvictionSub"></a>

### `CacheEvictionSub`

```ts
type CacheEvictionSub = Sub<"cache", CacheEvictionDeps>
```

<a id="cacheEvictionSubscribe"></a>

### `cacheEvictionSubscribe`

```ts
const cacheEvictionSubscribe: SubscribeHandler<CacheEvictionSub, CacheEvictMsg, unknown>
```

<a id="cacheEvictMsg"></a>

### `cacheEvictMsg`

```ts
function cacheEvictMsg(id: string): CacheEvictMsg
```

<a id="CacheEvictMsg"></a>

### `CacheEvictMsg`

```ts
interface CacheEvictMsg {
  readonly id: string;
  readonly type: "cache_evict";
}
```

<a id="CallBudget"></a>

### `CallBudget`

```ts
interface CallBudget {
  /** The instant the open segment started, on the clock of the process that opened it. */
  readonly chargingSinceMs: number;
  /** In-process ms left when the open segment started. `0` = no deadline brick. */
  readonly remainingMs: number;
}
```

<a id="CallPhase"></a>

### `CallPhase`

```ts
type CallPhase<I, R> =
  | { readonly phase: "idle" }
  | {
    readonly budget: CallBudget;
    readonly input: I;
    readonly phase: "running";
  }
  | {
    readonly budget: CallBudget;
    readonly input: I;
    readonly phase: "waiting_retry";
    readonly retryAtMs: number;
  }
  | { readonly phase: "circuit_open" }
  | {
    readonly phase: "succeeded";
    readonly result: R;
  }
  | {
    readonly error: unknown;
    readonly phase: "failed";
  }
```

<a id="canPass"></a>

### `canPass`

```ts
function canPass(
  state: CircuitState,
  policy: CircuitPolicy,
  nowMs: number,
): readonly [CircuitState, boolean]
```

<a id="CircuitConfig"></a>

### `CircuitConfig`

```ts
interface CircuitConfig {
  /** How long the breaker stays open before admitting a probe, in ms. */
  readonly cooldownMs: number;
  /**
   * Probes admitted in `half_open` before fast-failing the rest of the round.
   * Defaults to 1 (a single probe decides recovery) — matches the circuit-
   * breaker module's `defaultCircuitPolicy`.
   */
  readonly halfOpenMaxProbes?: number;
  /** Consecutive failures that trip the breaker open. */
  readonly threshold: number;
}
```

<a id="CircuitPolicy"></a>

### `CircuitPolicy`

```ts
interface CircuitPolicy {
  /**
   * How long the breaker stays `open` before `canPass` starts admitting
   * probes, in milliseconds. Measured from `openedAtMs`; the cutoff is
   * half-open (`elapsed >= cooldownMs` admits), matching `rate-limit` /
   * `idempotency` window edges — a breaker opened at `t` first probes at
   * `t + cooldownMs`.
   */
  readonly cooldownMs: number;
  /**
   * Consecutive failures in `closed` that trip the breaker `open`. The
   * `failureThreshold`-th failure is the one that trips — with a threshold of
   * 5, the breaker survives 4 failures and opens on the 5th.
   */
  readonly failureThreshold: number;
  /**
   * How many probe calls `half_open` admits before fast-failing the rest of
   * the round. Caps the load on a recovering target — a single slow probe
   * can't be joined by every queued caller. The round ends when a probe
   * resolves: success closes the breaker, failure re-opens it.
   */
  readonly halfOpenMaxProbes: number;
}
```

<a id="CircuitState"></a>

### `CircuitState`

```ts
type CircuitState =
  | {
    readonly failures: number;
    readonly phase: "closed";
  }
  | {
    readonly openedAtMs: number;
    readonly phase: "open";
  }
  | {
    readonly phase: "half_open";
    readonly probes: number;
  }
```

<a id="createAuthedCall"></a>

### `createAuthedCall`

```ts
function createAuthedCall<I, R>(
  config?: AuthedConfig,
  rng?: () => number,
): {
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
  attempt: (
    s: AuthedState<I, R>,
    key: string,
    input: I,
    at: number,
  ) => readonly [AuthedState<I, R>, readonly AuthedCmd<I>[]];
  /**
   * The deadlines this slice waits on — exactly resilient-call's (retry +
   * deadline timers keyed per call). The auth dimension arms NO timers: a
   * refresh is a one-shot Cmd, and the parked-call re-issue is driven by the
   * `refresh_token_ok` Msg, not a timer.
   */
  deadlines: (s: AuthedState<I, R>) => readonly DeadlineSub[];
  /**
   * Record a NON-auth failure for `key` (a 5xx, a network drop — anything that
   * is not a 401). Delegate to resilient-call's `settle`, which trips the breaker
   * and backs off / settles per the retry policy. The auth dimension is
   * untouched: a generic failure says nothing about the credential. PURE.
   *
   * A 401 is NOT routed here — the consumer dispatches `unauthorized` and the
   * machine calls `on401` instead. Routing a 401 through `fail` would burn the
   * resilient retry budget on a credential that a plain re-issue cannot fix.
   */
  fail: (
    s: AuthedState<I, R>,
    msg: FailMsg,
  ) => readonly [AuthedState<I, R>, readonly AuthedCmd<I>[]];
  /** The starting slice — both bricks' inits plus empty auth-retry bookkeeping. */
  init: () => AuthedState<I, R>;
  /**
   * Fold a freshly minted `token` into the auth slice (delegates to token-
   * refresh's `refreshed`: installs the token, clears `stale`). PURE. Call this
   * from the `refresh_token_ok` reducer cell, then chain `onRefreshed` to re-fire
   * the parked calls. Split from `onRefreshed` so a consumer can install a token
   * without auto-retrying (e.g. a proactive expiry refresh with nothing parked).
   */
  installToken: (s: AuthedState<I, R>, token: Token) => AuthedState<I, R>;
  /** token-refresh's call-boundary verb, re-exposed for proactive expiry refresh. */
  needsRefresh: (s: AuthedState<I, R>, at: number) => boolean;
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
   * PURE — `at` is the instant a terminal 401 settles the call at.
   */
  on401: (
    s: AuthedState<I, R>,
    key: string,
    at: number,
  ) => readonly [AuthedState<I, R>, readonly AuthedCmd<I>[]];
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
  onRefreshed: (
    s: AuthedState<I, R>,
    at: number,
  ) => readonly [AuthedState<I, R>, readonly AuthedCmd<I>[]];
  /**
   * A retry / deadline timer fired — delegate straight to resilient-call. If the
   * delegated verb settled the call, forget its auth bookkeeping. PURE.
   */
  onTimer: (
    s: AuthedState<I, R>,
    msg: ResilientTimerMsg | { readonly atMs: number; readonly id: string },
  ) => readonly [AuthedState<I, R>, readonly AuthedCmd<I>[]];
  /** token-refresh's `refresh_token` Cmd def — list it in `cmds`. */
  refresh: CmdDef<"refresh_token", Record<string, never>, Token, {
    readonly [detail: string]: unknown;
    readonly _tag: "token_refresh_failed";
  }>;
  /** The call's `Cmd.define`d run Cmd — list it in `cmds`. */
  run: CmdDef<"resilient_run", { readonly input: I; readonly key: string }, R, {
    readonly [detail: string]: unknown;
    readonly _tag: "deadline_exceeded";
  } | {
    readonly [detail: string]: unknown;
    readonly _tag: "port_rejected";
  }>;
  /**
   * Record a success for `msg.cmd.key`: delegate to resilient-call (closes the
   * breaker, fills the cache, resets retry) and clear this key's auth-retry
   * bookkeeping — the call settled, so its 401 budget and any parked input are
   * forgotten. PURE.
   */
  succeed: (
    s: AuthedState<I, R>,
    msg: SucceedMsg<R>,
  ) => readonly [AuthedState<I, R>, readonly AuthedCmd<I>[]];
  /**
   * The built-in `timer` Sub's deps: resilient-call's `timer` over the
   * `resilience` field. Declare `{ type: "timer", deps: (s) => ac.timer(s) }`.
   */
  timer: (s: AuthedState<I, R>) => TimerDeps<ResilientTimerMsg<"resilient">> | null;
}
```

<a id="createResilientCall"></a>

### `createResilientCall`

```ts
function createResilientCall<I, R, N extends string = "resilient">(
  config: ResilientConfig<N>,
  rng?: () => number,
): {
  /**
   * Start (or restart) the call for `key` with `input` at time `at`. Runs the
   * cache → circuit → rate-limit gate and either emits the `resilient_run`
   * effect, schedules a retry, fast-fails (circuit open), or serves the cache.
   * PURE.
   *
   * A key already live keeps the budget it is under (charged up to `at`) rather
   * than being handed a fresh one, so re-issuing an in-flight call — the boot
   * path's move — cannot silently extend its deadline. Only a key with no live
   * call starts a full budget.
   */
  attempt: (
    s: ResilientState<I, R>,
    key: string,
    input: I,
    at: number,
  ) => readonly [ResilientState<I, R>, readonly CmdValue<`${N}_run`, { readonly input: I; readonly key: string }, R, {
    readonly [detail: string]: unknown;
    readonly _tag: "deadline_exceeded";
  } | {
    readonly [detail: string]: unknown;
    readonly _tag: "port_rejected";
  }>[]];
  /**
   * The deadlines this slice is waiting on: a retry timer for every
   * `waiting_retry` call, and (when the `deadline` brick is configured) an
   * overall deadline timer for every still-active call. Each is an absolute
   * instant; `timer` arms the soonest. PURE.
   */
  deadlines: (s: ResilientState<I, R>) => readonly DeadlineSub<DeadlineNameOf<N>>[];
  /** The starting slice. Bricks not in `config` still get a default value. */
  init: () => ResilientState<I, R>;
  name: N;
  /**
   * A timer fired for some key. Two kinds, disambiguated by the Sub id:
   *
   *   - retry timer    → re-run the gate for that key's remembered input,
   *                      re-checking the circuit + bucket at THIS time.
   *   - deadline timer → the overall budget elapsed → settle `failed` with a
   *                      deadline error, no matter the current phase.
   *
   * A timer for a key no longer `waiting_retry` (retry) / no longer in flight
   * (deadline) leaves the calls alone — the reconcile pass races the result;
   * the verb must tolerate a stale fire. Every fire records `msg.atMs` as the
   * slice's clock, so `timer` re-arms from it. PURE.
   */
  onTimer: (
    slice: ResilientState<I, R>,
    msg: { readonly atMs: number; readonly id: string },
  ) => readonly [ResilientState<I, R>, readonly CmdValue<`${N}_run`, { readonly input: I; readonly key: string }, R, {
    readonly [detail: string]: unknown;
    readonly _tag: "deadline_exceeded";
  } | {
    readonly [detail: string]: unknown;
    readonly _tag: "port_rejected";
  }>[]];
  /**
   * Re-anchor every live call's charging clock to `at`: the verb a host calls
   * once on the boot path, before any Sub is armed or any attempt re-issued.
   *
   * This is what keeps DOWNTIME out of the budget. `chargingSinceMs` is an
   * instant on the clock of the process that wrote it; after an eviction, a crash
   * or a redeploy, the gap between it and now is time in which no attempt ran and
   * no port was called, so charging it would time a call out on the host's
   * absence rather than on the tool's slowness. `remainingMs` — the durable half
   * of the budget — is left exactly as the last live transition set it. PURE.
   */
  resume: (s: ResilientState<I, R>, at: number) => ResilientState<I, R>;
  /** The `Cmd.define`d run Cmd; list it in the machine's `cmds`. */
  run: CmdDef<`${N}_run`, { readonly input: I; readonly key: string }, R, {
    readonly [detail: string]: unknown;
    readonly _tag: "deadline_exceeded";
  } | {
    readonly [detail: string]: unknown;
    readonly _tag: "port_rejected";
  }>;
  /**
   * Settle the call a `<name>_run_ok` / `<name>_run_err` Msg answers, keyed off
   * `msg.cmd.key`, and say how it ended. PURE.
   *
   * A success closes the breaker, fills the cache and ends the retry run; the
   * outcome is `done` with the handler's value. A failure trips the breaker and
   * backs off: `retrying` while the retry policy allows another attempt, and
   * `failed` with the error once it does not. A `retrying` call waits on the
   * retry timer `timer` arms; its fire re-issues the run Cmd through `onTimer`.
   *
   * The settled slice, its Cmds and the outcome come back together, and the
   * result value is reachable ONLY through `outcome`. So a hand-wired settle
   * cell cannot fold the answer into its Model before the slice has settled —
   * the order that used to leave a call stuck at `running` cannot be written.
   */
  settle: (s: ResilientState<I, R>, msg: SettleMsg<R, N>) => SettleResult<I, R, N>;
  /**
   * Settle `key` to terminal `failed` with `error` WITHOUT touching the circuit
   * breaker or this key's retry counter. PURE.
   *
   * This is the verb for a failure that is NOT a downstream-health signal: the
   * call must end now, but the breaker must not trip and the backoff run must
   * not advance. `settle` on an `_err` Msg is the opposite — it records the
   * failure against the breaker (it may open) and feeds the retry policy (it
   * may back off). Use
   * `settleFailed` when the *reason* the call cannot proceed has nothing to do
   * with downstream health:
   *
   *   - `authed-call` settles a 401 it cannot fix (e.g. the refresh budget is
   *     spent): a bad token is the caller's problem, not the backend's —
   *     tripping the breaker on it would punish a healthy target, and backing
   *     off would just retry a request that will 401 again.
   *   - `paginated-walk` settles a terminal walk error (e.g. a malformed page
   *     the consumer rejects) that should stop the walk without poisoning the
   *     shared breaker the next page fetch passes through.
   *
   * Because it leaves `circuit` and `retry[key]` untouched, the breaker keeps
   * its health view of the actual backend and a later `attempt` for this key
   * starts a fresh retry run. Both sibling knobs previously hand-rolled this by
   * splicing `calls` directly; this verb gives them one named, tested entry
   * point so the slice's settle invariants live in exactly one place.
   *
   * `at` is the instant the caller decided it — recorded as the slice's clock,
   * since ending a call can change which deadline `timer` counts down to.
   */
  settleFailed: (
    s: ResilientState<I, R>,
    key: string,
    error: unknown,
    at: number,
  ) => readonly [ResilientState<I, R>, readonly CmdValue<`${N}_run`, { readonly input: I; readonly key: string }, R, {
    readonly [detail: string]: unknown;
    readonly _tag: "deadline_exceeded";
  } | {
    readonly [detail: string]: unknown;
    readonly _tag: "port_rejected";
  }>[]];
  /**
   * The built-in `timer` Sub's deps for this slice: the soonest of
   * deadlines, counted down from the slice's `clockMs`, or `null` when
   * nothing is waiting. Declare it in the machine and `run` needs no runner:
   *
   *   subs: [{ type: "timer", deps: (s) => rc.timer(s.call) }]
   *
   * Its fire is this knob's timer Msg (`deadline_exceeded`, or
   * `<name>_deadline` for a named knob); route it to `onTimer`. A phase change
   * drops the matching deadline, and the new deps restart the countdown — no
   * manual `clearTimeout`. PURE.
   */
  timer: (s: ResilientState<I, R>) => TimerDeps<ResilientTimerMsg<N>> | null;
}
```

<a id="createTokenRefresh"></a>

### `createTokenRefresh`

```ts
function createTokenRefresh(
  config?: TokenRefreshConfig,
): {
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
  ensureFresh: (
    state: TokenState,
    at: number,
  ) => readonly [TokenState, readonly CmdValue<"refresh_token", Record<string, never>, Token, {
    readonly [detail: string]: unknown;
    readonly _tag: "token_refresh_failed";
  }>[]];
  /** The slice initializer — spread into the consumer's `init`. */
  init: () => TokenState;
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
  needsRefresh: (state: TokenState, at: number) => boolean;
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
  on401: (state: TokenState) => TokenState;
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
  refreshed: (state: TokenState, token: Token) => TokenState;
  /** The `refresh_token` Cmd def — list it in the machine's `cmds`. */
  run: CmdDef<"refresh_token", Record<string, never>, Token, {
    readonly [detail: string]: unknown;
    readonly _tag: "token_refresh_failed";
  }>;
}
```

<a id="deadlineExceeded"></a>

### `deadlineExceeded`

```ts
function deadlineExceeded<N extends string | undefined = undefined>(
  id: string,
  atMs: number,
  name?: N,
): DeadlineExceeded<N>
```

<a id="DeadlineExceeded"></a>

### `DeadlineExceeded`

```ts
type DeadlineExceeded<N extends string | undefined = undefined> = {
  readonly atMs: number;
  readonly id: string;
  readonly type: DeadlineMsgType<N>;
}
```

<a id="DeadlineExceededError"></a>

### `DeadlineExceededError`

```ts
type DeadlineExceededError = {
  readonly _tag: "deadline_exceeded";
  readonly atMs: number;
  readonly id: string;
}
```

<a id="deadlineMsgType"></a>

### `deadlineMsgType`

```ts
function deadlineMsgType<N extends string | undefined>(
  name?: N,
): DeadlineMsgType<N>
```

<a id="DeadlineMsgType"></a>

### `DeadlineMsgType`

```ts
type DeadlineMsgType<N extends string | undefined> = N extends string ? `${N}_deadline` : "deadline_exceeded"
```

<a id="DeadlineNameOf"></a>

### `DeadlineNameOf`

```ts
type DeadlineNameOf<N extends string = DefaultResilientName> = N extends DefaultResilientName ? undefined : N
```

<a id="DeadlineOpts"></a>

### `DeadlineOpts`

```ts
type DeadlineOpts<N extends string | undefined = undefined> = {
  /**
   * The knob this deadline belongs to. Present → the dispatched Msg's tag is
   * `` `${name}_deadline` ``; absent → the tag stays the bare
   * `"deadline_exceeded"` every machine wired before this field is already
   * handling. `N` is the name as a TYPE as well as a value, so a consumer's
   * cell key and the Msg type are derived from one place and cannot drift.
   *
   * Name a deadline when a machine arms more than one family of them. The Sub
   * *id* was already scoped (`` `${name}:deadline:${key}` ``); this scopes the
   * Msg the Sub dispatches, which is what a reducer cell keys off.
   */
  readonly name?: N;
}
```

<a id="deadlines"></a>

### `deadlines`

```ts
function deadlines<N extends string | undefined = undefined>(
  list: readonly DeadlineSub<N>[],
): readonly DeadlineSub<N>[] | null
```

<a id="deadlinesSub"></a>

### `deadlinesSub`

```ts
function deadlinesSub<S, N extends string | undefined = undefined>(
  select: (state: S) => readonly DeadlineSub<N>[],
): {
  /**
   * The slice of state this Sub depends on. `null` or `undefined` ⇒ off in
   * this state (see `depsInactive`), so `(s) => s.optionalRunId` gates
   * correctly. Pure (invariant 2). Plain JSON-compatible data only
   * (invariant 1): the structural hash THROWS on a `Date`, `Map`, `Set`,
   * `Error` or class instance rather than collapsing them onto one id.
   */
  readonly deps: (state: S) => readonly DeadlineSub<N>[] | null | undefined;
  readonly type: "deadline";
}
```

<a id="DeadlinesSub"></a>

### `DeadlinesSub`

```ts
type DeadlinesSub<N extends string | undefined = undefined> = Sub<"deadline", readonly DeadlineSub<N>[]>
```

<a id="deadlineSub"></a>

### `deadlineSub`

```ts
function deadlineSub<N extends string | undefined = undefined>(
  id: string,
  atMs: number,
  opts?: DeadlineOpts<N>,
): DeadlineSub<N>
```

<a id="DeadlineSub"></a>

### `DeadlineSub`

```ts
type DeadlineSub<N extends string | undefined = undefined> = {
  readonly atMs: number;
  readonly id: SubId;
  readonly type: "deadline";
} & DeadlineOpts<N>
```

<a id="DEFAULT_RESILIENT_NAME"></a>

### `DEFAULT_RESILIENT_NAME`

```ts
const DEFAULT_RESILIENT_NAME: "resilient"
```

<a id="defaultCircuitPolicy"></a>

### `defaultCircuitPolicy`

```ts
const defaultCircuitPolicy: CircuitPolicy
```

<a id="DefaultResilientName"></a>

### `DefaultResilientName`

```ts
type DefaultResilientName = typeof DEFAULT_RESILIENT_NAME
```

<a id="evictExpired"></a>

### `evictExpired`

```ts
function evictExpired<V>(cache: TtlCache<V>, nowMs: number): TtlCache<V>
```

<a id="FailMsg"></a>

### `FailMsg`

```ts
type FailMsg<
  N extends string = DefaultResilientName,
  I = unknown,
  E = RunErr | MalformedResult,
> = {
  readonly at: number;
  readonly cmd: RunCmd<I, N>;
  readonly error: E;
  readonly type: ResilientErrType<N>;
}
```

<a id="get"></a>

### `get`

```ts
function get<V>(cache: TtlCache<V>, key: string, nowMs: number): V | undefined
```

<a id="has"></a>

### `has`

```ts
function has<V>(cache: TtlCache<V>, key: string, nowMs: number): boolean
```

<a id="initBucket"></a>

### `initBucket`

```ts
function initBucket(
  capacity: number,
  refillPerSec: number,
  nowMs: number,
): TokenBucket
```

<a id="initCache"></a>

### `initCache`

```ts
function initCache<V>(): TtlCache<V>
```

<a id="initCircuit"></a>

### `initCircuit`

```ts
function initCircuit(): CircuitState
```

<a id="initTokenRefresh"></a>

### `initTokenRefresh`

```ts
function initTokenRefresh(): TokenState
```

<a id="initWindow"></a>

### `initWindow`

```ts
function initWindow(windowMs: number, limit: number): SlidingWindow
```

<a id="liftAuthed"></a>

### `liftAuthed`

```ts
function liftAuthed<
  S extends { authed: AuthedState<I, R> },
  I,
  R,
  C extends Cmd,
>(
  state: S,
  __namedParameters: readonly [AuthedState<I, R>, readonly C[]],
): readonly [S, readonly C[]]
```

<a id="liftResilience"></a>

### `liftResilience`

```ts
function liftResilience<
  S extends { resilience: ResilientState<I, R> },
  I,
  R,
  C extends Cmd,
>(
  state: S,
  result: readonly [ResilientState<I, R>, readonly C[]],
): readonly [S, readonly C[]]
```

<a id="nextTimer"></a>

### `nextTimer`

```ts
function nextTimer<N extends string | undefined = undefined>(
  list: readonly DeadlineSub<N>[],
  nowMs: number,
): TimerDeps<DeadlineExceeded<N>> | null
```

<a id="onFailure"></a>

### `onFailure`

```ts
function onFailure(
  state: CircuitState,
  policy: CircuitPolicy,
  nowMs: number,
): CircuitState
```

<a id="onSuccess"></a>

### `onSuccess`

```ts
function onSuccess(state: CircuitState, _policy: CircuitPolicy): CircuitState
```

<a id="RateLimitConfig"></a>

### `RateLimitConfig`

```ts
interface RateLimitConfig {
  /** Burst size — the bucket starts full at `capacity`. */
  readonly capacity: number;
  /** Steady-state refill rate, tokens per second. */
  readonly refillPerSec: number;
}
```

<a id="record"></a>

### `record`

```ts
function record(
  window: SlidingWindow,
  nowMs: number,
): readonly [SlidingWindow, boolean]
```

<a id="refill"></a>

### `refill`

```ts
function refill(bucket: TokenBucket, nowMs: number): TokenBucket
```

<a id="refreshToken"></a>

### `refreshToken`

```ts
const refreshToken: CmdDef<"refresh_token", Record<string, never>, Token, {
  readonly [detail: string]: unknown;
  readonly _tag: "token_refresh_failed";
}>
```

<a id="refreshTokenCmd"></a>

### `refreshTokenCmd`

```ts
function refreshTokenCmd(): CmdValue
```

<a id="RefreshTokenCmd"></a>

### `RefreshTokenCmd`

```ts
type RefreshTokenCmd = CmdOf<typeof refreshToken>
```

<a id="remaining"></a>

### `remaining`

```ts
function remaining(window: SlidingWindow, nowMs: number): number
```

<a id="remove"></a>

### `remove`

```ts
function remove<V>(cache: TtlCache<V>, key: string): TtlCache<V>
```

<a id="ResilientCallDeadlineConfig"></a>

### `ResilientCallDeadlineConfig`

```ts
interface ResilientCallDeadlineConfig {
  /** Budget of in-process time from the moment a call starts, in ms. */
  readonly ms: number;
}
```

<a id="ResilientConfig"></a>

### `ResilientConfig`

```ts
interface ResilientConfig<N extends string = DefaultResilientName> {
  readonly cache?: CacheConfig;
  readonly circuit?: CircuitConfig;
  readonly deadline?: DeadlineConfig;
  /**
   * What this knob's Cmd and settle Msgs are called: `<name>_run`, and the
   * `<name>_run_ok` / `<name>_run_err` the engine mints from the run handler's
   * outcome. Omit it and the family is `resilient` — `resilient_run` /
   * `resilient_run_ok` / `resilient_run_err`.
   *
   * Name a knob when a machine holds more than one of the resilient family.
   * Two unnamed knobs meet in ONE `resilient_run_ok` cell whose payload is the union
   * of both results, and the consumer discriminates by hand on `key` — which the
   * type checker cannot see. Under distinct names each knob settles into its own
   * cell, already narrowed to its own payload.
   *
   * The name is a value AND a type: the settle Msg types are generic in `N`, and
   * `N` is not inferable from `I` / `R`, so an opted-in knob spells all three
   * type arguments — `createResilientCall<In, Out, "jev">({ name: "jev", … })`.
   * The `name` field is typed at `N`, so the two cannot drift apart.
   */
  readonly name?: N;
  readonly rateLimit?: RateLimitConfig;
  /**
   * The backoff brick. Omit and a failure is terminal (no backoff, no timer).
   *
   * Any bound the `../retry-backoff` union admits: a count (`RetryPolicy`), a
   * wall-clock outage budget (`DurationRetryPolicy`), or explicit
   * `unbounded: true`. A duration bound needs no extra wiring: every path that
   * records a failure already holds the instant it was observed as DATA —
   * `settle`'s `msg.at` (stamped at the interpret boundary) and `gate`'s `at`
   * (the caller's `attempt` / the retry timer's `atMs`) — so the streak clock
   * is fed from a Msg, never from a `Date.now()` inside a verb (invariant 2).
   */
  readonly retry?: AnyRetryPolicy;
}
```

<a id="ResilientDeadlineType"></a>

### `ResilientDeadlineType`

```ts
type ResilientDeadlineType<N extends string = DefaultResilientName> = N extends DefaultResilientName ? "deadline_exceeded" : `${N}_deadline`
```

<a id="ResilientErrType"></a>

### `ResilientErrType`

```ts
type ResilientErrType<N extends string> = `${N}_run_err`
```

<a id="ResilientOkType"></a>

### `ResilientOkType`

```ts
type ResilientOkType<N extends string> = `${N}_run_ok`
```

<a id="ResilientRunType"></a>

### `ResilientRunType`

```ts
type ResilientRunType<N extends string> = `${N}_run`
```

<a id="ResilientState"></a>

### `ResilientState`

```ts
interface ResilientState<I, R> {
  readonly bucket: TokenBucket;
  readonly cache: TtlCache<R>;
  readonly calls: Readonly<Record<string, CallPhase<I, R>>>;
  readonly circuit: CircuitState;
  /**
   * The instant of the latest clocked transition this slice saw — the `at` of
   * the last `attempt` / `resume` / `settleFailed`, settled Msg or timer fire.
   * `timer` counts the soonest deadline down from it, so the built-in `timer`
   * Sub gets a relative `ms` without anything reading a clock. `0` until the
   * first clocked transition.
   */
  readonly clockMs: number;
  /**
   * Per-key backoff counter. Entries minted by `backoff` are `TimedRetryState`s
   * (they carry the streak's `firstFailureAtMs`, since every failure path holds
   * the observation instant); the field is typed at the `RetryState` supertype
   * because a key that has never failed has no streak, and a slice persisted
   * before the origin existed rehydrates without one. Still plain data.
   */
  readonly retry: Readonly<Record<string, RetryState>>;
}
```

<a id="ResilientTimerMsg"></a>

### `ResilientTimerMsg`

```ts
type ResilientTimerMsg<N extends string = DefaultResilientName> = DeadlineExceeded<DeadlineNameOf<N>>
```

<a id="RetryExhaustedError"></a>

### `RetryExhaustedError`

```ts
class RetryExhaustedError extends Error {
  constructor(attempts: number, lastError: unknown);
  readonly _tag: "RetryExhaustedError";
  /** How many times the port was invoked before giving up (= `policy.maxAttempts`). */
  readonly attempts: number;
  /** The failure the final attempt threw — carried, never interpreted. */
  readonly lastError: unknown;
  readonly name: "RetryExhaustedError";
}
```

<a id="retryToSuccess"></a>

### `retryToSuccess`

```ts
function retryToSuccess<R>(
  port: () => Promise<R>,
  policy: RetryPolicy,
  opts?: RetryToSuccessOptions,
): Promise<R>
```

<a id="RetryToSuccessOptions"></a>

### `RetryToSuccessOptions`

```ts
interface RetryToSuccessOptions {
  /**
   * The `[0, 1)` jitter source threaded into `nextDelayMs`, branded via
   * `asRng` at construction (a raw `() => number` is rejected by the type).
   * Injected for deterministic backoff in tests; defaults to `defaultRng`
   * (`Math.random`), read only at the delay boundary — never inside the loop's
   * decision.
   */
  readonly rng?: Rng;
  /**
   * The wait between attempts, given the backoff delay in ms. Injectable so a
   * test can drive the retry schedule without wall-clock timers (and assert the
   * exact delays); defaults to a real `setTimeout`. The delay value is always
   * `./retry-backoff`'s `nextDelayMs` — this port only realizes the wait.
   */
  readonly sleep?: (ms: number) => Promise<void>;
}
```

<a id="RunCmd"></a>

### `RunCmd`

```ts
type RunCmd<I, N extends string = DefaultResilientName, R = unknown> = CmdOf<RunCmdDef<I, R, N>>
```

<a id="runCmdDef"></a>

### `runCmdDef`

```ts
function runCmdDef<I, R, N extends string = "resilient">(
  name?: N,
): CmdDef<`${N}_run`, { readonly input: I; readonly key: string }, R, {
  readonly [detail: string]: unknown;
  readonly _tag: "deadline_exceeded";
} | {
  readonly [detail: string]: unknown;
  readonly _tag: "port_rejected";
}>
```

<a id="RunCmdDef"></a>

### `RunCmdDef`

```ts
type RunCmdDef<I, R, N extends string = DefaultResilientName> = ReturnType<typeof runCmdDef>
```

<a id="RunErr"></a>

### `RunErr`

```ts
type RunErr = TaggedError<"port_rejected" | "deadline_exceeded">
```

<a id="set"></a>

### `set`

```ts
function set<V>(
  cache: TtlCache<V>,
  key: string,
  value: V,
  nowMs: number,
  ttlMs: number,
): TtlCache<V>
```

<a id="setTimeoutArmTimer"></a>

### `setTimeoutArmTimer`

```ts
function setTimeoutArmTimer<N extends string | undefined = undefined>(): ArmTimer<DeadlineExceeded<N>>
```

<a id="SettleMsg"></a>

### `SettleMsg`

```ts
type SettleMsg<R, N extends string = DefaultResilientName> =
  | {
    readonly at: number;
    readonly cmd: { readonly key: string };
    readonly type?: ResilientOkType<N>;
    readonly value: R;
  }
  | {
    readonly at: number;
    readonly cmd: { readonly key: string };
    readonly error: unknown;
    readonly type?: ResilientErrType<N>;
  }
```

<a id="SettleOutcome"></a>

### `SettleOutcome`

```ts
type SettleOutcome<R> =
  | { readonly kind: "done"; readonly value: R }
  | {
    readonly error: unknown;
    readonly kind: "failed";
  }
  | { readonly kind: "retrying" }
```

<a id="SettleResult"></a>

### `SettleResult`

```ts
interface SettleResult<I, R, N extends string = DefaultResilientName> {
  readonly call: ResilientState<I, R>;
  readonly cmds: readonly CmdValue<`${N}_run`, { readonly input: I; readonly key: string }, R, {
    readonly [detail: string]: unknown;
    readonly _tag: "deadline_exceeded";
  } | {
    readonly [detail: string]: unknown;
    readonly _tag: "port_rejected";
  }>[];
  readonly outcome: SettleOutcome<R>;
}
```

<a id="SlidingWindow"></a>

### `SlidingWindow`

```ts
interface SlidingWindow {
  readonly hits: readonly number[];
  readonly limit: number;
  readonly windowMs: number;
}
```

<a id="subscribeDeadline"></a>

### `subscribeDeadline`

```ts
const subscribeDeadline: <N extends string | undefined = undefined>(
  sub: DeadlinesSub<N>,
  ctx: unknown,
  dispatch: (msg: DeadlineExceeded<N>) => void,
) => Dispose
```

<a id="subscribeWith"></a>

### `subscribeWith`

```ts
function subscribeWith<N extends string | undefined = undefined>(
  armTimer: ArmTimer<DeadlineExceeded<N>>,
): (
  sub: DeadlinesSub<N>,
  ctx: unknown,
  dispatch: (msg: DeadlineExceeded<N>) => void,
) => Dispose
```

<a id="SucceedMsg"></a>

### `SucceedMsg`

```ts
type SucceedMsg<R, N extends string = DefaultResilientName, I = unknown> = {
  readonly at: number;
  readonly cmd: RunCmd<I, N>;
  readonly type: ResilientOkType<N>;
  readonly value: R;
}
```

<a id="Token"></a>

### `Token`

```ts
interface Token {
  /** Absolute expiry instant, epoch milliseconds. The `Date.now()` scale. */
  readonly expiresAt: number;
  /** The opaque credential to present on each request (bearer token, API key). */
  readonly value: string;
}
```

<a id="TokenBucket"></a>

### `TokenBucket`

```ts
interface TokenBucket {
  readonly capacity: number;
  readonly lastRefillMs: number;
  readonly refillPerSec: number;
  readonly tokens: number;
}
```

<a id="TokenRefresh"></a>

### `TokenRefresh`

```ts
type TokenRefresh = ReturnType<typeof createTokenRefresh>
```

<a id="TokenRefreshConfig"></a>

### `TokenRefreshConfig`

```ts
interface TokenRefreshConfig {
  /**
   * Refresh-ahead skew, in milliseconds. A token is treated as needing a
   * refresh once `at >= expiresAt - skewMs`, i.e. `skewMs` BEFORE its hard
   * expiry. This buys headroom so a call that starts just under the wire never
   * races a token that lapses mid-flight, and absorbs small client/server clock
   * disagreement. `0` means "refresh exactly at expiry"; a negative value is
   * clamped to `0` (a skew that pushes the trigger past expiry is meaningless).
   */
  readonly skewMs?: number;
}
```

<a id="TokenRefreshedMsg"></a>

### `TokenRefreshedMsg`

```ts
type TokenRefreshedMsg = SettledOk<"refresh_token", RefreshTokenCmd, Token>
```

<a id="TokenRefreshFailedMsg"></a>

### `TokenRefreshFailedMsg`

```ts
type TokenRefreshFailedMsg = SettledErr<"refresh_token", RefreshTokenCmd, TaggedError<"token_refresh_failed">>
```

<a id="TokenRefreshMsg"></a>

### `TokenRefreshMsg`

```ts
type TokenRefreshMsg = TokenRefreshedMsg | TokenRefreshFailedMsg
```

<a id="TokenState"></a>

### `TokenState`

```ts
interface TokenState {
  /** Whether a 401 has marked the held token unusable ahead of its `expiresAt`. */
  readonly stale: boolean;
  /** The held credential, or `null` if none is available (boot / failed refresh). */
  readonly token: Token | null;
}
```

<a id="tryConsume"></a>

### `tryConsume`

```ts
function tryConsume(
  bucket: TokenBucket,
  nowMs: number,
  n?: number,
): readonly [TokenBucket, boolean]
```

<a id="TtlCache"></a>

### `TtlCache`

```ts
interface TtlCache<V> {
  readonly entries: Readonly<Record<string, CacheEntry<V>>>;
}
```

<a id="Unauthorized"></a>

### `Unauthorized`

```ts
type Unauthorized = {
  readonly at: number;
  readonly key: string;
  readonly type: typeof MsgType.Unauthorized;
}
```

<a id="UnauthorizedError"></a>

### `UnauthorizedError`

```ts
type UnauthorizedError = {
  readonly _tag: "unauthorized";
  readonly key: string;
}
```
