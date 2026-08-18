# Author a machine as config

To describe a machine as data — one value the State union, the Msg union, the Cmd
union, the `update` table and the diagram are all derived from — write a chart
with `defineChart` from `@demlik/tea/chart` and compile it. The chart owns every
name and every edge; the code you still write is only the arithmetic a drawing
cannot hold.

## 1. Declare the data every state carries

```ts
import { defineChart, ty } from "@demlik/tea/chart";

ctx: ty<{ readonly retries: number; readonly maxRetries: number }>(),
```

`ty<T>()` is an empty object whose type remembers `T`, which is what lets a
payload be declared *in* the chart instead of in a parallel type map you have to
keep in step. `ctx` is intersected into every state; a state that carries extra
data of its own declares it as `data` on the node.

## 2. Declare the event alphabet, with a `scope` each

```ts
events: {
  WIP: { data: ty<{ readonly at: number }>(), scope: "edges" },
  DONE: { data: ty<{ readonly at: number }>(), scope: "edges" },
  BLOCKED: {
    data: ty<{ readonly at: number; readonly reason: string }>(),
    scope: "working",
  },
  PASS: { data: ty<{ readonly at: number }>(), scope: "edges" },
  FAIL: {
    data: ty<{ readonly at: number; readonly reason: string }>(),
    scope: "edges",
  },
  UNBLOCKED: { data: ty<{ readonly at: number }>(), scope: "parked" },
},
```

`scope` answers "where does this event mean anything?" once, on the event,
instead of once per state:

- `"edges"` — targeted. Live exactly where an edge routes it; elsewhere it is not
  *ignored*, it is simply not addressed to that state. No obligation follows.
- a phase name (or a list of them) — broadcast within that phase. Every state
  there must handle it or refuse it by name.
- `"all"` — broadcast machine-wide. Every state must decide.

Pick the narrowest one that is true. A wrong `scope` is not a style problem: it
is the difference between adding a state and being asked one question, and adding
a state and being asked twelve.

### Optionally, say where each event comes from

`scope` says *where* an event is live. `from` says *who sent it* — the other
half, and the one that answers "what is this state waiting on" without anyone
having to recognise a state by name:

```ts
events: {
  WIP:  { scope: "edges",  from: { world: "the operator" } },
  DONE: { scope: "edges",  from: "cmd" },
  TICK: { scope: "all",    from: "sub" },
  UNBLOCKED: { scope: "parked", from: { world: "a human" } },
},
```

Three values and no fourth, because in TEA a Msg has exactly three origins: a
Cmd's result (`"cmd"`), a Sub firing (`"sub"`), or the outside world — and the
world is `{ world: <role> }`, where the role is **yours**. The library
enumerates no roles, so an operator, a shopper, an on-call rota and a webhook
are all expressible. Write the role the way you would say it, article included
(`"the operator"`, `"a human"`): a reader drops it straight into a sentence and
only you know whether there is one of them or any of them.

