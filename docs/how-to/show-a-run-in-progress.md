# Show a run's progress while it runs

`agent.run` resolves once, with the final Model. That is the wrong shape for a
chat window, a progress line, or a log that shows what the agent is doing — those
need to hear from the run while it is still running.

Pass `onEvent`. It is the progress seam on `defineAgent`'s run options: without
it, the only way to see anything mid-run is to drop to `agent.machine(input)` and
drive the raw kernel loop yourself.

## 1. Attach a listener

```ts
import { defineAgent } from "@demlik/tea/agent";

const agent = defineAgent({ model, tools: [note], instructions });

const final = await agent.run(input, {
  store,
  onEvent: (event) => {
    if (event.type === "TurnSettled") console.log("thinking:", event.turn.content);
    if (event.type === "ToolSettled") console.log("tool:", event.callId);
    if (event.type === "RunDone") console.log("done:", event.output?.content);
  },
});
```

Three events arrive in the order the kernel settles them:

| Event | When | Carries |
| --- | --- | --- |
| `TurnSettled` | the model produced a turn | `turn` — the narration and the tool calls it asked for |
| `ToolSettled` | a tool call came back OK | `callId`, and `result` typed against your tool set |
| `RunDone` | the run finished | `output` — the terminal turn, or `null` |

They are the same `AgentEvent`s a hand-wired `run(machine, { events: agentEvents() })`
projects to `runtime.on(...)`; `onEvent` forwards that stream rather than minting
a second vocabulary. The type is `DefinedAgentEvent<typeof yourTools>`, so a
`switch` on `event.type` narrows to exactly the fields above.

## 2. Know what it does not give you

**Turn granularity, not tokens.** `onEvent` fires when a turn has settled, so it
answers "what is it doing now", not "print the answer as it is typed". For the
deltas, write the model in its streaming shape and pass `onChunk` — see
[step 3](#3-go-below-a-turn-with-onchunk).

**Only this process's steps.** Events are projected off the transitions this
process applies, so a run resumed from a `Store` reports the steps it actually
takes — the turn and the tool the killed process already settled are not
replayed to your listener. See
[Build a durable agent](../tutorial/build-a-durable-agent.md) for what a resume
is.

**Nothing about the run's outcome changes.** With `onEvent` omitted, the run is
byte for byte the one it always was. With it attached, `run` still resolves with
the terminal Model and still rejects with `DriveFailedError` — a listener that
throws is caught and warned about, never allowed to take the run down. Your
progress code cannot fail the agent.

## 3. Go below a turn with `onChunk`

To print the answer as it is typed, the model has to hand you the deltas, so this
is the one thing on the page that changes the brain you wrote. Give it tea's
second, optional port shape — the same call, plus a sink:

```ts
import type { AgentMessage, ModelStream } from "@demlik/tea/agent";

const model = async (messages: readonly AgentMessage[], { onChunk }: ModelStream) => {
  // …call your provider's streaming API, writing each delta as it arrives…
  return turn; // the settled AgentTurn, exactly as the plain port returns it
};

const final = await agent.run(input, {
  store,
  onChunk: (chunk) => process.stdout.write(chunk.text),
});
```

`defineAgent` takes one `model` field for both shapes and tells them apart by
arity — there is no flag to set, and none to get wrong. A recipe for the Vercel
AI SDK's `streamText` is in
[Use a Vercel AI SDK model as the agent's brain](./use-a-vercel-ai-sdk-model.md).

**A chunk is a side channel, never state.** It is not journaled, not written to
the `Store`, and never folded into the Model — a delta that has not settled is
not an outcome. Three things follow, and they are the reason the seam is shaped
this way:

- The turn a streamed run settles is identical to the one a plain model would
  have settled, so nothing about the Model records that anyone watched.
- A replay reproduces that Model and emits no chunk, because no chunk was ever a
  message to record.
- A run that dies mid-turn loses that turn's deltas: it resumes from the last
  turn that SETTLED and re-produces the unfinished one from scratch. Buffer them
  yourself if you want the half-sentence back.

`onChunk` is contained exactly as `onEvent` is: a throw is warned about, never
allowed to reject the model call it fired from. Passing it beside a plain model
is silent — that model has no deltas to give.
