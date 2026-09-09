/**
 * The AI SDK recipe's compile gate (#121).
 *
 * `docs/how-to/use-a-vercel-ai-sdk-model.md` hands the reader a bridge to paste.
 * A pasteable bridge that nothing compiles rots against `AgentTurn` silently —
 * the field it round-trips (`provider`) is exactly the one a reader would drop,
 * and dropping it costs a signed thinking block per resume, which no type error
 * announces later.
 *
 * So the bridge lives HERE, as real TypeScript in the test program
 * (`tsconfig.test.json`, gated in CI as `typecheck:test`), and the test below
 * asserts the page's `ts` block is this file's `#region bridge` verbatim. The
 * page cannot drift from a compiling artifact, because the page IS the artifact.
 *
 * `ai` is a devDependency and only this file imports it — the package's own
 * `dependencies` and its export map are untouched, which is the ticket's
 * standing constraint.
 */

// biome-ignore-all assist/source/organizeImports: the `#region bridge` markers
// below pin an import block the page reproduces verbatim; sorting the harness's
// imports into it would move the marker and break the assertion this file is.
// biome-ignore-all lint/suspicious/noExportsInTest: the bridge is the artifact
// under test, and it is exported because the reader pastes it as a module.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #region bridge
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
  const declared = declaredTools(tools);
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

/**
 * The tools, declared to the SDK. No `execute`: tea owns tool execution, so the
 * SDK reports the calls and stops.
 */
function declaredTools(tools: readonly AnyToolDef[]): ToolSet {
  return Object.fromEntries(
    tools.map((t) => [
      t.cmdType,
      tool({ description: t.description, inputSchema: t.args }),
    ]),
  );
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
// #endregion bridge

// #region streaming
import type { ModelStream } from "@demlik/tea/agent";
import { streamText } from "ai";

/**
 * The same bridge over `streamText` — tea's streaming port,
 * `(messages, { onChunk }) => turn`. It writes each text delta to `onChunk` as
 * the provider yields it, then resolves the SETTLED turn, assembled from the
 * SDK's awaited results. The deltas are a side channel; the resolved turn is
 * the only thing tea folds into the Model.
 */
export function aiSdkStreamingModel(
  model: LanguageModel,
  tools: readonly AnyToolDef[],
) {
  const declared = declaredTools(tools);
  return async (
    messages: readonly AgentMessage[],
    { onChunk }: ModelStream,
  ): Promise<AgentTurn> => {
    const result = streamText({
      model,
      system: messages.find((m) => m.role === "system")?.content,
      messages: messages.flatMap(toModelMessages),
      tools: declared,
    });
    // The live half. Nothing here is durable, so nothing here is awaited into
    // the turn — a run that dies mid-stream resumes from the last turn that
    // SETTLED, and re-produces this one from scratch.
    for await (const text of result.textStream) onChunk({ text });
    return {
      content: await result.text,
      toolCalls: (await result.toolCalls).map((c) => ({
        callId: c.toolCallId,
        name: c.toolName,
        args: c.input as Record<string, unknown>,
      })),
      provider: await result.responseMessages,
    };
  };
}
// #endregion streaming

const page = fileURLToPath(
  new URL("../../../docs/how-to/use-a-vercel-ai-sdk-model.md", import.meta.url),
);
const self = fileURLToPath(import.meta.url);

/** The text between one region's markers, which is what the page shows. */
async function region(name: string): Promise<string> {
  const source = await readFile(self, "utf8");
  const body = source
    .split(`// #region ${name}\n`)[1]
    ?.split(`// #endregion ${name}\n`)[0];
  if (body === undefined)
    throw new Error(`the ${name} region markers are gone`);
  return body.trimEnd();
}

/** Every fenced ```ts block on the page, in page order. */
async function tsBlocks(): Promise<string[]> {
  const markdown = await readFile(page, "utf8");
  return [...markdown.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) =>
    (m[1] ?? "").trimEnd(),
  );
}

describe("docs/how-to/use-a-vercel-ai-sdk-model.md (#121)", () => {
  it("shows the compiled bridge verbatim, so the recipe cannot rot", async () => {
    expect(await tsBlocks()).toContain(await region("bridge"));
  });

  it("shows the compiled streamText variant verbatim too (#123)", async () => {
    expect(await tsBlocks()).toContain(await region("streaming"));
  });

  it("names the tutorial section it replaces and links back to it", async () => {
    const markdown = await readFile(page, "utf8");
    expect(markdown).toContain("../tutorial/build-a-durable-agent.md");
    expect(markdown).toContain("Give the agent a brain");
  });

  it("round-trips the provider slot rather than rebuilding the assistant turn", async () => {
    const replayed = toModelMessages({
      role: "assistant",
      content: "ignored",
      toolCalls: [],
      provider: [{ role: "assistant", content: "signed" }],
    });
    expect(replayed).toEqual([{ role: "assistant", content: "signed" }]);
  });

  it("maps the SDK's tool-call field names onto tea's", async () => {
    const rebuilt = toModelMessages({
      role: "assistant",
      content: "",
      toolCalls: [{ callId: "call_1", name: "search", args: { q: "red" } }],
    });
    expect(rebuilt).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "search",
            input: { q: "red" },
          },
        ],
      },
    ]);
  });
});
