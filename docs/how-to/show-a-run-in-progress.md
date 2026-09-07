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

**Turn granularity, not tokens.** The model port hands back a whole `AgentTurn`,
so there are no token deltas to forward. `onEvent` answers "what is it doing
now", not "print the answer as it is typed".

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
