# Retry a promise until it succeeds

To put bounded retry and exponential backoff around one fallible async call
without a machine, a slice, or a reducer, hand the port to
`@demlik/tea/retry-to-success`'s `retryToSuccess` and await a `Promise<R>` that
resolves on the first success or rejects at the bound.

## 1. Wrap the fallible port

`retryToSuccess` takes the work, a `RetryPolicy` from `@demlik/tea/retry-backoff`,
and nothing else. The port is invoked at most `maxAttempts` times; every failure
in between is folded through the same `recordFailure` / `shouldRetry` /
`nextDelayMs` primitives `resilient-call` uses, so the schedule is identical:

```ts
import { retryToSuccess } from "@demlik/tea/retry-to-success";
import type { RetryPolicy } from "@demlik/tea/retry-backoff";

const policy: RetryPolicy = {
  baseMs: 100,
  factor: 2,
  capMs: 30_000,
  maxAttempts: 3,
  jitter: "full",
};

const body = await retryToSuccess(() => fetchBody(url), policy);
```

`defaultRetryPolicy` from `@demlik/tea/retry-backoff` is a fine starting curve if
you have no opinion yet.

## 2. Handle the give-up — it is a rejection, never a silent resolve

At the bound the promise rejects with `RetryExhaustedError`, carrying how many
times the port ran and the failure the last attempt threw. Branch on it by
`instanceof` or on the `_tag`:

```ts
import { RetryExhaustedError } from "@demlik/tea/retry-to-success";

try {
  return await retryToSuccess(() => fetchBody(url), policy);
} catch (err) {
  if (err instanceof RetryExhaustedError) {
    log.warn("gave up", { attempts: err.attempts, cause: err.lastError });
    return null;
  }
  throw err;
}
```

Nothing is swallowed: a failure is either retried or surfaced on `lastError`.

## 3. Pin the schedule in a test

Both sources of nondeterminism are injectable. `rng` is the branded `[0, 1)`
jitter source — build it with `asRng`, since a raw `() => 0.5` will not type —
and `sleep` realizes the wait, so a test can drive the whole ladder with no
wall-clock timers and assert the exact delays:

```ts
import { asRng } from "@demlik/tea/retry-backoff";

const delays: number[] = [];
const sleep = (ms: number) => {
  delays.push(ms);
  return Promise.resolve();
};

await expect(
  retryToSuccess(port, policy, { rng: asRng(() => 0.5), sleep }),
).rejects.toBeInstanceOf(RetryExhaustedError);

expect(delays.length).toBe(policy.maxAttempts - 1); // one wait per non-terminal failure
```

## 4. Know when you have outgrown it

This helper is deliberately small — it adds no new backoff math and no new
runtime capability, and it saves exactly one job: hand-folding the retry
primitives into your own loop. Reach past it when any of these is true:

- You want more than retry. Cache, circuit breaker, rate limit, or a wall-clock
  deadline all live in [`with-resilience`](./add-resilience.md), which wraps an
  existing machine's effect Cmd instead of wrapping a promise.
- You want the bound to be an outage duration rather than an attempt count.
  `retryToSuccess` takes a count-bounded `RetryPolicy` only; `maxElapsedMs` flows
  through the wrapper surfaces described in
  [Add retry and backoff to a call](./add-resilience.md).
- The retrying must survive a crash. The attempt counter here lives in a local
  variable inside an `await`, so a Durable Object eviction mid-ladder loses it.
  Fold `@demlik/tea/retry-backoff`'s ops into your Model when the retry state has
  to be durable and replayable.

Inside those bounds it is the whole story: one call, one policy, a resolved value
or a checkable `RetryExhaustedError`. It is the retry-side parallel to
`@demlik/tea/await-terminal`'s `runToTerminal` — that one hands a caller a
`Promise<State>` for a one-shot machine, this one hands a caller a `Promise<R>`
for a one-shot fallible port.
