# Delegate to a sub-agent

To let one agent hand a job to another and wait for the answer, wrap the second
agent with `agentTool` from `@demlik/tea/agent`. The wrapped agent becomes a tool
the first one calls like any other. The call runs the child agent to the end of
its run and gives the parent a typed result. The child is a durable run of its
own, with its own Store, so if the parent is evicted while the child is working,
resuming the parent resumes the child rather than starting it again.

This guide builds a screen-reader tester that calls an unblocker agent when it
reaches a barrier it cannot operate. It runs the pair on the Promise engine,
then inside a Durable Object.

## 1. Define the child agent

The child is an ordinary `defineAgent`. Its instructions, its tools and its
bounds (`maxTurns`, `maxElapsedMs`, `stopWhen`) all belong to its own
definition, and the parent can't see or change any of them:

```ts
import type { Store } from "@demlik/tea";
import {
  type AgentMessage,
  type AgentTurn,
  agentTool,
  type DefinedAgentState,
  defineAgent,
  tool,
} from "@demlik/tea/agent";
import { z } from "zod";

/** A brain in tea's plain port shape: your provider adapter goes here. */
export type Brain = (messages: readonly AgentMessage[]) => Promise<AgentTurn>;

/** The unblocker's own tool. The tester never sees it. */
export const dismiss = tool(
  "dismiss",
  {
    description: "Dismiss the overlay the selector names.",
    input: z.object({ selector: z.string() }),
    ok: z.object({ dismissed: z.boolean() }),
    err: [],
  },
  async ({ selector }, _ctx, { ok }) => ok({ dismissed: selector !== "" }),
);

/** The child: its own instructions, its own tools, its own bounds. */
export const unblocker = (model: Brain) =>
  defineAgent({
    model,
    tools: [dismiss],
    instructions:
      "Clear the one barrier you are given, then answer only with JSON: " +
      '{ "outcome": "cleared" | "not_cleared" | "unclearable", "summary": string }.',
    maxTurns: 12,
  });
```

The child ends on a turn whose `content` is its answer. Here that answer is a
JSON verdict, which the next step parses.

## 2. Wrap it as a tool and give it to the parent

`agentTool` takes the child plus four functions that connect it to the parent's
call:

- `prompt` turns the call's args into the child's input. The child sees only
  this string, never the parent's conversation.
- `result` reads the parent call's value off the child's final turn. `ok` parses
  that value at the edge, the same as any tool's `ok`.
- `namespace` reads a string off the parent's ctx. Choose one that keeps two
  parent runs apart, such as the journey id.
- `store` returns the child run's Store for a key. The key is
  `<namespace>/<callId>`, and it is also the child's `runId`.

```ts
/** What the tester gets back, parsed at the edge like any tool's `ok`. */
export const Verdict = z.object({
  outcome: z.enum(["cleared", "not_cleared", "unclearable"]),
  summary: z.string(),
});

/** The child run's Model, which is what its Store holds. */
export type UnblockState = DefinedAgentState<typeof dismiss>;

/** What the tester's host hands `run`: the journey, and where child runs live. */
export type TesterCtx = {
  readonly journeyId: string;
  readonly childStore: (key: string) => Store<UnblockState>;
};

export const requestUnblock = (model: Brain) =>
  agentTool("request_unblock", {
    description:
      "Hand a barrier you cannot operate to the unblocker and wait for its verdict.",
    input: z.object({ description: z.string() }),
    ok: Verdict,
    agent: unblocker(model),
    prompt: ({ description }) => `Barrier: ${description}`,
    result: (output) => Verdict.parse(JSON.parse(output.content)),
    namespace: (ctx: TesterCtx) => ctx.journeyId,
    store: (key, ctx) => ctx.childStore(key),
  });

/** The parent: `request_unblock` sits in its tools like any other tool. */
export const tester = (brains: { tester: Brain; unblocker: Brain }) =>
  defineAgent({
    model: brains.tester,
    tools: [requestUnblock(brains.unblocker)],
    instructions:
      "Walk the journey with the screen reader. At a barrier you cannot " +
      "operate, call request_unblock with a description of it.",
  });

/** The tester's Model. */
export type TesterState = DefinedAgentState<ReturnType<typeof requestUnblock>>;
```

The `store` function has one requirement. Every time it is given the same key,
in any process, it must return the same durable cell. When the parent resumes,
it fires its tool call again with the same `callId`, and that call can only find
the child's progress if the key leads back to the same cell.

## 3. Run it on the Promise engine

