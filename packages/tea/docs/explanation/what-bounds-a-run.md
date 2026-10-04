# What each run guard bounds

`defineAgent` takes four optional guards that stop a run: `maxTurns`,
`deadlineMs`, `maxElapsedMs` and `stopWhen`. Each one measures a different
thing, and one of them is easy to misread. `deadlineMs` is not a wall-clock cap.
`maxElapsedMs` is. That is the thing most readers get wrong on the first
afternoon, and this page is about why.

The measurements below come from
[`examples/agent-stop-conditions.ts`](../../examples/agent-stop-conditions.ts),
whose scripted model never stops asking for tools. `modelAsking(napMs)` asks for
one `tick` every turn, and each `tick` naps that many milliseconds.
[Bound a `defineAgent` run](../how-to/bound-a-run.md) is the recipe that sets
the guards, and [`DefineAgentConfig`](../reference/agent.md#DefineAgentConfig)
states what each option does.

## `deadlineMs` is a no-progress watchdog, not a timeout

`deadlineMs` is the one to read carefully. It is milliseconds the run may sit
**without advancing**, and it restarts on every advance. It is not a total
wall-clock cap on the run.

So a run that keeps making progress is not bounded in time by `deadlineMs` at
all, however small you set it. Each advance re-arms the watchdog, and it never
comes due.

Here is that, run for real: a 150ms budget over an agent whose every tool call
naps 20ms and answers.

```ts
const progressing = defineAgent({
  model: modelAsking(20),
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
`maxTurns`, not the deadline. Drop the `maxTurns: 25` and that agent runs forever
with `deadlineMs: 150` set.

What the watchdog does catch is a run that stops moving. A tool call that naps
400ms under the same 150ms budget is 400ms with no advance, and the run fails
with `deadline`. That makes it a liveness guard, and it is good at that job.

`maxElapsedMs` is the guard `deadlineMs` is mistaken for. Its budget counts from
the run's start and never restarts, so an advance buys the run nothing. Here it
is over the same 20ms-tick agent, with the same 150ms budget:

```ts
const capped = defineAgent({
  model: modelAsking(20),
  tools: [tick],
  instructions: "You tick.",
  maxElapsedMs: 150,
});
```

```
maxElapsedMs: 150, progressing → failed with elapsed_limit after 171ms (guard fired at +171ms)
  model calls: 8
```

Eight calls, not twenty-five, and no `maxTurns` in sight.

## Why a turn cap is the spend cap

Round-trips are what you pay for, so `maxTurns` is the closest thing the
[lid](../glossary.md#lid) offers to a cost cap. A compaction pass is not model
reasoning, which is why it never moves the count.

## A guard fails the run; it does not cancel work

Every guard is read at a boundary in the reducer. A tool call or model call that
is out when a guard trips runs to its own end, and `run` settles after it.

The stalling run in the example shows it:

```
deadlineMs: 150, stalling → failed with deadline after 402ms (guard fired at +150ms)
  model calls: 1
```

Note the gap between the two numbers. The watchdog fired on schedule at +150ms,
but `run` settled at 402ms, when the 400ms tool call came back. So even a
deadline that does fire is not an upper bound on how long `run` takes to settle.
That is true of every guard, `maxElapsedMs` included. A hard upper bound has to
come from outside the run.

## Why a `stopWhen` stop is not a failure

A `stopWhen` run **resolves**. The other three guards make `run` reject. A stop
you asked for is not a failure, so the run ends `cancelled`, the same terminal
an aborted `signal` reaches, and the transcript stands.

The predicate sees the whole [Model](../glossary.md#model), and two limits
follow from where it lives.

It has to be pure, because the reducer calls it. A replay of the same run hands
it the same state and must get the same answer. A predicate that reads
`Date.now()`, a mutable counter or the network makes the run unreplayable.

It is config, not state. A function cannot be persisted, so a resumed run is
governed by the `stopWhen` passed to that boot, exactly as it uses the
`maxTurns` passed to that boot.

## What the token total counts

tea never estimates a token. It reads only the `usage` the provider reported
for a call, so a model that reports none gets a zero total and never triggers a
size-based fold.

The agent keeps two readings. `state.usage` is the run's running total, every
turn's report summed. `conversation.contextTokens` is the last turn's
`inputTokens + outputTokens`: how full the context window is now. A token budget
is a `stopWhen` over the first, and a size-based fold is
`compaction.afterContextTokens` over the second.

In the example's budgeted run, eleven brain turns went out and the eleventh took
the total past 60k, so the run ended `cancelled` there, like any `stopWhen`.
Twice before that, the last call's reported size reached 8k and the oldest turns
were folded into a summary before the next call. What follows from how the two
readings work:

- **A fold does not reduce the total.** The folded turns were still paid for. It
  clears the context size, so a stale reading from before the fold can't
  trigger a second fold before the next turn reports the new size.
- **The budget overshoots by up to one turn.** Like every guard it is read at
  the turn boundary, so the turn that crosses it has already been paid for.
- **The total survives a kill.** Each turn's usage is saved with the turn, so a
  resumed run adds up to the same total as one that was never interrupted.
- **The total survives the end of the run.** It belongs to the run, not to a
  stage's conversation, so a stage advance keeps it and so does `done`, which
  clears the conversation. `RunDone`'s `done` status carries it too.
- **Summaries are not counted.** Only brain turns add to the total. The
  summarize call's own cost is not tracked yet.

## Compaction is not a guard

`compaction` answers a question readers arrive with: "how do I stop this thing
sending a bigger prompt every turn". It is not a guard, because nothing fails.
Once the conversation is too long, the oldest turns are replaced by one
model-written summary before the next call, so the transcript stops growing
while the run goes on.

Compaction keeps the prompt payable. Only a guard ends the run.

## See also

- [Bound a `defineAgent` run](../how-to/bound-a-run.md): the steps that set each
  guard, and all four together.
- [`DefineAgentConfig` reference](../reference/agent.md#DefineAgentConfig): what
  each option counts, where its failure lands, and what a resume does to it.
- [What durability actually promises](./durability-model.md): the save-then-run
  order that makes a killed run resumable in the first place.
