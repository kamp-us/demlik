# Build a machine from a chart

In this lesson you build a working machine without writing a Model type, a Msg
union, or an `update` record. You write one value — a *chart* — and derive all
three from it. By the end you will have a compiled `Transitions` table that drops
into `defineMachine` untouched, and you will have watched the compiler refuse a
machine that forgot to decide something.

You need the root package and the chart module:

```ts
import { type Sub, defineMachine, run } from "@demlik/tea";
import {
  type CmdOf,
  type Cmds,
  type MsgOf,
  type StateOf,
  chartMermaid,
  compile,
  defineChart,
  initFrom,
  ty,
} from "@demlik/tea/chart";
```

The machine you are building runs a CI build: a commit is submitted, the build
either ships or fails, and it can be cancelled while it is running.

## Declare the data every state carries

`ctx` is the slice every state of the machine holds. It is written once, not once
per state, and it is smuggled through a value position by `ty<T>()` — an empty
object at runtime whose *type* remembers what you handed it:

```ts
ctx: ty<{ readonly attempts: number; readonly maxAttempts: number }>(),
```

## Name the events, and say where each one means anything

Events are declared by being keys under `events`. Each one carries its own
payload and its own `scope`, which answers a question you would otherwise answer
once per state: *where does this event mean anything?*

```ts
events: {
  submit: { data: ty<{ readonly sha: string }>(), scope: "edges" },
  ok: { scope: "edges" },
  err: { data: ty<{ readonly reason: string }>(), scope: "edges" },
  cancel: { scope: "live" },
},
```

`scope: "edges"` means *targeted*: the event is live exactly where an edge routes
it, and is not addressed to any other state. `scope: "live"` means *broadcast
within the `live` phase*: every state in that phase must handle `cancel` or
refuse it by name. You will see the compiler enforce that in a moment.

## Name the effects

Effects get the same treatment — one declaration, with the payload the Cmd
carries. The Cmd union is derived from this section:

```ts
cmds: {
  start_build: ty<{ readonly sha: string }>(),
  notify: ty<{ readonly reason: string }>(),
},
```

## Draw the states, grouped by phase

States are declared by being keys under a phase, and a phase is declared by being
a key of `states`. A state's `on` bag routes the events it accepts; `initial:
true` marks the entry; `end: true` marks a state that accepts nothing:

```ts
states: {
  live: {
    idle: {
      initial: true,
      on: { submit: { target: "building", cmd: "start_build" } },
      ignore: ["cancel"],
    },
    building: {
      data: ty<{ readonly sha: string }>(),
      on: {
        ok: "shipped",
        err: {
          target: "building",
          when: "hasAttempts",
          otherwise: "failed",
          cmd: "start_build",
          otherwiseCmd: "notify",
        },
        cancel: "cancelled",
      },
    },
  },
  over: {
    shipped: { end: true },
    failed: { end: true },
    cancelled: { end: true },
  },
},
```

Three things worth reading twice. `idle` refuses `cancel` by name — there is
nothing to cancel yet, and that refusal is a fact about the machine, so it is
written in the chart. `building` carries `data` of its own, on top of `ctx`. And
the `err` edge is guarded: `when` names a guard, `otherwise` names the other
target, and each arm fires its own effects, so *which* effects fire is visible in
the drawing instead of buried in a function body.

Wrap the whole value in `defineChart` and the machine's three unions exist:

```ts
export const build = defineChart({ /* the four sections above */ });

