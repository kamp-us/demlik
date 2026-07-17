# Add retry and backoff to a call

To make a flaky call self-heal without your reducer authoring any timing logic,
fold `@demlik/tea/retry-backoff`'s pure ops into `update` and let the failure Msg
decide whether to retry.

## 1. Carry a retry slice in your Model

```ts
import { type RetryState, initRetry } from "@demlik/tea/retry-backoff";

interface State {
  readonly phase: "idle" | "fetching" | "waiting_retry" | "ok" | "failed";
  readonly body: string | null;
  readonly retryAtMs: number;
  readonly retry: RetryState;
}
```

`retry` is the backoff module's own state — just a field. Seed it with
`initRetry()` in `init`.

## 2. Emit the call as an effect Cmd

The attempt does not perform the call; it emits it as data and lets `interpret`
run it:

```ts
import { type Cmd, defineMachine, tryInterpret } from "@demlik/tea";

type DoFetch = Cmd<"do_fetch"> & { readonly url: string };

// inside update:
fetch: (s, m) => [
  { ...s, phase: "fetching", body: null },
  [{ type: "do_fetch", url: m.url }],
],
```

## 3. On failure, let the backoff ops decide

When the failure Msg arrives, record it, ask whether to retry, and — if so —
schedule the next attempt using the delay the policy computes. Time is data: the
failure Msg carries `at`, so the reducer never reads the clock:

```ts
import {
  defaultRetryPolicy,
  nextDelayMs,
  recordFailure,
  shouldRetry,
} from "@demlik/tea/retry-backoff";

// inside update:
fetch_err: (s, m) => {
  const retry = recordFailure(s.retry, m.error);
  if (!shouldRetry(retry, defaultRetryPolicy)) {
    return [{ ...s, retry, phase: "failed" }, []];
  }
  return [
    {
      ...s,
      retry,
      phase: "waiting_retry",
      retryAtMs: m.at + nextDelayMs(retry, defaultRetryPolicy),
    },
    [],
  ];
},
```

## 4. Run the effect through `tryInterpret`

`tryInterpret` routes success and failure to two Msgs and never rejects, so a
thrown request becomes a `fetch_err` your reducer already handles:

```ts
interpret: {
  do_fetch: tryInterpret<DoFetch, string, Msg, Ctx>(
    (cmd, ctx) => ctx.http(cmd.url),
    (body) => ({ type: "fetch_ok", body }),
    (err) => ({ type: "fetch_err", error: String(err), at: Date.now() }),
  ),
},
```

That is the whole recipe: a transient failure moves the machine to
`waiting_retry` with `retryAtMs` set to a backed-off future time, and a success
resets the slice with `initRetry()`. To fire the scheduled retry automatically,
declare a `deadlineSub` at `retryAtMs` — see the `resilient-fetch` example for
the timer wiring, and `@demlik/tea/with-resilience` for the same behavior applied
as a one-line wrapper over an existing machine.
