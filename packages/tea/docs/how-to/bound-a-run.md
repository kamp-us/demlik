# Bound a `defineAgent` run

**Goal:** stop an agent run that would otherwise go on forever — and know which
of the four guards actually bounds what you think it bounds.

`defineAgent` takes four optional stop conditions: `maxTurns`, `deadlineMs`,
`maxElapsedMs` and `stopWhen`. Omit them all and the run is unbounded: it ends
only when the model stops asking for tools. `deadlineMs` is not a wall-clock cap
— `maxElapsedMs` is — and that is the thing most readers get wrong on the first
afternoon.

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
maxTurns: 3 → failed with turn_limit after 8ms (guard fired at +8ms)
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
watchdog, so it never comes due. `maxElapsedMs`, below, is the guard that does
bound it.

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
deadlineMs: 150, progressing → failed with turn_limit after 531ms (guard fired at +531ms)
  model calls: 25
```

The run took 531ms and 25 model calls under a 150ms budget, and what ended it was
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
deadlineMs: 150, stalling → failed with deadline after 402ms (guard fired at +150ms)
  model calls: 1
```

That failure lands on the monitored-run slice rather than the agent's own field —
`error.state.run.failure` is `{ reason: "deadline", at: <ms> }`.

Note the gap between the two numbers on that line. The watchdog fired on schedule
at +150ms, but `run` settled at 402ms: the guard **fails the run, it does not
cancel work already in flight**. So even a deadline that does fire is not an
upper bound on how long `run` takes to settle — and that is true of every guard
here, `maxElapsedMs` included.

Reach for `deadlineMs` when what you are defending against is a hang — a tool
waiting on something that will never answer, a provider that accepted the request
and went quiet. It is a liveness guard, and it is good at that job.

## `maxElapsedMs` — the total wall-clock cap

`maxElapsedMs` is the guard `deadlineMs` is mistaken for: **total milliseconds
from the run's start**, whether or not it is progressing. The budget never
restarts, so an advance buys the run nothing.

Here it is over the *same* 20ms-tick agent that sailed past the 150ms deadline
above — same budget, same ticks:

```ts
const capped = defineAgent({
  model,
  tools: [tick],
  instructions: "You tick.",
  maxElapsedMs: 150,
});
```

```
maxElapsedMs: 150, progressing → failed with elapsed_limit after 171ms (guard fired at +171ms)
  model calls: 8
```

Eight calls, not twenty-five, and no `maxTurns` in sight. The reason is on the
failure field: `{ reason: "elapsed_limit", at: <ms> }`, on the agent's own
`state.failure` beside `turn_limit`.

Two things worth knowing before you set it:

- It is read **at the turn boundary**, so it ends the run at the first boundary
  past the budget, not at the millisecond it comes due. A run 10ms into a 400ms
  tool call under a 150ms budget fails when that tool settles.
- The run's start time is on the durable Model, so **a killed and resumed run
  continues the original budget**. The hours a crashed run spent dead count
  against it, and a resume does not hand it a fresh 150ms.

Reach for `maxElapsedMs` when the thing you owe someone is an answer by a
deadline. Reach for `maxTurns` when the thing you are protecting is a bill.

## `stopWhen` — your own condition

`stopWhen` is a predicate consulted at the turn boundary, after the other three
guards have passed, over the run's durable Model. Answer `true` and the run ends
there — no further model call.

```ts
const untilFive = defineAgent({
  model,
  tools: [tick],
  instructions: "You tick.",
  stopWhen: (state) => (state.conversation?.turnCount ?? 0) >= 5,
});
```

```
stopWhen: turnCount >= 5 → resolved after 7ms
  model calls: 5
```

Read the verb: **resolved**, not failed. A stop you asked for is not a failure,
so the run ends `cancelled` — the same terminal an aborted `signal` reaches — and
`run` resolves with the final Model instead of rejecting. `status(state)` answers
`{ kind: "cancelled", at }`, and the transcript stands.

The example's condition is one `maxTurns` would also express. The point is the
ones it would not: a token ledger you keep yourself, an external flag, a
condition on the content of the turns so far. The predicate sees the whole Model.

Two rules come with it:

- **It must be pure.** The reducer calls it, so a replay of the same run hands it
  the same state and must get the same answer. A predicate that reads
  `Date.now()`, a mutable counter or the network makes the run unreplayable —
  and if elapsed time is what you want to bound, that is `maxElapsedMs`.
- **It is config, not state.** A function cannot be persisted, so a resumed run
  is governed by the `stopWhen` you passed to *this* boot — exactly as it uses
  the `maxTurns` you passed to this boot. Pass it on every resume, or the resumed
  run has no predicate.

## Which guard bounds what

| You want to bound | Use | What it actually does |
| --- | --- | --- |
| Model round-trips, and so roughly spend | `maxTurns` | Fails the run when the completed-turn count reaches it |
| A run that has hung | `deadlineMs` | Fails the run after that long with **no advance**; restarts on each advance |
| Total wall-clock time | `maxElapsedMs` | Fails the run at the first turn boundary past that long since it started, progressing or not |
| A condition only you can see | `stopWhen` | Ends the run **cancelled** at the turn boundary your predicate answers `true` on |
| How long the prompt gets | `compaction` | Folds the oldest turns into one summary instead of failing anything |

Use them together for the common case. `maxTurns` bounds the run's length,
`deadlineMs` bounds any one stall inside it, `maxElapsedMs` bounds the whole
thing by the clock, and none of them substitutes for another.

`compaction` is in the table because it answers a question readers arrive with —
"how do I stop this thing sending a bigger prompt every turn" — but it is not a
guard: nothing fails. Set `compaction: { afterTurns: 20 }` and once the
conversation holds twenty turns the oldest are replaced by one model-written
summary before the next call, so the transcript stops growing while the run goes
on. `keepTurns` says how many of the newest survive the fold intact. A long run
usually wants this **and** `maxTurns`: compaction keeps the prompt payable, and
only the guard ends the run.

## What no guard here does

None of them cancels work already in flight. Every one is read at a boundary in
the reducer, so a tool call or model call that is out when a guard trips runs to
its own end and `run` settles after it — the 402ms line above is that, measured.
A hard upper bound on how long `run` takes to settle has to come from outside the
run: race `agent.run(...)` against your own timer, and remember that losing the
race abandons the run rather than stopping it.

## See also

- [`defineAgent` reference](../reference/agent.md) — the full config surface.
- [Handle a tool failure](./handle-a-tool-failure.md) — the per-tool `timeoutMs`
  and `retry` knobs, which bound one **call** rather than the run.
