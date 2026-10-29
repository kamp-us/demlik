import assert from "node:assert/strict";
import { z } from "zod";
import {
  type AgentMessage,
  type DefinedAgentState,
  defineAgent,
  status,
  tool,
} from "../../packages/tea/src/agent/index.ts";
import { memoryStore } from "../../packages/tea/src/mem/index.ts";
import { DriveFailedError } from "../../packages/tea/src/runtime-types.ts";

for (const id of [
  "provider-rich",
  "provider-error",
  "schema-guard",
  "content-error",
]) {
  const nested = {
    requestId: "request-17",
    retry: { afterMs: 125, attempts: [1, 2] },
  };
  const rich = { code: "provider_busy", status: 429, nested };
  const error = Object.assign(new Error("Provider unavailable"), rich);
  const original = id === "provider-error" ? error : rich;
  type S = DefinedAgentState<never>;
  const saves: S[] = [],
    saveWires: string[] = [],
    events: unknown[] = [],
    prompts: unknown[] = [];
  let calls = 0,
    contentCalls = 0,
    toolCalls = 0;
  const memory = memoryStore<S>();
  const contentTool = tool(
    "read",
    {
      description: "Return a receipt whose content callback fails.",
      input: z.unknown(),
      ok: z.string(),
      err: [],
      content: () => {
        contentCalls++;
        throw original;
      },
    },
    async (_args, _ctx, { ok }) => {
      toolCalls++;
      return ok("receipt");
    },
  );
  const agent = defineAgent({
    instructions: "Keep provider failures.",
    tools: id === "content-error" ? [contentTool] : [],
    model: async (messages: readonly AgentMessage[]) => {
      prompts.push(messages);
      calls++;
      if (id.startsWith("provider-")) throw original;
      if (id === "schema-guard") return { content: 17, toolCalls: [] } as never;
      return {
        content: "Read once.",
        toolCalls: [{ callId: "read-17", name: "read", args: {} }],
      };
    },
  });
  let final: S | undefined;
  try {
    await agent.run("Try once.", {
      runId: "provider-run",
      clock: () => 50,
      store: {
        ...memory,
        async save(s) {
          saves.push(s as S);
          saveWires.push(JSON.stringify(s));
          await memory.save(s as S);
        },
      },
      onEvent: (e) => events.push(e),
    });
    assert.fail("the real run must reject");
  } catch (failure) {
    assert(failure instanceof DriveFailedError);
    final = failure.state as S;
  }
  assert(final);
  assert.equal(status(final).kind, "failed");
  assert.equal(final, saves.at(-1));
  assert.equal(final.failure?.reason, "llm");
  const llmError =
    final.failure?.reason === "llm" ? final.failure.error : undefined;
  assert(
    typeof llmError === "object" && llmError !== null && "error" in llmError,
  );
  const cause = llmError.error;
  if (id !== "schema-guard") {
    assert.equal(cause, original);
    assert.equal((cause as typeof rich).nested, nested);
  } else assert(cause instanceof Error);
  console.log(
    JSON.stringify({
      id,
      phase: {
        prompts,
        events,
        saves: saveWires.map((wire) => JSON.parse(wire)),
        saveWires,
        final,
        finalWire: JSON.stringify(final),
        calls,
        contentCalls,
        toolCalls,
        outcome: "failed",
        ownership: {
          finalSaved: true,
          causeSame: id !== "schema-guard",
          nestedSame: id !== "schema-guard",
        },
        failureClass: "DriveFailedError",
      },
    }),
  );
}
