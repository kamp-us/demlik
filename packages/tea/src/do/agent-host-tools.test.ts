import { expect, it, vi } from "vitest";
import { z } from "zod";
import {
  type AgentMessage,
  type DefinedAgentState,
  defineAgent,
  tool,
} from "../agent/index";
import { memoryStore } from "../mem";
import { run } from "../promise";
import { createAgentHost } from "./index";

it("hosts a defined agent through a tool turn to done", async () => {
  const echo = tool(
    "echo",
    {
      description: "Echo",
      input: z.object({ value: z.string() }),
      ok: z.string(),
      err: [],
    },
    async (input, _ctx: object, settle) => settle.ok(input.value),
  );
  const model = vi
    .fn()
    .mockResolvedValueOnce({
      content: "Echoing",
      toolCalls: [{ callId: "c1", name: "echo", args: { value: "hello" } }],
    })
    .mockResolvedValueOnce({ content: "Finished", toolCalls: [] });
  const agent = defineAgent({
    instructions: "",
    tools: [echo],
    model: async (messages: readonly AgentMessage[]) => model(messages),
  });
  const onError = vi.fn();
  const host = createAgentHost({
    buildMachine: () => agent.machine("repro"),
    ctx: {},
    run,
    store: memoryStore<DefinedAgentState<typeof echo>>(),
    toSseFrame: () => null,
    onError,
  });
  try {
    const runtime = await host.runtime();
    await runtime.dispatch({
      _tag: "agent_start",
      runId: "run-1",
      at: Date.now(),
    });
    await vi.waitFor(async () => {
      expect((await host.status()).kind).toBe("done");
    });
    expect(await host.result()).toMatchObject({ run: { phase: "done" } });
    expect(model.mock.calls[1]?.[0]).toContainEqual({
      role: "tool",
      callId: "c1",
      name: "echo",
      outcome: { kind: "ok", result: "hello" },
    });
    expect(onError).not.toHaveBeenCalled();
  } finally {
    await host.reset();
  }
});