Optional throughout. Declare none and everything behaves exactly as before;
readers that want provenance (`@demlik/tea/chart/inspect`'s `EventPreview.from`,
`@demlik/tea/chart/report`'s "waiting on" line) then say what they know and
refuse to guess the rest.

## 3. Draw the states, grouped into phases

A phase is declared by being a key of `states`; a state by being a key under a
phase. That grouping is what `scope` quantifies over, so the phases are the
machine's real regions, not decoration:

```ts
states: {
  working: {
    queued: { initial: true, on: { WIP: "build", BLOCKED: "blocked" } },
    build: { on: { DONE: "review", BLOCKED: "blocked" } },
    review: {
      on: {
        PASS: "ship",
        BLOCKED: "blocked",
        FAIL: { target: "build", when: "retriesRemaining", otherwise: "frozen" },
      },
    },
    ship: { on: { DONE: "shipped", BLOCKED: "human:cp-approval" } },
  },
  parked: {
    blocked: { on: { UNBLOCKED: { resume: { fallback: "queued" } } } },
    "human:cp-approval": { on: { UNBLOCKED: { resume: { fallback: "queued" } } } },
  },
  done: {
    shipped: { end: true },
    frozen: { end: true },
  },
},
```

The edge forms, in full:

| Form | Meaning |
|---|---|
| `"build"` | go there |
| `{ target, cmd? }` | go there, firing 0..n Cmds in declaration order |
| `{ target, when, otherwise, cmd?, otherwiseCmd? }` | guarded; each arm names its own target and its own effects |
| `{ resume: { fallback }, cmd? }` | go back where you came from, or to `fallback` |
| `{ to: [...], cell }` | the escape hatch — see [compose a battery inside a chart](./compose-a-battery-inside-a-chart.md) |

`initial: true` marks the entry state — one site, which `initFrom` and the
diagram both read. `end: true` marks a state that accepts nothing; declaring an
edge on it as well is a compile error, not a silent contradiction.

`resume` is not a history pseudostate: it is a property of the edge, and the
`was` field it needs is *injected*, never authored. A state with a `resume` edge
out of it gets `was: ResumeTargets<…>` — the union of every state with an edge
*into* it, plus the declared fallback — so adding a new `BLOCKED` edge widens the
legal `was` with no second edit.

## 4. Discharge totality

Every (state, event) pair the chart makes live is either declared in `on` or
refused. Refuse it either by narrowing the event's `scope`, by `end: true`, or —
per state, by name — with `ignore`:

```ts
idle: {
  initial: true,
  on: { START: "working" },
  ignore: ["FINISHED", "deadline_exceeded"],
},
```

Leave a live pair undecided and the chart does not compile. The diagnostic is the
sentence, naming the pair and every way out of it:

```
Property '"unhandled pair "verifying.cancel" — declare it in `on`, or list
"cancel" in this state's `ignore`, or narrow the `scope` of event "cancel"'
is missing …
```

An `ignore` entry naming an event that is not live at that state is rejected too,
so refusals cannot decay into pasted-back noise.

## 5. Write the parts, and let their use sites type them

The functions live in bags beside the chart, and their parameters are computed by
scanning the graph for the edges that reference them:

```ts
export const guards: Guards<LaneG, LaneState, LaneMsg> = {
  // `s` is EXACTLY the `review` state and `m` is EXACTLY the FAIL msg —
  // derived from the single edge that references this guard.
  retriesRemaining: (s, m) => s.retries < s.maxRetries && m.reason !== "fatal",
};

export const assign: Assigns<LaneG, LaneState, LaneMsg> = {
  "queued.WIP": (s) => ctx(s),
  // guarded edge → `{ then, else }`, each narrowed to ITS target's payload.
  "review.FAIL": {
    then: (s) => ({ retries: s.retries + 1, maxRetries: s.maxRetries }),
    else: (s) => ctx(s),
  },
  // …one entry per declared edge
};
```

`assign` is total over the declared edges: an entry for a pair with no edge is
rejected, and a missing one is reported by name. A helper referenced from *two*
edges receives a third argument, `at`, carrying the site — `switch` on it and the
state and the message narrow together. A cmd's builder owes exactly the payload
the `cmds` section declared for that name, and a cmd that only a cell ever emits
needs no builder at all.

## 6. Compile it into a real machine

```ts
export const update = compile(lane, { assign, guards });

export const laneMachine = defineMachine<LaneState, LaneMsg, LaneCmd, Sub<never>, Record<never, never>>({
  init: initFrom<LaneG, LaneState, LaneCmd>(lane, () => ({ retries: 0, maxRetries: 2 })),
  update,
});
```

`compile` returns a genuine `Transitions<S, M, C>` — no cast, no adapter — and
`initFrom` supplies the `loaded ?? …` rehydrate branch plus the entry state's
name off `initial: true`, so you hand it only that state's data. `guards`,
`cmds` and `cells` are each demanded exactly when the chart names one, and
omitted from the parts type when it does not.

`chartMermaid(lane)` draws the same value, reading the chart rather than
executing it, so the picture cannot lag the machine.

## 7. If the machine has no phase dimension, use the flat form

Some machines are keyed by the message alone: `state.type` is a label the handler
writes, not a dimension it dispatches on. Forcing those into a grid multiplies
every fact by the number of states. `defineReducerChart` drops the dimension —
`states` becomes a flat name list, `initial` a single word, `on` moves to the top
level, and `scope` disappears because the question it answers has no content:

```ts
export const fetchReducerChart = defineReducerChart({
  ctx: ty<{ /* … */ }>(),
  states: ANY,
  initial: "idle",
  cmds: { do_fetch: ty<{ readonly url: string }>() },
  events: {
    fetch: { data: ty<{ readonly url: string; readonly at: number }>() },
    // …
  },
  on: {
    fetch: { to: ATTEMPT, cell: "attempt" },
    fetch_ok: "succeeded",
    fetch_err: { to: ["failed", "waiting_retry"], cell: "onErr" },
    deadline_exceeded: { to: ANY, cell: "retryNow" },
  },
});

export const update = compileReducer(fetchReducerChart, { assign, cells });
```

Totality survives, one quantifier smaller: `on` is a *required* mapped type over
the event alphabet, so an event with no edge is a missing property tsc names —
stronger per-event than the grid form, where `scope: "edges"` lets an event be
routed from nowhere at all. `compileReducer` emits a flat `Reducer<S, M, C>`,
which `defineMachine` accepts directly.

What you give up is the per-state refusal. A grid chart can say "in `done`,
`poll_failed` is dropped" and draw it; a reducer chart cannot, and that decision
goes back inside the cell body. `resume` is rejected for the same reason — `was`
is derived from the states with an edge into the parking state, and with no phase
dimension every edge is reachable from everywhere, so the derivation would say
nothing. The two forms are two functions: flipping a chart from one to the other
is an edit, not a flag.