export type BG = typeof build;
export type BState = StateOf<BG>;
export type BMsg = MsgOf<BG>;
export type BCmd = CmdOf<BG>;
```

## Write only the parts a drawing cannot hold

A chart owns names, edges, payload shapes and the totality obligation. It cannot
own arithmetic. Those bits go in separate bags, and each function is typed by
*where the chart uses it*:

```ts
export const cmds: Cmds<BG, BState, BMsg> = {
  start_build: (s, m, at) =>
    at === "idle.submit" ? { sha: m.sha } : { sha: s.sha },
  notify: (_s, m) => ({ reason: m.reason }),
};
```

`start_build` is fired from two edges, so it receives a third argument, `at`,
naming the site. Switch on it and `s` and `m` narrow together: in the
`"idle.submit"` branch the sha is on the message, and in the other branch — the
retry arm of `building.err` — it is on the state. Read `m.sha` in the wrong
branch and it is a compile error, because there the message is an `err`.

The `assign` bag supplies each edge's payload, and the guard bag supplies the
`when`:

```ts
export const update = compile(build, {
  assign: {
    "idle.submit": (s, m) => ({
      attempts: 1,
      maxAttempts: s.maxAttempts,
      sha: m.sha,
    }),
    "building.ok": (s) => ({ attempts: s.attempts, maxAttempts: s.maxAttempts }),
    "building.err": {
      then: (s) => ({
        attempts: s.attempts + 1,
        maxAttempts: s.maxAttempts,
        sha: s.sha,
      }),
      else: (s) => ({ attempts: s.attempts, maxAttempts: s.maxAttempts }),
    },
    "building.cancel": (s) => ({
      attempts: s.attempts,
      maxAttempts: s.maxAttempts,
    }),
  },
  guards: { hasAttempts: (s) => s.attempts < s.maxAttempts },
  cmds,
});
```

The guarded edge gets `{ then, else }`, each returning *its own* target's
payload — `then` lands on `building`, which has a `sha`, and `else` lands on
`failed`, which does not.

## Run it

`compile` returns a real `Transitions` table, so it goes straight into
`defineMachine`. `initFrom` reads the state you marked `initial: true`, so the
entry state's name is never written a second time — you supply only its data:

```ts
export const builder = defineMachine<BState, BMsg, BCmd, Sub<never>, Record<never, never>>({
  init: initFrom<BG, BState, BCmd>(build, () => ({ attempts: 0, maxAttempts: 3 })),
  update,
  interpret: {
    start_build: async () => undefined,
    notify: async () => undefined,
  },
});

const runtime = await run(builder, {
  ctx: {},
  terminal: (s: BState) => s.type === "shipped",
}).ready;

await runtime.dispatch({ type: "submit", sha: "9f2c1ab" });
console.log(runtime.getState().type); // "building"

await runtime.dispatch({ type: "err", reason: "flaky test" });
console.log(runtime.getState().type); // "building" — a retry was left

await runtime.dispatch({ type: "ok" });
console.log((await runtime.done()).type); // "shipped"
await runtime.stop();
```

## The payoff — add a state and watch it go red

Here is why the chart was worth writing as data. Add a state to the `live` phase
and route only the events you were thinking about:

```ts
live: {
  verifying: { on: { ok: "shipped", err: "failed" } },
  // …idle and building, unchanged
}
```

`cancel` is scoped to the whole `live` phase, so the new state owes a decision
about it and has not made one. The compiler says so, and the diagnostic *is* the
sentence:

```
Property '"unhandled pair "verifying.cancel" — declare it in `on`, or list
"cancel" in this state's `ignore`, or narrow the `scope` of event "cancel"'
is missing …
```

Three fixes, named, on the pair that is actually open. You never enumerated
`verifying × cancel` anywhere; you said once that `cancel` means something
throughout `live`, and adding a state to that phase re-asked the question.

The same value is also the drawing:

```ts
console.log(chartMermaid(build));
// stateDiagram-v2
//   direction TB
//   [*] --> idle
//   idle --> building : submit
//   building --> shipped : ok
//   building --> building : err
//   building --> failed : err [!hasAttempts]
//   building --> cancelled : cancel
//   shipped --> [*]
//   failed --> [*]
//   cancelled --> [*]
```

No sampling, no execution — it reads the chart, because the chart is where the
edges live. That is the whole bargain of the config form: one value that the
types, the runtime table and the picture are all derived from, so none of the
three can drift from the other two.

Next: [author a machine as config](../how-to/author-a-machine-as-config.md) for
the task-shaped version of this, and [why charts keep their
types](../explanation/why-charts-keep-their-types.md) for the mechanism that
makes the narrowing above possible.
