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
    if (event.type === "RunDone") console.log("ended:", event.status.kind);
  },
});
```

Six events arrive in the order the kernel produces them, each carrying the run's
`runId` and the `at` of the transition behind it:

| Event | When | Carries |
| --- | --- | --- |
| `BrainStarted` | a brain call went out for a turn | `turn`, the request's `purpose`, `model` and `payload` |
| `TurnSettled` | the model produced a turn | `turn` — the narration and the tool calls it asked for — and `usage` when the provider reported it |
| `ToolStarted` | a tool call went out | `callId`, `name`, `args` |
| `ToolSettled` | a tool call came back OK | `callId`, and `result` typed against your tool set |
| `ToolFailed` | a tool call ended on a failure | `callId`, `name`, and the `failure` the model reads |
| `RunDone` | the run ended, however it ended | `status` — `done` with `output`, `failed` with `failure`, or `cancelled` |

A retry is not a new start: `BrainStarted` fires once per turn and `ToolStarted`
once per call, however many attempts the retry ladder spends.

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
arity — there is no flag to set, and none to get wrong. A streaming adapter for
any OpenAI-compatible endpoint is in
[Supply the agent's model](./supply-the-agents-model.md#stream-the-turn).

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

## 4. Keep the whole transcript with `transcript()`

A finished run's Model clears `conversation` to `null` — deliberately, so
storage kept for a run's state does not accumulate its history
([What a finished agent run keeps](../explanation/durability-model.md#what-a-finished-agent-run-keeps)).
The turns are still worth keeping, and `transcript()` keeps them: it is a
collector over the `onEvent` stream you already have, so you fold nothing
yourself.

```ts
import { defineAgent, transcript, type ToolResult } from "@demlik/tea/agent";

const t = transcript<ToolResult<typeof search>>();

const final = await agent.run(input, { store, onEvent: t.onEvent });

const { turns, tools, outcome } = t.read();
```

`read()` returns a fresh immutable snapshot: `turns` is every model turn in
order, `tools` is every call that settled OK as `{ callId, result }`, and
`outcome` is `{ kind: "running" }` until `RunDone` and the ending it carried
after it — `{ kind: "done", output }`, `{ kind: "failed", failure }` or
`{ kind: "cancelled", at }`. `done` keeps `output` in its own arm because a run
can legitimately finish with no terminating turn.

It changes nothing about the run. The collector is not state: it is never
journaled, never written to the `Store`, and never folded into the Model, so a
run with one attached settles the Model a run without one would have settled —
`conversation` still `null` at `phase: "done"`, `output` still the answer.

### Seed it when the run is a resume

Events are projected off the transitions **this process** applies (step 2), so a
resumed run re-emits nothing the killed process settled. A collector that only
listened would hold the last leg and read like the whole run. The Model your
`Store` hands back still carries that history in its live conversation, so seed
from it:

```ts
// The Model the kill left behind, read back through the store's own migrate.
const parked = store.migrate(await store.load());

const t = transcript(parked ?? { conversation: null });
const final = await agent.run(input, { store, onEvent: t.onEvent });

t.read().turns; // the killed process's turns, then this process's
```

One collector per process is the honest unit. A fresh run needs no seed, and a
seed taken from an already-finished Model contributes nothing — that Model's
`conversation` is `null`, and its answer is the `output` you already hold.

**Failed tool calls are not in `tools`.** The collector keeps what settled OK.
A failure arrives on the stream as `ToolFailed`; to branch on it by tag, pass
`onToolError`, whose argument is typed per tag — see
[Handle a tool failure](./handle-a-tool-failure.md).
