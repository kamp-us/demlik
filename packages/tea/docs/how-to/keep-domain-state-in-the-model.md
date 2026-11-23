# Keep an agent's domain state in its Model

**Goal:** keep the facts your host decides on (a stage, a running tally, what
the agent has seen) inside the agent's Model, so `stopWhen` and `continueWhen`
read them directly and every Store saves them with the rest of the run.

Without this, a host folds the whole conversation again on every model call,
`stopWhen` and `continueWhen`. That costs more as the run grows, and the result
lives outside the Model, so a resumed run and `replayTrace` never see it.

## Write the slice and its step

The slice is plain data. `step` takes the slice and one event the agent has
just settled, and returns the next slice:

```ts
interface Triage {
  readonly stage: "reading" | "closing";
  readonly open: readonly string[];
  readonly missing: number;
}

function step(
  slice: Triage,
  event: AgentDomainEvent<ToolResult<typeof lookup>>,
): Triage {
  if (event._tag !== "tool") return slice;
  const { call, outcome } = event;
  if (outcome.kind === "error") {
    return { ...slice, missing: slice.missing + 1 };
  }
  if (!outcome.result.open) return { ...slice, stage: "closing" };
  return { ...slice, open: [...slice.open, String(call.args.id)] };
}
```

`AgentDomainEvent` has four arms, one for each thing the agent's transcript
records:

| `_tag` | When | Carries |
| --- | --- | --- |
| `turn` | a model turn settled | `turn`: the `AgentTurn`, with its `usage` and `provider` |
| `tool` | a tool call settled, including a ladder `timeout` | `call` and its `outcome` |
| `nudge` | `continueWhen` answered an empty turn | `nudge`: its `turn` index and `text` |
| `compaction` | the oldest turns were folded into a summary | `folded`, the count, and `summary` |

Every arm carries `at`, the transition's clock. A brain retry, a re-fired boot,
a failed compaction and a tool's late result after its timeout fold nothing, so
`step` sees none of them.

`step` must be pure. Read `event.at` rather than a clock, read no randomness,
and return new objects rather than changing the slice. In dev the slice `step`
receives is frozen, so an assignment throws. Keep the slice to plain JSON: no
`Map`, `Set`, `Date`, class instance or function.

## Give it to the agent

```ts
const agent = defineAgent({
  model,
  tools: [lookup],
  instructions: "Triage the open tickets.",
  domain: {
    init: (): Triage => ({ stage: "reading", open: [], missing: 0 }),
    step,
  },
  stopWhen: (state) => state.domain.stage === "closing",
  continueWhen: (state) =>
    state.domain.open.length < 2 ? "Look up another ticket." : null,
});
```

`state.domain` is typed `Triage` in both predicates. Each one reads the slice
after the event that just settled: `continueWhen` sees the turn it is asked
about, and `stopWhen` sees every tool outcome of the batch that just drained.
Neither folds the conversation.

`init` seeds the slice when the Model is created and again when a `start`
brings a new `runId`. A repeated `start` for the run the Model already holds
keeps the slice.

## Read it off the result

```ts
const final = await agent.run("Triage t1 to t3.");

final.domain; // { stage: "closing", open: ["t1", "t2"], missing: 1 }
```

The slice is a field of the Model, so whatever saves the Model saves it too:
`memoryStore`, `fileStore`, `doStore` and `doEventSourcedStore`. A run killed
mid-way resumes from its Store with the slice it had, and ends on the slice an
uninterrupted run ends on. `replayTrace` rebuilds it from the recorded Msgs,
and a changed `step` shows up as a divergence whose path starts at
`state.domain`.

## Saves made before you added `domain`

A Model saved before the agent had a `domain` has no slice. If its run is
`idle`, the next transition seeds it from `init`. If the run is under way, the
transition throws `MissingAgentDomainError`, because seeding there would start
the slice over at a point the run has long passed. Add the slice to old saves
in your Store's `migrate`; see
[Change a saved state's shape without losing old saves](./migrate-a-saved-state.md).

An agent with no `domain` has no `domain` key on its Model, and its runs are
exactly what they were before.
