---
"@demlik/tea": minor
---

**Additive (declaration only):** `retryToSuccess` (`@demlik/tea/resilience`) takes an optional
`accept: (value) => boolean` that says whether a resolved value is a success, and
`RetryToSuccessOptions` gains a type parameter `R` that defaults to `unknown`. A value `accept`
refuses is retried on the same backoff ladder as a retryable throw and, when the budget runs out,
is the `RetryExhaustedError`'s `lastError`. Leaving `accept` out keeps the old behaviour.