Give the parent a Store and pass the child's Store factory in on `ctx`. Here
each run gets its own JSON file:

```ts
import { join } from "node:path";
import { fileStore } from "@demlik/tea/node";

/** One JSON file per run, the parent's and every child's, in one directory. */
export async function testJourney(
  dir: string,
  journeyId: string,
  brains: { tester: Brain; unblocker: Brain },
) {
  const file = (key: string) => join(dir, `${encodeURIComponent(key)}.json`);
  return tester(brains).run(`Test journey ${journeyId}.`, {
    runId: journeyId,
    store: fileStore(file(journeyId), (raw) => raw as TesterState),
    ctx: {
      journeyId,
      childStore: (key) =>
        fileStore(file(`unblock:${key}`), (raw) => raw as UnblockState),
    },
  });
}
```

A finished journey leaves two files: `j1.json` for the tester and
`unblock%3Aj1%2Fc1.json` for the unblocker's run on call `c1`. Running the same
journey again resolves from the files without calling either model.

## 4. Run it inside a Durable Object

In a Durable Object the child's Model lives in the parent's own storage, under a
key prefix of its own. `doStore` takes the key as its third argument:

```ts
import { doStore } from "@demlik/tea/do";

/**
 * The same tester inside a Durable Object: the parent's Model under the
 * default key, and each child's under `unblock:<journey>/<callId>`, all in the
 * DO's own storage. Call this from the DO's `fetch`.
 */
export function testJourneyInDo(
  storage: DurableObjectStorage,
  journeyId: string,
  brains: { tester: Brain; unblocker: Brain },
) {
  return tester(brains).run(`Test journey ${journeyId}.`, {
    runId: journeyId,
    store: doStore(storage, (raw) => raw as TesterState),
    ctx: {
      journeyId,
      childStore: (key) =>
        doStore(storage, (raw) => raw as UnblockState, `unblock:${key}`),
    },
  });
}
```

The parent's Model stays at `doStore`'s default key, and each child's is stored
beside it at `unblock:<journey>/<callId>`. One DO holds the whole journey. If the
DO is evicted while the unblocker is working, the next request boots the tester,
which fires `request_unblock` again with the same `callId`. The child then boots
from `unblock:j2/c1` at the turn it had reached. Child turns that had already
settled don't call the model again, and child tool calls that had already
settled don't run again. If the child had finished before the eviction, the
parent gets the result the child recorded, and the child's model isn't called at
all. For the parent's side of the recipe, the DO class and the routing, see
[Deploy an agent to a Durable Object](./deploy-an-agent-to-a-durable-object.md).

## 5. Read a child that did not finish

A child that ends `failed` or `cancelled` doesn't fail the parent. The parent
call settles on the error channel, and the parent model reads it as the call's
reason on its next turn:

| The child | The parent call settles | Its `reason` reads |
|---|---|---|
| hit its own `maxTurns` | `{ _tag: "child_failed", childRunId, failure: "turn_limit" }` | `child_failed {"childRunId":"j1/c1","failure":"turn_limit"}` |
| failed another way | `child_failed` with `failure` set to `elapsed_limit`, `llm`, `deadline` or `stage` | the same shape |
| stopped on its `stopWhen` | `{ _tag: "child_cancelled", childRunId }` | `child_cancelled {"childRunId":"j1/c1"}` |

`agentTool` accepts no `timeoutMs` and no `retry`. A timeout would settle the
parent's call while the child kept running under the same key. A retry of a
child that failed would reach the same finished run and get the same failure.
To give the child more room, raise its own `maxTurns`.

## How this maps to Temporal, LangGraph and the OpenAI Agents SDK

| `agentTool` | Temporal | LangGraph | OpenAI Agents SDK |
|---|---|---|---|
| The child keeps its own Store, keyed `<namespace>/<callId>` | A child workflow keeps its own event history | A subgraph checkpoints under a namespace derived from its parent | — |
| A re-fired call with the same key reaches the same run | A re-issued start with the same workflow id attaches to the running child | A resumed parent resumes the subgraph from its checkpoint | — |
| The parent keeps control and gets a typed result back | The parent awaits the child's result | The subgraph returns into the parent's state | `agent.as_tool()`, not `handoffs` |

Two things are out of scope. The first is a one-way hand-off, where control
moves to the other agent and never comes back, like the OpenAI SDK's `handoffs`.
The second is a child whose state is stored inside the parent's Model. With
`agentTool`, the child always returns to the parent and always keeps its own
Store.
