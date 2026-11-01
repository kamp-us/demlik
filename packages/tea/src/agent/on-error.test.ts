import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  type FencedStore,
  type OnError,
  type Store,
  StoreConflictError,
} from "../index";
import { memoryStore } from "../mem";
import {
  type AgentTurn,
  agentTool,
  type DefinedAgent,
  type DefinedAgentState,
  defineAgent,
} from "./index";

// A defined agent has to carry the `onError` a fenced store needs (ADR 0031), on
// its own `run` and for an `agentTool`'s child.

type NoTools = never;
type State = DefinedAgentState<NoTools>;

const FINAL: AgentTurn = { content: "done", toolCalls: [] };

describe("a defined agent's onError", () => {
  it("`run` hands it to the run: a fence lost once the agent finished reaches it at the final save", async () => {
    const inner = memoryStore<State>(null, undefined, { fenced: true });
    let lost = false;
    const store: FencedStore<State> = {
      ...inner,
      saveFenced: (state, version) =>
        lost
          ? Promise.reject(new StoreConflictError(version, version + 1))
          : inner.saveFenced(state, version),
    };
    const onError = vi.fn<OnError>();
    const agent = defineAgent<NoTools>({
      model: async () => FINAL,
      tools: [],
      instructions: "",
      maxTurns: 2,
    });

    await agent.run("go", {
      store,
      onError,
      onEvent: (event) => {
        if (event.type === "RunDone") lost = true;
      },
    });

    expect(onError).toHaveBeenCalledWith(expect.any(StoreConflictError), {
      phase: "stop-save",
    });
  });

  it("`agentTool` hands it to the child's run", async () => {
    const onError = vi.fn<OnError>();
    const run = vi.fn(async () => ({ run: { phase: "done" }, output: FINAL }));
    const child = { run } as unknown as DefinedAgent<NoTools>;
    const store: Store<State> = memoryStore<State>();

    const asTool = agentTool("child", {
      description: "",
      input: z.object({}),
      ok: z.object({}),
      agent: child,
      prompt: () => "go",
      result: () => ({}),
      namespace: () => "n",
      store: () => store,
      onError,
    });
    await asTool.interpret(asTool({ callId: "c", args: {} }), {} as never);

    expect(run).toHaveBeenCalledWith(
      "go",
      expect.objectContaining({ store, onError }),
    );
  });
});
