# @demlik/tea/retry-backoff

> exponential backoff with jitter + cap, and the retry-attempt state every fallible `interpret` handler folds over.

```ts
import { … } from "@demlik/tea/retry-backoff";
```

## Exports (12)

| Symbol | Kind | Summary |
| --- | --- | --- |
| `asRng` | Function |  |
| `backoffDelay` | Function |  |
| `defaultRetryPolicy` | Variable | Sensible defaults: 100ms base, doubling, capped at 30s, up to 5 attempts, full jitter (the herd-avoidance default). |
| `defaultRng` | Variable | The production default: `Math.random`, branded. |
| `initRetry` | Function |  |
| `Jitter` | Type | Jitter strategy applied to the computed backoff delay. |
| `nextDelayMs` | Function |  |
| `recordFailure` | Function |  |
| `RetryPolicy` | Interface | A retry policy is pure configuration — the knobs of the backoff curve. |
| `RetryState` | Interface | Per-operation retry state: how many attempts have failed so far, and the most recent error. |
| `Rng` | Type | A source of uniform randomness in `[0, 1)` — the `Math.random` contract. |
| `shouldRetry` | Function |  |
