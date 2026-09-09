# Bound a `defineAgent` run

**Goal:** stop an agent run that would otherwise go on forever — and know which
of the two guards actually bounds what you think it bounds.

`defineAgent` takes two optional stop conditions, `maxTurns` and `deadlineMs`.
Omit both and the run is unbounded: it ends only when the model stops asking for
tools. Neither one is a wall-clock cap, and that is the thing most readers get
wrong on the first afternoon.

Every sample below is quoted from
[`examples/agent-stop-conditions.ts`](../../examples/agent-stop-conditions.ts),
which runs in-process with a scripted model that never stops asking for tools.

## `maxTurns` — cap the model round-trips

`maxTurns` is the livelock guard. It counts **completed model round-trips**, and
once that count reaches the number the run fails rather than calling the model
again.

```ts
const bounded = defineAgent({
  model,
  tools: [tick],
  instructions: "You tick.",
  maxTurns: 3,
});
```

That run makes exactly three model calls and then fails:

```
maxTurns: 3 → failed with turn_limit after 73ms (guard fired at +72ms)
  model calls: 3
```

The rejection is a `DriveFailedError` carrying the final Model on `.state`, and
the reason is on the agent's own failure field:

```ts
try {
  await bounded.run("go");
} catch (error) {
  if (error instanceof DriveFailedError) {
    // A caught error narrows to `DriveFailedError<unknown>`, so name the shape
    // you are reading off the final Model.
    const state = error.state as { failure?: { reason: string; at: number } };
    console.log(state.failure); // { reason: "turn_limit", at: <ms> }
  }
}
```

Two things do **not** move the count. A compaction pass is not model reasoning,
so it never trips `maxTurns`; and tool calls are not counted at all — a turn that
asks for six tools is one turn.

This is the guard to reach for when what you want is a spend ceiling. Round-trips
are what you pay for, so a turn cap is the closest thing the lid offers to a cost
cap.

## `deadlineMs` — a no-progress watchdog, not a timeout

`deadlineMs` is the one to read carefully. It is **milliseconds the run may sit
without advancing**, and it restarts on every advance. It is not a total
wall-clock cap on the run.

Concretely: a run that keeps making progress is **not bounded in time by
`deadlineMs` at all**, however small you set it. Each advance re-arms the
watchdog, so it never comes due.

Here is that, run for real — a 150ms budget over an agent whose every tool call
naps 20ms and answers:

```ts
const progressing = defineAgent({
  model,
  tools: [tick],
  instructions: "You tick.",
  deadlineMs: 150,
  maxTurns: 25,
});
```

```
deadlineMs: 150, progressing → failed with turn_limit after 748ms (guard fired at +745ms)
  model calls: 25
```

The run took 748ms and 25 model calls under a 150ms budget, and what ended it was
`maxTurns` — not the deadline. Drop the `maxTurns: 25` and that agent runs
forever with `deadlineMs: 150` set.

What the watchdog *does* catch is a run that stops moving. Same 150ms budget,
same agent, one tool call that naps 400ms:

```ts
const stalling = defineAgent({
  model,
  tools: [tick],
  instructions: "You tick.",
  deadlineMs: 150,
});
```

```
deadlineMs: 150, stalling → failed with deadline after 407ms (guard fired at +156ms)
  model calls: 1
```

That failure lands on the monitored-run slice rather than the agent's own field —
`error.state.run.failure` is `{ reason: "deadline", at: <ms> }`.

Note the gap between the two numbers on that line. The watchdog fired on schedule
at +156ms, but `run` settled at 407ms: the guard **fails the run, it does not
cancel work already in flight**. So even a deadline that does fire is not an
upper bound on how long `run` takes to settle.

Reach for `deadlineMs` when what you are defending against is a hang — a tool
waiting on something that will never answer, a provider that accepted the request
and went quiet. It is a liveness guard, and it is good at that job.

## Which guard bounds what

| You want to bound | Use | What it actually does |
| --- | --- | --- |
| Model round-trips, and so roughly spend | `maxTurns` | Fails the run when the completed-turn count reaches it |
| A run that has hung | `deadlineMs` | Fails the run after that long with **no advance**; restarts on each advance |
| Total wall-clock time | — | Not available today — see below |
| An arbitrary condition on the state | — | Not available today — see below |

Use both together for the common case. `maxTurns` bounds the run's length,
`deadlineMs` bounds any one stall inside it, and neither substitutes for the
other.

## What is not available today

There is no wall-clock cap and no custom stop predicate on `defineAgent`. A
`maxElapsedMs` that ends a run at N milliseconds however well it is progressing,
and a `stopWhen(state) => boolean` that ends it on a condition you name, are both
tracked in [#153](https://github.com/kamp-us/demlik/issues/153).

Until then, if you need a true wall-clock cap, put it outside the run — race
`agent.run(...)` against your own timer, and remember that losing the race
abandons the run rather than stopping it.

## See also

- [`defineAgent` reference](../reference/agent.md) — the full config surface.
- [Handle a tool failure](./handle-a-tool-failure.md) — the per-tool `timeoutMs`
  and `retry` knobs, which bound one **call** rather than the run.
