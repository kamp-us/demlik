# @demlik/tea/retry-backoff

> exponential backoff with jitter + cap, and the retry-attempt state every fallible `interpret` handler folds over.

```ts
import { … } from "@demlik/tea/retry-backoff";
```

## Exports (22)

| Symbol | Kind | Summary |
| --- | --- | --- |
| `AnyRetryPolicy` | Type | Any well-formed policy. |
| `asRng` | Function |  |
| `BackoffCurve` | Interface | The shape of the delay ladder, with no terminal bound attached — `baseMs`, `factor`, `capMs`, `jitter`. |
| `backoffDelay` | Function |  |
| `CountBound` | Interface | Bound by ATTEMPT COUNT — the original bound, and the right one when each attempt costs about the same and the caller is the outermost ladder. |
| `defaultRetryPolicy` | Variable | Sensible defaults: 100ms base, doubling, capped at 30s, up to 5 attempts, full jitter (the herd-avoidance default). |
| `defaultRng` | Variable | The production default: `Math.random`, branded. |
| `DurationBound` | Interface | Bound by WALL-CLOCK OUTAGE DURATION, optionally also by count. |
| `DurationRetryPolicy` | Type | A curve bounded by wall-clock outage duration (and optionally by count). |
| `initRetry` | Function |  |
| `Jitter` | Type | Jitter strategy applied to the computed backoff delay. |
| `nextDelayMs` | Function |  |
| `recordFailure` | Function |  |
| `RetryBudget` | Type | The terminal bound a policy declares: a count, a duration (optionally with a count), or an explicit opt-in to neither. |
| `retryElapsedMs` | Function |  |
| `RetryPolicy` | Type | A retry policy is pure configuration — the knobs of the backoff curve plus the bound that ends the retrying. |
| `RetryState` | Interface | Per-operation retry state: how many attempts have failed so far, and the most recent error. |
| `Rng` | Type | A source of uniform randomness in `[0, 1)` — the `Math.random` contract. |
| `shouldRetry` | Function |  |
| `TimedRetryState` | Interface | A retry state that also knows WHEN its failure streak began — the origin a duration bound is measured from. |
| `Unbounded` | Interface | No bound at all — retry forever. |
| `UnboundedRetryPolicy` | Type | A curve with the explicit opt-in to unbounded retry. |
