# @demlik/tea/resilience

> the call-hardening batteries: deadlines, retries, circuit breakers, rate limits, TTL caches, credential refresh, and the wrappers that bolt them onto a machine you already have.

```ts
import { … } from "@demlik/tea/resilience";
```

## Exports (125)

| Symbol | Kind | Summary |
| --- | --- | --- |
| `ArmTimer` | Type | The host-plugged timer backing. |
| `AuthedCall` | Type | The shape `createAuthedCall` returns — useful for typing a held knob. |
| `AuthedCmd` | Type | The two effects this knob emits: resilient-call's run, token-refresh's mint. |
| `AuthedConfig` | Interface | The authed-call knob. |
| `AuthedPorts` | Interface | Ports `handlers` needs — resilient-call's run port AND token-refresh's refresh port. |
| `AuthedState` | Interface | The composed slice. |
| `CacheConfig` | Interface | Per-entry TTL cache knob. |
| `CacheEntry` | Interface | A cached entry: the `value` and the absolute clock reading `expiresAtMs` it expires at. |
| `cacheEvictionSub` | Function | Declare an eviction Sub for the cache identified by `id`, ticking every `everyMs`. |
| `CacheEvictionSub` | Type | The Sub shape the eviction factory installs: a `setInterval`-shaped Sub carrying its tick period (`intervalMs`) per the substrate's reconcile-by-id-with-data-on-the-Sub contract. |
| `cacheEvictionSubscribe` | Variable | The `subscribe` cell for the eviction Sub. |
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
| `createTokenRefresh` | Function | The knob: hand it a config, get back the slice initializer, the pure verbs, and the `handlers` splice. |
| `DeadlineConfig` | Interface | The deadline knob. |
| `deadlineDecision` | Variable | The fire-and-forget decision Cmd the merged `update` appends on every transition, so the wrapper's choice is visible in the replayed Cmd log (rule 3) — `rearm` when an accepted progress Msg bumped `seq`, `expire` when the deadline-exceeded Msg flipped the phase, `idle` otherwise (a non-progress Msg, or a Msg after the machine already auto-failed). |
| `DeadlineDecisionCmd` | Type |  |
| `deadlineExceeded` | Function | Construct the Msg the deadline dispatches. |
| `DeadlineExceeded` | Type | The Msg the deadline dispatches when the wall clock crosses `atMs`. |
| `DeadlineExceededError` | Type | The plain-data error a deadline-failed call settles with. |
| `deadlineExceededMsg` | Function | Construct the deadline-exceeded Msg. |
| `DeadlineExceededMsg` | Interface | The Msg the timeout Sub dispatches when `config.ms` elapses with no accepted progress. |
| `DeadlineModel` | Interface | The composed Model. |
| `DeadlineOpts` | Type | Additive options the `deadlineSub` factory folds onto the Sub literal. |
| `DeadlineSettled` | Interface | What MountConfig.onDeadline is handed: the one call the timer cell just settled `failed`, named by its `key`, carrying the error the slice settled with and the timer Msg that produced it. |
| `DeadlineSlice` | Interface | The wrapper's Model slice. |
| `deadlineSub` | Function | Re-export the deadline Sub primitives so consumers (and tests) wire one import: `subscribeDeadline` is the `subscribe` handler, `deadlineSub` builds the Sub literal both composed wrappers' `subs` emit. |
| `DeadlineSub` | Type | The Sub variant a deadline produces. |
| `DeadlineTimeoutSub` | Type | The relative-timeout Sub the wrapper arms while `phase === "armed"`. |
| `DEFAULT_RESILIENT_NAME` | Variable | The family every unnamed knob speaks: `resilient_run` / `resilient_ok` / `resilient_err`. |
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
| `MountableKnob` | Interface | The part of a resilient-call knob mountResilientCall needs. |
| `MountConfig` | Interface | What to mount, and where. |
| `MountedCell` | Type | One cell of the update fragment mountResilientCall returns. |
| `MountedResilientCall` | Interface | The four fragments a consumer spreads into `defineMachine`. |
| `mountResilientCall` | Function | Pre-assemble a resilient-call knob into the fragments a machine definition spreads, so mounting one is a spread instead of eight hand-spliced points. |
| `onFailure` | Function | Record a failed guarded call. |
| `onSuccess` | Function | Record a successful guarded call. |
| `ProgressPredicate` | Type | A predicate over a Msg that decides whether it re-arms the deadline. |
| `RateLimitConfig` | Interface | Token-bucket rate-limit knob. |
| `record` | Function | Prune hits older than `nowMs - windowMs`, then record `nowMs` if there is room. |
| `refill` | Function | Add the tokens accrued since `lastRefillMs`, clamped to `capacity`, and advance `lastRefillMs` to `nowMs`. |
| `refreshToken` | Variable | The Cmd this knob emits to ask the runtime to mint a fresh token. |
| `refreshTokenCmd` | Function | Construct a `refresh_token` Cmd. |
| `RefreshTokenCmd` | Type |  |
| `remaining` | Function | How many more hits `record` would accept at `nowMs` without blocking — `limit` minus the live (post-prune) hit count, floored at 0. |
| `remove` | Function | Drop `key` regardless of expiry. |
| `ResilienceCmd` | Type | Every Cmd the wrapper adds to the base's Cmd union. |
| `ResilienceConfig` | Interface | The `withResilience` knob. |
| `ResilienceErrMsg` | Type | The error Msg the `$resilience:run` handler dispatches back when the base interpret threw / rejected. |
| `ResilienceModel` | Interface | The composed Model. |
| `ResilienceMsg` | Type | Every Msg the wrapper adds to the base's Msg union. |
| `ResilienceOkMsg` | Type | The success Msg the `$resilience:run` handler dispatches back when the base interpret resolved OK. |
| `ResilienceRunCmd` | Type |  |
| `resilienceRunCmdDef` | Function | The carrier Cmd the wrapper emits when the gate ADMITS a target base Cmd. |
| `ResilienceTimerMsg` | Type | The retry / deadline timer Msg the `$resilience:timer` Sub dispatches when the wall clock crosses the armed instant. |
| `ResilienceTimerSub` | Type | The Sub the wrapper adds — a deadline-style timer in the `$resilience` family. |
| `ResilientCallDeadlineConfig` | Interface | Overall deadline knob — a budget of IN-PROCESS time per in-flight call. |
| `ResilientConfig` | Interface | The resilience knob. |
| `ResilientErrType` | Type | The failure settle Msg's `type` for the `N` family. |
| `ResilientHandlers` | Type | What `handlers(ports)` returns: the interpret cell for this knob's run Cmd, under that Cmd's own name. |
| `ResilientOkType` | Type | The success settle Msg's `type` for the `N` family. |
| `ResilientPorts` | Interface | Ports the consumer supplies to `handlers`. |
| `ResilientRunType` | Type | The run Cmd's `type` for the `N` family. |
| `ResilientState` | Interface | The slice. |
| `ResilientTimerMsg` | Type | The retry / deadline timer Msg — `DeadlineExceeded`, keyed by the call `key`. |
| `RetryExhaustedError` | Class | Raised when `retryToSuccess` exhausts the retry bound without a success — the `maxAttempts`-th recorded failure refuses another attempt. |
| `retryToSuccess` | Function | Fire-and-await bounded retry: invoke the fallible `port`, and on each thrown failure fold it through `./retry-backoff` — record it, and if the policy still permits an attempt, back off `nextDelayMs` and retry; otherwise REJECT with RetryExhaustedError. |
| `RetryToSuccessOptions` | Interface | Options for retryToSuccess. |
| `RunCmd` | Type |  |
| `runCmdDef` | Function | The one effect this knob emits: "run the port for `key` with `input`". |
| `RunCmdDef` | Type |  |
| `set` | Function | Write `key → value` with an absolute expiry of `nowMs + ttlMs`. |
| `setTimeoutArmTimer` | Function | The `setTimeout` timer backing — for node / browser / any host whose timer is a plain `setTimeout`. |
| `Settle` | Type | What every verb of a knob in this family hands back. |
| `SettleFold` | Type | The consumer's half of a settle cell: fold the settled answer into the machine's own Model. |
| `SlidingWindow` | Interface | A sliding-window log: the timestamps of every hit still inside the trailing `windowMs`, capped at `limit` events per window. |
| `subscribeDeadline` | Variable | The `subscribe["deadline"]` handler for the DEFAULT `setTimeout` backing. |
| `subscribeWith` | Function | Build the `subscribe["deadline"]` cell from a host-plugged `armTimer`. |
| `SucceedMsg` | Type | Settle Msgs the `handlers` port dispatches back. |
| `TelemetryConfig` | Interface | The telemetry knob. |
| `telemetryEmit` | Variable | The fire-and-forget Cmd the merged `update` appends after every base transition. |
| `TelemetryEmitCmd` | Type |  |
| `TelemetryEvent` | Interface | The datum handed to the sink. |
| `TelemetryModel` | Interface | The composed Model. |
| `TelemetryPorts` | Interface | The side-effecting ports the wrapper adds to `Ctx`. |
| `TelemetrySlice` | Interface | The wrapper's Model slice. |
| `Token` | Interface | A minted credential: the opaque `value` to send on the wire, and the absolute `expiresAt` (epoch milliseconds — the `Date.now()` scale) the issuer stamped it with. |
| `TokenBucket` | Interface | A token bucket: `tokens` of `capacity` available now, replenished at `refillPerSec` tokens per second. |
| `TokenRefresh` | Type | The shape `createTokenRefresh` returns — useful for typing a held knob. |
| `TokenRefreshConfig` | Interface | Pure configuration — the knob's only field. |
| `tokenRefreshedMsg` | Function | Construct a `token_refreshed` Msg carrying the new token. |
| `TokenRefreshedMsg` | Interface | The Msg the refresh port dispatches on success — carries the freshly minted `Token`. |
| `tokenRefreshFailedMsg` | Function | Construct a `token_refresh_failed` Msg carrying the rejection. |
| `TokenRefreshFailedMsg` | Interface | The Msg the refresh port dispatches on failure — carries the rejection so the consumer's reducer can decide whether to back off, surface an error, or give up (errors are data: it is dispatched, never swallowed). |
| `TokenRefreshMsg` | Type | The two Msgs the refresh port can produce. |
| `TokenRefreshPorts` | Interface | The ports this knob's `handlers` splice needs — the single refresh DI seam. |
| `TokenState` | Interface | The token slice this knob owns — the Model field a consumer spreads in via `init()`. |
| `tryConsume` | Function | Refill against `nowMs`, then attempt to take `n` tokens (default 1). |
| `TtlCache` | Interface | The cache: a map of `key → entry`. |
| `Unauthorized` | Type | Every Msg the knob's verbs fold. |
| `UnauthorizedError` | Type | The plain-data error a 401 we cannot fix settles with. |
| `withDeadline` | Function | Wrap `base` with an inactivity deadline. |
| `withResilience` | Function | Wrap `base` so its `config.target` Cmd is run through the resilient-call concern (cache → circuit → rate-limit → retry, deadline-capped). |
| `withTelemetry` | Function | Wrap `base` with observe-only telemetry. |
