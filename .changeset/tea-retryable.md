---
"@demlik/tea": minor
---

`retryToSuccess` (`@demlik/tea/resilience`) and `runStepLoop` (`@demlik/tea/do`) take an optional `retryable: (error) => boolean`, default `() => true`. A failure it refuses ends the retrying at once, with no backoff sleep: `retryToSuccess` rejects with that error itself, not a `RetryExhaustedError`, and `runStepLoop` returns `gave_up` carrying it. `runStepLoop`'s `retry` is now an `AnyRetryPolicy`, so it also takes a duration bound (`maxElapsedMs`), measured on its `now()` from the first failed POST of a streak, or an unbounded budget; a count-bounded policy behaves as before.

**Additive (declaration only):** `RetryToSuccessOptions` and `RunStepLoopConfig` gain the optional field `retryable`, and `RunStepLoopConfig.retry` widens from `RetryPolicy` to `AnyRetryPolicy`.
