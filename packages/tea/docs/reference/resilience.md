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
  readonly chargingSinceMs: number;
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
  readonly cooldownMs: number;
  readonly halfOpenMaxProbes?: number;
  readonly threshold: number;
}
```

<a id="CircuitPolicy"></a>

### `CircuitPolicy`

```ts
interface CircuitPolicy {
  readonly cooldownMs: number;
  readonly failureThreshold: number;
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
  attempt: (
    s: AuthedState<I, R>,
    key: string,
    input: I,
    at: number,
  ) => readonly [AuthedState<I, R>, readonly AuthedCmd<I>[]];
  deadlines: (s: AuthedState<I, R>) => readonly DeadlineSub[];
  fail: (
    s: AuthedState<I, R>,
    msg: FailMsg,
  ) => readonly [AuthedState<I, R>, readonly AuthedCmd<I>[]];
  init: () => AuthedState<I, R>;
  installToken: (s: AuthedState<I, R>, token: Token) => AuthedState<I, R>;
  needsRefresh: (s: AuthedState<I, R>, at: number) => boolean;
  on401: (
    s: AuthedState<I, R>,
    key: string,
    at: number,
  ) => readonly [AuthedState<I, R>, readonly AuthedCmd<I>[]];
  onRefreshed: (
    s: AuthedState<I, R>,
    at: number,
  ) => readonly [AuthedState<I, R>, readonly AuthedCmd<I>[]];
  onTimer: (
    s: AuthedState<I, R>,
    msg: ResilientTimerMsg | { readonly atMs: number; readonly id: string },
  ) => readonly [AuthedState<I, R>, readonly AuthedCmd<I>[]];
  refresh: CmdDef<"refresh_token", Record<string, never>, Token, {
    readonly [detail: string]: unknown;
    readonly _tag: "token_refresh_failed";
  }>;
  run: CmdDef<"resilient_run", { readonly input: I; readonly key: string }, R, {
    readonly [detail: string]: unknown;
    readonly _tag: "deadline_exceeded";
  } | {
    readonly [detail: string]: unknown;
    readonly _tag: "port_rejected";
  }>;
  succeed: (
    s: AuthedState<I, R>,
    msg: SucceedMsg<R>,
  ) => readonly [AuthedState<I, R>, readonly AuthedCmd<I>[]];
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
  deadlines: (s: ResilientState<I, R>) => readonly DeadlineSub<DeadlineNameOf<N>>[];
  init: () => ResilientState<I, R>;
  name: N;
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
  resume: (s: ResilientState<I, R>, at: number) => ResilientState<I, R>;
  run: CmdDef<`${N}_run`, { readonly input: I; readonly key: string }, R, {
    readonly [detail: string]: unknown;
    readonly _tag: "deadline_exceeded";
  } | {
    readonly [detail: string]: unknown;
    readonly _tag: "port_rejected";
  }>;
  settle: (s: ResilientState<I, R>, msg: SettleMsg<R, N>) => SettleResult<I, R, N>;
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
  timer: (s: ResilientState<I, R>) => TimerDeps<ResilientTimerMsg<N>> | null;
}
```

<a id="createTokenRefresh"></a>

### `createTokenRefresh`

```ts
function createTokenRefresh(
  config?: TokenRefreshConfig,
): {
  ensureFresh: (
    state: TokenState,
    at: number,
  ) => readonly [TokenState, readonly CmdValue<"refresh_token", Record<string, never>, Token, {
    readonly [detail: string]: unknown;
    readonly _tag: "token_refresh_failed";
  }>[]];
  init: () => TokenState;
  needsRefresh: (state: TokenState, at: number) => boolean;
  on401: (state: TokenState) => TokenState;
  refreshed: (state: TokenState, token: Token) => TokenState;
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
  readonly capacity: number;
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
  readonly name?: N;
  readonly rateLimit?: RateLimitConfig;
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
  readonly clockMs: number;
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
  readonly attempts: number;
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
  readonly rng?: Rng;
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
  readonly expiresAt: number;
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
  readonly stale: boolean;
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
