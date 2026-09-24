# @demlik/tea/resilience

> the call-hardening batteries: deadlines, retries, circuit breakers, rate limits, TTL caches and credential refresh, as plain functions and `Cmd.define`d Cmds you call from your own `update` (ADR 0022).

```ts
import { … } from "@demlik/tea/resilience";
```

## Exports (95)

| Symbol | Kind | Summary |
| --- | --- | --- |
| `ArmTimer` | Type | The host-plugged timer backing. |
| `AuthedCall` | Type | The shape `createAuthedCall` returns — useful for typing a held knob. |
| `AuthedCmd` | Type | The two effects this knob emits: resilient-call's run, token-refresh's mint. |
| `AuthedConfig` | Type | The authed-call knob. |
| `AuthedState` | Interface | The composed slice. |
| `CacheConfig` | Interface | Per-entry TTL cache knob. |
| `CacheEntry` | Interface | A cached entry: the `value` and the absolute clock reading `expiresAtMs` it expires at. |
| `CacheEvictionDeps` | Type | The `deps` of an eviction Sub: which cache it ticks for (`name`, echoed as the Msg's `id`) and the tick period (`intervalMs`, which `fromInterval` reads). |
| `cacheEvictionSub` | Function | The `subs` entry for an eviction tick on the cache named `name`, every `everyMs`. |
| `CacheEvictionSub` | Type | The running eviction Sub: a `setInterval`-shaped Sub whose `deps` carry the cache's name and tick period. |
| `cacheEvictionSubscribe` | Variable | The `cache` runner for the eviction Sub. |
| `cacheEvictMsg` | Function | Construct a `cache_evict` Msg for the cache identified by `id`. |
| `CacheEvictMsg` | Interface | The Msg the eviction Sub dispatches each tick. |
| `CallBudget` | Interface | What is left of one call's deadline budget, and where the currently open charging segment starts. |
| `CallPhase` | Type | Per-key call phase. |
| `canPass` | Function | Decide whether a call may pass, advancing the phase as a side effect of the decision. |
| `CircuitConfig` | Interface | Circuit-breaker knob — only the two numbers a consumer ever tunes. |
| `CircuitPolicy` | Interface | Circuit-breaker policy — pure configuration, no mutable state. |
| `CircuitState` | Type | The breaker's phase. |
| `createAuthedCall` | Function | Build an authed-call knob from `config`. |
| `createResilientCall` | Function | Build a resilient-call knob from `config`. |
| `createTokenRefresh` | Function | The knob: hand it a config, get back the slice initializer and the pure verbs, plus the `refresh_token` Cmd def (`run`) to list in `cmds`. |
| `deadlineExceeded` | Function | Construct the Msg the deadline dispatches. |
| `DeadlineExceeded` | Type | The Msg the deadline dispatches when the wall clock crosses `atMs`. |
| `DeadlineExceededError` | Type | The plain-data error a deadline-failed call settles with. |
| `deadlineMsgType` | Function | The one place the named tag is spelled. |
| `DeadlineMsgType` | Type | The dispatched Msg's tag, derived from the deadline's optional name. |
| `DeadlineNameOf` | Type | The name a deadline carries for the `N` family — `undefined` for the default family (no name at all, so the bare literal is dispatched), the name itself otherwise. |
| `DeadlineOpts` | Type | Additive options the `deadlineSub` factory folds onto the Sub literal. |
| `deadlines` | Function | The `deps` of a `deadline` Sub: the list, or `null` when it is empty — an empty list is a Sub with nothing to arm, and an off Sub is not a live one (`driveToDone` reads live Subs to tell a waiting machine from a stalled one). |
| `deadlinesSub` | Function | The `subs` entry that arms whatever deadlines `select` lists at a state: subs: [deadlinesSub((s: State) => rc.subs(s.resilience))], // run(machine, { subscribe: { deadline: subscribeDeadline } }) |
| `DeadlinesSub` | Type | The running `"deadline"` Sub: its `deps` is the non-empty list of deadlines to arm. |
| `deadlineSub` | Function | Build a deadline literal. |
| `DeadlineSub` | Type | One deadline, as a battery lists it. |
| `DEFAULT_RESILIENT_NAME` | Variable | The family every unnamed knob speaks: `resilient_run` / `resilient_run_ok` / `resilient_run_err`. |
| `defaultCircuitPolicy` | Variable | Sensible defaults: trip after 5 consecutive failures, cool down for 30s, admit a single probe before deciding. |
| `DefaultResilientName` | Type |  |
| `evictExpired` | Function | Physically drop every entry expired at `nowMs` (`nowMs >= expiresAtMs`). |
| `FailMsg` | Type |  |
| `get` | Function | The cached `value` for `key` iff present AND unexpired at `nowMs`, else `undefined`. |
| `has` | Function | True iff `key` is present AND unexpired at `nowMs`. |
| `initBucket` | Function | Create a full bucket. |
| `initCache` | Function | Create an empty cache. |
| `initCircuit` | Function | The starting state: closed with zero recorded failures. |
| `initTokenRefresh` | Function | The starting slice: no token held, not stale. |
| `initWindow` | Function | Create an empty window. |
| `liftAuthed` | Function | Lift a knob result `[slice, cmds]` into a host `[State, cmds]` where the slice lives at `state.authed`. |
| `liftResilience` | Function | Lift a knob result `[slice, cmds]` into a host `[State, cmds]` where the slice lives at `state.resilience`. |
| `nextTimer` | Function | The built-in `timer` Sub's deps for the SOONEST deadline in `list`, counted from `nowMs`; `null` when the list is empty (no timer armed). |
| `onFailure` | Function | Record a failed guarded call. |
| `onSuccess` | Function | Record a successful guarded call. |
| `RateLimitConfig` | Interface | Token-bucket rate-limit knob. |
| `record` | Function | Prune hits older than `nowMs - windowMs`, then record `nowMs` if there is room. |
| `refill` | Function | Add the tokens accrued since `lastRefillMs`, clamped to `capacity`, and advance `lastRefillMs` to `nowMs`. |
| `refreshToken` | Variable | The Cmd this knob emits to ask the runtime to mint a fresh token. |
| `refreshTokenCmd` | Function | Construct a `refresh_token` Cmd. |
| `RefreshTokenCmd` | Type |  |
| `remaining` | Function | How many more hits `record` would accept at `nowMs` without blocking — `limit` minus the live (post-prune) hit count, floored at 0. |
| `remove` | Function | Drop `key` regardless of expiry. |
| `ResilientCallDeadlineConfig` | Interface | Overall deadline knob — a budget of IN-PROCESS time per in-flight call. |
| `ResilientConfig` | Interface | The resilience knob. |
| `ResilientDeadlineType` | Type | The deadline Msg tag this knob's timers dispatch, derived from its name the same way the settle Msgs are. |
| `ResilientErrType` | Type | The failure settle Msg's `type` for the `N` family — minted by the engine. |
| `ResilientOkType` | Type | The success settle Msg's `type` for the `N` family — minted by the engine. |
| `ResilientRunType` | Type | The run Cmd's `type` for the `N` family. |
| `ResilientState` | Interface | The slice. |
| `ResilientTimerMsg` | Type | The retry / deadline timer Msg — a `DeadlineExceeded` whose tag is this knob's (ResilientDeadlineType), keyed by the call `key` through the Sub `id`. |
| `RetryExhaustedError` | Class | Raised when `retryToSuccess` exhausts the retry bound without a success — the `maxAttempts`-th recorded failure refuses another attempt. |
| `retryToSuccess` | Function | Fire-and-await bounded retry: invoke the fallible `port`, and on each thrown failure fold it through `./retry-backoff` — record it, and if the policy still permits an attempt, back off `nextDelayMs` and retry; otherwise REJECT with RetryExhaustedError. |
| `RetryToSuccessOptions` | Interface | Options for retryToSuccess. |
| `RunCmd` | Type | The run Cmd value. |
| `runCmdDef` | Function | The one effect this knob emits: "run the work for `key` with `input`". |
| `RunCmdDef` | Type |  |
| `RunErr` | Type | The failures a run handler may return (ADR 0021). |
| `set` | Function | Write `key → value` with an absolute expiry of `nowMs + ttlMs`. |
| `setTimeoutArmTimer` | Function | The `setTimeout` timer backing — for node / browser / any host whose timer is a plain `setTimeout`. |
| `SettleMsg` | Type | What `settle` reads off a settled Msg: the call's `key` (on `cmd`), the engine's `at`, and the handler's `value` or `error`. |
| `SettleOutcome` | Type | How a settled call ended — the third thing `settle` hands back, and the only place the port's value can be read from. |
| `SettleResult` | Interface | What `settle` returns: the settled slice, the Cmds it emitted, and the SettleOutcome. |
| `SlidingWindow` | Interface | A sliding-window log: the timestamps of every hit still inside the trailing `windowMs`, capped at `limit` events per window. |
| `subscribeDeadline` | Variable | The `deadline` runner for the DEFAULT `setTimeout` backing. |
| `subscribeWith` | Function | Build the `deadline` runner from a host-plugged `armTimer`. |
| `SucceedMsg` | Type | The settle Msgs the engine mints from a run handler's outcome: `<name>_run_ok` carrying the handler's `value`, `<name>_run_err` carrying its declared `error`. |
| `Token` | Interface | A minted credential: the opaque `value` to send on the wire, and the absolute `expiresAt` (epoch milliseconds — the `Date.now()` scale) the issuer stamped it with. |
| `TokenBucket` | Interface | A token bucket: `tokens` of `capacity` available now, replenished at `refillPerSec` tokens per second. |
| `TokenRefresh` | Type | The shape `createTokenRefresh` returns — useful for typing a held knob. |
| `TokenRefreshConfig` | Interface | Pure configuration — the knob's only field. |
| `TokenRefreshedMsg` | Type | The Msg the engine mints when the `refresh_token` handler returns `ok(token)`: `value` is the freshly minted `Token`. |
| `TokenRefreshFailedMsg` | Type | The Msg the engine mints when the handler returns `err({ _tag: "token_refresh_failed", … })` — errors are data, never swallowed. |
| `TokenRefreshMsg` | Type | The two Msgs a refresh can settle with. |
| `TokenState` | Interface | The token slice this knob owns — the Model field a consumer spreads in via `init()`. |
| `tryConsume` | Function | Refill against `nowMs`, then attempt to take `n` tokens (default 1). |
| `TtlCache` | Interface | The cache: a map of `key → entry`. |
| `Unauthorized` | Type | Every Msg the knob's verbs fold. |
| `UnauthorizedError` | Type | The plain-data error a 401 we cannot fix settles with. |
