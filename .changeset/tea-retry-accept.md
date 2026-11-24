---
"@demlik/tea": minor
---

`retryToSuccess` takes an `accept` option that says whether a resolved value is a success. A value
it refuses is retried on the same backoff ladder as a retryable throw and, when the budget runs
out, is the `RetryExhaustedError`'s `lastError`. Leaving `accept` out keeps the old behaviour.
