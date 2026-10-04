# Bound a `defineAgent` run

**Goal:** stop an agent run that goes on too long. Each step adds one of the four
guards `defineAgent` takes, `maxTurns`, `deadlineMs`, `maxElapsedMs` and
`stopWhen`, and the last step puts all four on one agent.

Omit them all and the run is unbounded: it ends only when the model stops asking
for tools.

This page is the steps. What each guard measures, and why `deadlineMs` is not the
wall-clock cap it reads as, is in
[What each run guard bounds](../explanation/what-bounds-a-run.md). Each option's
exact behaviour is on
[`DefineAgentConfig`](../reference/agent.md#DefineAgentConfig) in the reference.

Every sample below is quoted from
[`examples/agent-stop-conditions.ts`](../../examples/agent-stop-conditions.ts),
which runs in-process with a scripted model that never stops asking for tools:
`modelAsking(napMs)` asks for one `tick` every turn, and each `tick` naps that
many milliseconds. They use these imports:

```ts
import { defineAgent, status } from "@demlik/tea/agent";
import { DriveFailedError } from "@demlik/tea";
```

## 1. Cap the model round-trips with `maxTurns`

Set `maxTurns` to the most model calls the run may make. Round-trips are what
you pay for, so this is the guard to set when you are protecting a bill.

```ts
const bounded = defineAgent({
  model: modelAsking(1),
  tools: [tick],
  instructions: "You tick.",
  maxTurns: 3,
});
```

That run makes three model calls and then fails:

```
maxTurns: 3 → failed with turn_limit after 8ms (guard fired at +8ms)
  model calls: 3
```

Catch the rejection to read which guard ended the run:

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

## 2. Catch a hang with `deadlineMs`

Set `deadlineMs` to the longest the run may sit without moving. Use it against a
tool waiting on something that will never answer, or a provider that accepted
the request and went quiet.

```ts
const stalling = defineAgent({
  model: modelAsking(400),
  tools: [tick],
  instructions: "You tick.",
  deadlineMs: 150,
});
```

One tool call naps 400ms under the 150ms budget, so the run fails:

```
deadlineMs: 150, stalling → failed with deadline after 402ms (guard fired at +150ms)
  model calls: 1
```

Read this failure off `error.state.run.failure`. Step 1's `error.state.failure`
is empty for this guard.

Do not use `deadlineMs` to cap total time. A run that keeps moving never trips
it. Step 3 sets the guard that does.

## 3. Cap total time with `maxElapsedMs`

Set `maxElapsedMs` to the total milliseconds the run may take from its start.
Use it when you owe someone an answer by a deadline.

```ts
const capped = defineAgent({
  model: modelAsking(20),
  tools: [tick],
  instructions: "You tick.",
  maxElapsedMs: 150,
});
```

The run fails at the first turn boundary past 150ms:

```
maxElapsedMs: 150, progressing → failed with elapsed_limit after 171ms (guard fired at +171ms)
  model calls: 8
```

Read the reason off `error.state.failure`, as in step 1.

## 4. Stop on your own condition with `stopWhen`

Pass `stopWhen` a predicate over the run's state. Return `true` and the run ends
there, with no further model call.

```ts
const untilFive = defineAgent({
  model: modelAsking(1),
  tools: [tick],
  instructions: "You tick.",
  stopWhen: (state) => (state.conversation?.turnCount ?? 0) >= 5,
});
```

```
stopWhen: turnCount >= 5 → resolved after 7ms
  model calls: 5
```

This run resolved, so there is nothing to catch. `run` hands back the final
state, and `status(state).kind` is `"cancelled"`.

The example's condition is one `maxTurns` would also express. Write a
`stopWhen` for the ones it would not: a token budget (step 5), an external flag,
a condition on the content of the turns so far.

Two things to do when you write one:

- Keep it pure. Do not read `Date.now()`, a mutable counter or the network in
  it. To bound elapsed time, use `maxElapsedMs`.
- Pass it on every resume. A resumed run uses the `stopWhen` you hand that boot,
  and has no predicate if you hand it none.

## 5. Budget tokens, and fold the transcript by size

Skip this step if your model reports no `usage`. Both settings read the token
counts the provider reported for each call. The tutorial's Anthropic adapter
[maps them](../tutorial/build-a-durable-agent.md#give-the-agent-a-brain).

Write the budget as a `stopWhen` over `state.usage`, the run's running total.
Set `compaction.afterContextTokens` to fold the oldest turns into a summary once
the last call's size reaches it, and `keepTurns` to how many of the newest turns
to keep as they are.

```ts
const budgeted = defineAgent({
  model: modelReporting(),
  tools: [tick],
  instructions: "You tick.",
  compaction: { afterContextTokens: 8_000, keepTurns: 1 },
  stopWhen: ({ usage }) => usage.inputTokens + usage.outputTokens >= 60_000,
});
```

```
token budget 60k → cancelled
  model calls: 13 of which summaries: 2
  spent: { inputTokens: 68000, outputTokens: 550 }
```

Set the budget below your real limit by one turn's worth: the run spent 68k
against a 60k budget. When the run ends, read what it spent off `state.usage`,
or off `status(state).usage` when `status(state).kind === "done"`.

To fold by turn count instead, set `compaction: { afterTurns: 20 }`.

## 6. Put all four on one agent

Set the guards together. `maxTurns` bounds the run's length, `deadlineMs` bounds
any one stall inside it, `maxElapsedMs` bounds the whole thing by the clock, and
none of them substitutes for another.

```ts
const guarded = defineAgent({
  model: modelAsking(20),
  tools: [tick],
  instructions: "You tick.",
  maxTurns: 25,
  deadlineMs: 150,
  maxElapsedMs: 300,
  stopWhen: ({ usage }) => usage.inputTokens + usage.outputTokens >= 60_000,
});
```

The first guard to trip ends the run. Here it is the wall-clock cap:

```
all four → failed with elapsed_limit after 300ms (guard fired at +300ms)
  model calls: 14
```

A long run usually wants `compaction` beside these, as in step 5. Compaction
keeps the prompt payable, and only a guard ends the run.

That agent is bounded by all four guards. One thing is still open: a guard does
not cancel a tool call or model call that is already out, so `run` can settle
later than the guard fired. If you need a hard limit on how long `run` takes to
settle, race `agent.run(...)` against your own timer. Losing that race abandons
the run. It does not stop it.

## See also

- [What each run guard bounds](../explanation/what-bounds-a-run.md): why
  `deadlineMs` is a no-progress watchdog, why a guard does not cancel work in
  flight, and what the token total counts.
- [`DefineAgentConfig` reference](../reference/agent.md#DefineAgentConfig): each
  option's exact behaviour, and the rest of the config.
- [Handle a tool failure](./handle-a-tool-failure.md): the per-tool `timeoutMs`
  and `retry` knobs, which bound one **call** rather than the run.
