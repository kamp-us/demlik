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

## 5. Bound the retrying by outage duration, not attempt count

`defaultRetryPolicy` gives up after `maxAttempts`. A count is the wrong bound
whenever your ladder nests inside somebody else's — four retries up a
250ms→4s ladder is under four seconds of patience, which is nothing against a
peer that waits minutes before it gives up on you. Declare `maxElapsedMs`
instead and the retrying is bounded by how long the far side has actually been
unreachable, however many attempts that takes:

```ts
import {
  type DurationRetryPolicy,
  recordFailure,
  retryElapsedMs,
  shouldRetry,
} from "@demlik/tea/retry-backoff";

// Derive the budget from the peer's own give-up window — never restate a guess.
const policy: DurationRetryPolicy = {
  baseMs: 250,
  factor: 2,
  capMs: 4_000,
  maxElapsedMs: PEER_GIVE_UP_MS,
  jitter: "full",
};

// inside update:
fetch_err: (s, m) => {
  const retry = recordFailure(s.retry, m.error, m.at); // `m.at` starts the streak clock
  if (!shouldRetry(retry, policy, m.at)) {
    return [{ ...s, retry, phase: "failed", outageMs: retryElapsedMs(retry, m.at) }, []];
  }
  // …schedule the next attempt exactly as in step 3.
},
```

The clock stays an argument, so the reducer stays pure. Passing `m.at` to
`recordFailure` is what makes the state a `TimedRetryState`; a policy carrying
`maxElapsedMs` will not type-check against a `shouldRetry` call that has no
`nowMs`, so a declared outage budget can never be one that silently never
fires. Add `maxAttempts` alongside `maxElapsedMs` to bound both ways — retry
continues only while every declared bound still permits it — and spell
forever-retry `unbounded: true`, because a policy that declares no bound at all
does not type-check.

That is the whole recipe: a transient failure moves the machine to
`waiting_retry` with `retryAtMs` set to a backed-off future time, and a success
resets the slice with `initRetry()`. To fire the scheduled retry automatically,
declare a `deadlineSub` at `retryAtMs` — see the `resilient-fetch` example for
the timer wiring, and `@demlik/tea/with-resilience` for the same behavior applied
as a one-line wrapper over an existing machine.

## 6. Or hand the same policy to a battery — the bound flows through

You do not have to fold the ops by hand to get an outage budget. The three
wrappers that own a retry ladder take the whole `AnyRetryPolicy` union, so the
policy from step 5 drops straight in:

```ts
// poll a status endpoint, tolerating a minute-long outage of the source
const poll = createPoller<State, Status>({
  everyMs: 5_000,
  until: (s) => s.poll.lastResult?.status === "ready",
  onTick: () => ({ type: "fetch_status" }),
  retry: policy, // ← the DurationRetryPolicy from step 5
});

// or harden an existing machine's effect Cmd with the same budget
const hardened = withResilience(base, { target: "do_fetch", retry: policy });
```

Nothing extra is wired for the duration bound, and nothing extra is asked of
your machine: each of these already receives the failure instant as DATA —
`poller.tickErr(state, error, at)`, `resilient-call`'s `fail(…, msg.at)`, and
`withResilience`'s own `$resilience:err.at` / `$resilience:timer.atMs` — and
that instant is the streak clock. The reducer still never reads a clock, and a
count-bounded `RetryPolicy` behaves exactly as it always did.
