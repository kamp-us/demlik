# Debounce an input burst without a live timer

To coalesce a bursty stream — keystrokes, cursor moves, webhook re-deliveries —
into one settled emit whose gate state survives an eviction, spread
`@demlik/tea/throttled-input`'s knob into your machine: the pending value, the
rate cursor, and the dedupe cache all become Model fields instead of a
`setTimeout` in a closure.

## 1. Pick the machine, not the callable

`@demlik/tea/debounce` and `@demlik/tea/throttle` are the two primitives, and
they live at the host boundary: `debounce(fn, ms)` returns a callable holding a
live timer handle and the mutable pending args. That is the right shape for a
genuinely noisy host event, and it is what the `debounced-search` example uses:

```ts
import { debounce } from "@demlik/tea/debounce";

const fireSettled = debounce((query: string) => {
  void runtime.dispatch({ type: "search_window_settled", query });
}, 200);
```

A closure cannot be persisted and cannot be replayed. The moment the value being
held has to survive a Durable Object eviction — or the moment you want to
`replay` the burst in a test — you need the same semantics expressed as data.
`throttled-input` is that: not a third algorithm, a TEA machine over the two.
Both primitives are re-exported from its subpath, so pre-coalescing a bursty host
source *before* it becomes a Msg stays one import away.

## 2. Declare the gates once

Every gate field is optional — omit a brick, omit its gate. `throttleMs` caps the
emit rate, `debounceMs` is the settle wait, `cacheTtlMs` dedupes. `emit` is a
pure Cmd constructor, never a side effect:

```ts
import {
  createThrottledInput,
  type ThrottledInputConfig,
} from "@demlik/tea/throttled-input";
import type { Cmd } from "@demlik/tea";

type RunSearch = Cmd<"run_search"> & { readonly query: string };

const searchGate: ThrottledInputConfig<string, RunSearch> = {
  debounceMs: 200, // wait for the typing to stop
  throttleMs: 1_000, // but never fire more than once a second in a long burst
  cacheTtlMs: 30_000, // and skip a query already run within 30s
  cacheKey: (q) => q,
  emit: (query) => ({ type: "run_search", query }),
};

const gate = createThrottledInput(searchGate);
```

`cacheKey` is required whenever `cacheTtlMs` is set — there is no
`String(value)` fallback, so two structured values can never collapse into one
cache slot. For a `{ term, page }` value you name the identity yourself:

```ts
cacheKey: (q) => `${q.term}#${q.page}`, // identity is BOTH fields
```

## 3. Carry the slice in your Model

`ThrottledInput<V>` is `{ lastAt, pending, cache? }` — plain JSON, so it
round-trips through any `Store`. Seed it with `gate.init()`, which attaches the
cache field only when `cacheTtlMs` is configured:

```ts
import type { ThrottledInput } from "@demlik/tea/throttled-input";

interface State {
  readonly search: ThrottledInput<string>;
  readonly hits: readonly string[];
}

// inside defineMachine:
init: (loaded) => [loaded ?? { search: gate.init(), hits: [] }, []],
```

## 4. Feed each input through the gates

`gate.input` is pure: the arrival instant is a parameter, so the reducer never
reads a clock. It returns the next slice and the Cmds — one `emit` Cmd when a
value passes the gates, none while it is held, dropped, or deduped:

```ts
// inside update:
typed: (s, m) => {
  const [search, cmds] = gate.input(s.search, m.value, m.at);
  return [{ ...s, search }, cmds];
},
```

Nothing fires here during a burst. A keystroke inside the settle window
overwrites `pending` — the trailing edge carries the last value — and a
rate-blocked keystroke is *held* rather than dropped, so the final sample of a
window is never lost.

## 5. Let the settle deadline close the window

The settle timer is a `@demlik/tea/deadline` Sub, so the module re-exports the
deadline wiring rather than redrawing it. `subsFor` arms the Sub only while a
value is held, targeting the later of `pending.at + debounceMs` and
`lastAt + throttleMs` — the earliest instant the rate cap actually permits:

```ts
import {
  onFlush,
  subsFor,
  subscribeThrottledInput,
  type ThrottledInputSettled,
  type ThrottledInputSub,
} from "@demlik/tea/throttled-input";

type Msg =
  | { readonly type: "typed"; readonly value: string; readonly at: number }
  | ThrottledInputSettled;

// inside defineMachine<State, Msg, RunSearch, ThrottledInputSub, Ctx>:
update: {
  deadline_exceeded: (s, m) => {
    const [search, cmds] = onFlush(searchGate, s.search, m.atMs);
    return [{ ...s, search }, cmds];
  },
},
subscriptions: (s) => subsFor(searchGate, s.search),
subscribe: { deadline: subscribeThrottledInput },
```

`subsFor` is the free form of `gate.subs`, typed to `ThrottledInputSub` so it
matches the machine's Sub parameter. The reconcile pass does the lifecycle: an
`onFlush` that clears `pending` drops the Sub and the pending timer is cleared;
a sliding keystroke re-stamps `pending.at` and a fresh absolute target is armed.
`onFlush` re-checks the rate gate anyway, so an early or stale timer re-holds the
value instead of breaching the cap.

## 6. Assert the burst instead of waiting for it

Because every transition is a Msg over pure state, the whole gate replays. No
fake timers, no runtime — fold the keystrokes and the settle Msg and check the
one Cmd that came out:

```ts
import { bindMachine } from "@demlik/tea/testing";

const t = bindMachine(machine, ctx);

t.expectCmdSequence(
  {
    msgs: [
      { type: "typed", value: "h", at: 1_000_000 },
      { type: "typed", value: "he", at: 1_000_050 },
      { type: "typed", value: "hel", at: 1_000_100 },
      { type: "deadline_exceeded", id: "throttled-input:settle", atMs: 1_000_300 },
    ],
  },
  [{ type: "run_search", query: "hel" }], // coalesced to the final keystroke
);
```

That is the payoff: a burst that collapses to one effect, a rate cap that holds
across the trailing edge, and a dedupe window — with nothing in a closure, so the
gate resumes mid-burst after an eviction (see
[Make a machine durable and crash-recoverable](./make-durable.md)) and every
scenario above is a `replay` away. Pass a distinct `id` to `subsFor` when one
machine runs several gates; reach for `@demlik/tea/debounce` directly when the
noisy thing is a host event that should never have become a Msg at all.
