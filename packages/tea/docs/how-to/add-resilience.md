# Add retry and backoff to a call

> **Looking for a timeout or retry on an agent's tool?** You do not write any of
> this. Declare `timeoutMs` / `retry` on the `tool()` spec and the agent's
> reducer runs the ladder for you — see
> [Bound a slow tool, or retry a flaky one](./handle-a-tool-failure.md#bound-a-slow-tool-or-retry-a-flaky-one).
> This page is for retrying a call in a machine you wrote yourself.

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

const initial: State = {
  phase: "idle",
  body: null,
  retryAtMs: 0,
  retry: initRetry(),
};
```

`retry` is the backoff module's own state — just a field. Seed it with
`initRetry()`, as `initial` does.

## 2. Emit the call as an effect Cmd

The attempt does not perform the call; it emits it as data and lets `interpret`
run it. Name the Cmd, the Msgs the call comes back as, and the `ctx` the handler
reads its HTTP client from:

```ts
import {
  type Cmd,
  defineMachine,
  type Interpret,
  tryInterpret,
} from "@demlik/tea";

type DoFetch = Cmd<"do_fetch"> & { readonly url: string };

type Msg =
  | { readonly type: "fetch"; readonly url: string }
  | { readonly type: "fetch_ok"; readonly body: string }
  | { readonly type: "fetch_err"; readonly error: string; readonly at: number };

interface Ctx {
  readonly http: (url: string) => Promise<string>;
}
```

Time is data: the failure Msg carries `at`, so the reducer never reads the
clock.

## 3. On failure, let the backoff ops decide

The `fetch` cell emits the Cmd. When the failure Msg arrives, the `fetch_err`
cell records it, asks whether to retry, and — if so — schedules the next attempt
using the delay the policy computes:

```ts
import {
  defaultRetryPolicy,
  nextDelayMs,
  recordFailure,
  shouldRetry,
} from "@demlik/tea/retry-backoff";

const resilientFetch = defineMachine({
  types: {
    model: {} as State,
    msg: {} as Msg,
    cmd: {} as DoFetch,
    ctx: {} as Ctx,
  },
  init: (loaded) => [loaded ?? initial, []],
  update: {
    fetch: (s, m) => [
      { ...s, phase: "fetching", body: null },
      [{ type: "do_fetch", url: m.url }],
    ],
    fetch_ok: (s, m) => [
      { ...s, phase: "ok", body: m.body, retry: initRetry() },
      [],
    ],
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
  },
});
```

## 4. Run the effect through `tryInterpret`

`tryInterpret` routes success and failure to two Msgs and never rejects, so a
thrown request becomes a `fetch_err` your reducer already handles. The handler
sits beside the machine, not on it — hand it to `run`:

```ts
import { run } from "@demlik/tea/promise";

const ctx: Ctx = {
  http: (url) => fetch(url).then((response) => response.text()),
};

const interpret: Interpret<Msg, DoFetch, Ctx> = {
  do_fetch: tryInterpret<DoFetch, string, Msg, Ctx>(
    (cmd, ctx) => ctx.http(cmd.url),
    (body) => ({ type: "fetch_ok", body }),
    (err) => ({ type: "fetch_err", error: String(err), at: Date.now() }),
  ),
};

const runtime = run(resilientFetch, { ctx, interpret });
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
  retryElapsedMs,
} from "@demlik/tea/retry-backoff";

/** How long the peer above this call waits before it gives up on it. */
const PEER_GIVE_UP_MS = 10_000;

// Derive the budget from the peer's own give-up window — never restate a guess.
const policy: DurationRetryPolicy = {
  baseMs: 250,
  factor: 2,
  capMs: 4_000,
  maxElapsedMs: PEER_GIVE_UP_MS,
  jitter: "full",
};
```

The machine is step 3's with two changes. The Model gains an `outageMs` field
for how long the outage lasted, and `fetch_err` reads the clock off the Msg in
both calls:

```ts
interface OutageState extends State {
  /** How long the far side had been unreachable when the retrying gave up. */
  readonly outageMs: number | null;
}

const outageBoundedFetch = defineMachine({
  types: {
    model: {} as OutageState,
    msg: {} as Msg,
    cmd: {} as DoFetch,
    ctx: {} as Ctx,
  },
  init: (loaded) => [loaded ?? { ...initial, outageMs: null }, []],
  update: {
    fetch: (s, m) => [
      { ...s, phase: "fetching", body: null },
      [{ type: "do_fetch", url: m.url }],
    ],
    fetch_ok: (s, m) => [
      { ...s, phase: "ok", body: m.body, retry: initRetry() },
      [],
    ],
    fetch_err: (s, m) => {
      const retry = recordFailure(s.retry, m.error, m.at); // `m.at` starts the streak clock
      if (!shouldRetry(retry, policy, m.at)) {
        const outageMs = retryElapsedMs(retry, m.at);
        return [{ ...s, retry, phase: "failed", outageMs }, []];
      }
      return [
        {
          ...s,
          retry,
          phase: "waiting_retry",
          retryAtMs: m.at + nextDelayMs(retry, policy),
        },
        [],
      ];
    },
  },
});
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
declare the engine's built-in `timer` in `subs`, on only while you wait: store
the delay beside `retryAtMs` and hand it over as
`{ type: "timer", deps: (s) => s.phase === "waiting_retry" ? { ms, msg } : null }`.
`run` needs no runner for it. The `resilient-fetch` example has the whole
wiring.

## 6. Retry a `defineAgent`'s brain call

The recipe above is for a call your own reducer owns. An agent's brain call is
already a resilient slice on the Model, so a `defineAgent` declares the policy
and writes no timing at all — the lid's `retry` is threaded to the same
`createAgent` knob, which is why the wait is durable and the attempt count
survives a reload:

```ts
import { defineAgent } from "@demlik/tea/agent";

const agent = defineAgent({
  model,
  tools: [search],
  instructions: "You answer with one sentence, citing a search.",
  // Recommended against a provider 429 / 529: a full-jitter ladder from one
  // second to a minute, giving up after six attempts. The jitter is what stops
  // every one of your runs retrying in the same instant after a shared outage,
  // and the 60s cap is what keeps a long 529 from being hammered.
  retry: {
    baseMs: 1_000,
    factor: 2,
    capMs: 60_000,
    maxAttempts: 6,
    jitter: "full",
  },
});
```

`retry` is opt-in and nothing is defaulted for you: omit it and one throw from
`model` ends the run after a single attempt, exactly as before. There is no
`.with({ interpret: … })` in this recipe on purpose — an overlay would put the
loop inside the effect boundary, where the attempt count lives in the process
and a restart silently refills the budget.

The lid takes the count-bounded `RetryPolicy` the brain call has always taken,
so step 5's outage bound is not available here: pick `maxAttempts` and `capMs`
so the ladder's worst case still fits inside whatever patience the caller above
the agent has.
