# Call an API that needs a bearer token

To call a guarded endpoint without hand-writing the 401 dance, wire
`@demlik/tea/authed-call`'s knob into your machine: you get the whole resilient
call gate (cache → breaker → rate limit → backoff retry → deadline) plus a
credential that is minted before the call and re-minted, exactly once, when the
server rejects it.

## 1. Build the knob

`createAuthedCall` takes the resilient config you already know, widened by two
auth fields: `refresh` (the only required field — the port that mints a `Token`)
and `skewMs` (how far ahead of expiry a token counts as due). Every resilience
brick stays optional: omit a brick, omit its gate.

```ts
import { createAuthedCall } from "@demlik/tea/authed-call";

const ac = createAuthedCall<string, Resp>({
  refresh: () => sdk.mintToken(),
  retry: { baseMs: 100, factor: 2, capMs: 10_000, maxAttempts: 3, jitter: "full" },
  circuit: { threshold: 5, cooldownMs: 30_000 },
  deadline: { ms: 5_000 },
  skewMs: 30_000,
});
```

`I` is the port's input type, `R` its result. Pass a second argument — a fixed
`() => 0` — to pin the backoff jitter in tests.

## 2. Carry the composed slice in your Model

The slice is plain data all the way down: resilient-call's slice, token-refresh's
`{ token, stale }`, and the per-key 401 bookkeeping. It survives a Durable Object
eviction because nothing in it is an `Error` or a closure.

```ts
import type { AuthedState } from "@demlik/tea/authed-call";

interface State {
  readonly authed: AuthedState<string, Resp>;
}

// inside init:
init: (loaded) => (loaded !== null ? [loaded, []] : [{ authed: ac.init() }, []]),
```

## 3. Wire the four delegated verbs

`attempt` starts (or restarts) a call under a string `key`; `succeed` and `fail`
fold the settle Msgs the run port produces; `onTimer` folds the retry and
deadline timers. Each returns `[slice, cmds]`, so the reducer cell is a rebuild:

```ts
import type {
  FailMsg,
  ResilientTimerMsg,
  SucceedMsg,
} from "@demlik/tea/authed-call";

// inside update:
attempt: (s, m) => {
  const [slice, cmds] = ac.attempt(s.authed, m.key, m.input, m.at);
  return [{ authed: slice }, cmds];
},
resilient_ok: (s, m) => {
  const [slice, cmds] = ac.succeed(s.authed, m.key, m);
  return [{ authed: slice }, cmds];
},
resilient_err: (s, m) => {
  const [slice, cmds] = ac.fail(s.authed, m.key, m);
  return [{ authed: slice }, cmds];
},
deadline_exceeded: (s, m) => {
  const [slice, cmds] = ac.onTimer(s.authed, m);
  return [{ authed: slice }, cmds];
},
```

Time stays data: `attempt` takes `at`, and the settle Msgs carry their own.

## 4. Route a 401 to `on401` — never to `fail`

This is the one decision the module asks you to make. Your run port knows the
HTTP status; a 401 must fork away from the generic failure path, because backing
off and re-issuing the same rejected credential just earns another 401, and
because a rejected credential says nothing about the backend's health:

```ts
// inside update:
unauthorized: (s, m) => {
  const [slice, cmds] = ac.on401(s.authed, m.key, m.at);
  return [{ authed: slice }, cmds];
},
```

The first 401 on a call marks the token `stale`, emits a `refresh_token` Cmd, and
parks the call's input for re-issue. A second 401 on the same call settles it
`failed` with the plain-data `{ _tag: "unauthorized", key }` sentinel — no second
refresh, no loop — and it settles through resilient-call's `settleFailed`, so the
shared circuit breaker is never tripped by a credential problem. The budget
resets on the next fresh `attempt`.

## 5. Install the new token, then re-fire the parked calls

`installToken` folds the minted credential into the auth slice; `onRefreshed`
runs every parked input back through the resilient gate with the new token in
hand. They are split so a proactive refresh can install without re-firing — with
nothing parked, `onRefreshed` returns the slice unchanged by reference:

```ts
// inside update:
token_refreshed: (s, m) => {
  const [slice, cmds] = ac.onRefreshed(ac.installToken(s.authed, m.token), m.at);
  return [{ authed: slice }, cmds];
},
token_refresh_failed: (s) => [s, []],
```

For the proactive path, ask `ac.needsRefresh(s.authed, at)` at your call
boundary — it is true with no token held, and turns true `skewMs` ahead of
expiry.

## 6. Splice both ports and arm the timers

`handlers` wires resilient-call's `resilient_run` and token-refresh's
`refresh_token` in one call, each routed through `tryInterpret` so a rejection
becomes a Msg rather than a throw. `subs` is exactly resilient-call's — the auth
dimension arms no timers of its own:

```ts
import { subscribeDeadline } from "@demlik/tea/authed-call";

interpret: ac.handlers({ run: ctx.call, refresh: () => sdk.mintToken() }),
subscriptions: (s) => ac.subs(s.authed),
subscribe: { deadline: subscribeDeadline },
```

That is the whole wiring: a guarded call retries transient failures on its own
ladder, refreshes-and-retries exactly once on a rejected credential, and settles
with a JSON-serializable error either way. `authed-call` composes
`@demlik/tea/resilient-call` internally, and that subpath is deprecated in favour
of `@demlik/tea/with-resilience` — the deprecation targets the published export,
not the internal role, and this guide never asks you to import it: every symbol
above comes from `@demlik/tea/authed-call`. If you want the resilience battery
without the credential dimension, reach for
[`with-resilience`](./add-resilience.md) instead; if you want backoff folded by
hand into your own reducer, `@demlik/tea/retry-backoff` is the leaf underneath
all of it.
