# Use a Vercel AI SDK model as the agent's brain

tea's model port is one async function: `(messages) => Promise<AgentTurn>`. The
[tutorial](../tutorial/build-a-durable-agent.md) writes that function by hand
against Anthropic's Messages API, in the **Give the agent a brain** section —
about sixty lines of wire format you maintain per provider.

This page replaces that section's `model.ts` with a bridge over the Vercel AI
SDK's `generateText`. Everything else in the tutorial stays exactly as written:
the agent, the tools, the store, the run. What changes is that the brain now
speaks to every provider the SDK speaks to, and the wire format is the SDK's
problem instead of yours.

Install the SDK and the provider you want beside tea:

```sh
pnpm add ai @ai-sdk/anthropic
```

`ai` is *your* dependency, not tea's: the package neither imports it nor ships a
subpath for it. This is a recipe you own, so you pick the SDK version and pin the
provider.

## The bridge

```ts
import type { AgentMessage, AgentTurn, AnyToolDef } from "@demlik/tea/agent";
import {
  generateText,
  type LanguageModel,
  type ModelMessage,
  tool,
  type ToolSet,
} from "ai";

/**
 * A Vercel AI SDK `LanguageModel` as tea's plain `(messages) => turn` port.
 * Any provider the SDK speaks — Anthropic, OpenAI, Google, Bedrock — arrives
 * through the same thirty lines; only the `model` argument changes.
 */
export function aiSdkModel(model: LanguageModel, tools: readonly AnyToolDef[]) {
  // No `execute`: tea owns tool execution, so the SDK reports the calls and stops.
  const declared: ToolSet = Object.fromEntries(
    tools.map((t) => [
      t.cmdType,
      tool({ description: t.description, inputSchema: t.args }),
    ]),
  );
  return async (messages: readonly AgentMessage[]): Promise<AgentTurn> => {
    const result = await generateText({
      model,
      system: messages.find((m) => m.role === "system")?.content,
      messages: messages.flatMap(toModelMessages),
      tools: declared,
    });
    return {
      content: result.text,
      toolCalls: result.toolCalls.map((c) => ({
        callId: c.toolCallId,
        name: c.toolName,
        args: c.input as Record<string, unknown>,
      })),
      // The whole turn as the SDK rendered it. Reasoning and signed thinking
      // ride here with their `providerOptions` intact; `toModelMessages` sends
      // it back verbatim next turn, and tea never looks inside.
      provider: result.responseMessages,
    };
  };
}

/** One tea message in the SDK's shape; the system line goes to `system`. */
function toModelMessages(m: AgentMessage): ModelMessage[] {
  switch (m.role) {
    case "system":
      return [];
    case "user":
      return [{ role: "user", content: m.content }];
    case "assistant":
      // Replay the stored `provider` when there is one — reconstructing the
      // assistant message from `content` + `toolCalls` would drop the signed
      // reasoning the provider requires back, and the API rejects the turn.
      return (
        (m.provider as ModelMessage[] | undefined) ?? [
          {
            role: "assistant",
            content: [
              ...(m.content === ""
                ? []
                : [{ type: "text" as const, text: m.content }]),
              ...m.toolCalls.map((c) => ({
                type: "tool-call" as const,
                toolCallId: c.callId,
                toolName: c.name,
                input: c.args,
              })),
            ],
          },
        ]
      );
    case "tool":
      return [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: m.callId,
              toolName: m.name,
              output:
                m.outcome.kind === "ok"
                  ? { type: "json", value: m.outcome.result as never }
                  : { type: "error-text", value: m.outcome.reason },
            },
          ],
        },
      ];
  }
}
```

## Wire it into the agent

The tutorial's `defineAgent` call takes the hand-written `anthropic(tools)` as
its `model`. Swap it for the bridge and hand it an SDK model:

```ts
// agent.ts
import { anthropic } from "@ai-sdk/anthropic";
import { defineAgent } from "@demlik/tea/agent";

import { aiSdkModel } from "./model";

const tools = [writeNote, finish];

export const agent = defineAgent({
  model: aiSdkModel(anthropic("claude-sonnet-4-5"), tools),
  tools,
  instructions: "Put red, yellow and blue in the notebook, then finish.",
});
```

Changing provider is now one line — `openai("gpt-5")`, `google("gemini-3-pro")`
— and nothing else in the program moves.

## The detail that is easy to get wrong

`AgentTurn.provider` is a passthrough slot: tea persists whatever the adapter
puts there and hands it back, unread, on the `assistant` message that replays
that turn. It exists because several providers *require* their own opaque blocks
echoed verbatim — Anthropic's signed `thinking`, OpenAI's reasoning items.

So the bridge stores `result.responseMessages` (the SDK's own rendering of the
turn) in the slot, and `toModelMessages` prefers that stored value over
rebuilding the assistant message from `content` + `toolCalls`. Rebuilding it
compiles, passes a happy-path test, and then fails in production the first time
a resume replays a reasoning turn — the block is gone and the provider rejects
the request.

Two constraints follow from tea's Model being durable data:

- Whatever lands in `provider` must be JSON-serializable, because it is written
  to the `Store` with the rest of the Model. `responseMessages` is.
- A [compaction](../../.decisions/0004-agent-context-compaction.md) fold
  summarises old turns into text, and drops
  the slot with the turns it summarises. That is correct: a summarised turn is
  no longer being replayed.

## Notes

- Tool execution stays tea's. The declared tools carry no `execute`, so
  `generateText` reports the calls and returns; tea's fan-out runs them durably
  and folds the outcomes back as `tool` messages.
- `AnyToolDef.args` is a Zod schema, which the SDK's `tool()` accepts directly
  as `inputSchema` — no JSON-Schema conversion step.
- The bridge on this page is compiled and asserted verbatim by
  `src/docs/how-to/ai-sdk-model.test.ts`, so it cannot drift from `AgentTurn`.
