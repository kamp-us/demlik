import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Store } from "../index";
import { memoryStore } from "../mem";
import {
  type AgentMessage,
  type AgentTurn,
  type DefinedAgentState,
  defineAgent,
  renderPrompt,
  tool,
  transcript,
} from "./index";

const tick = tool(
  "tick",
  {
    description: "Settle one tick",
    input: z.object({}),
    ok: z.object({ ticked: z.literal(true) }),
    err: [],
  },
  async (_input, _ctx, { ok }) => ok({ ticked: true }),
);

function scripted() {
  const seen: (readonly AgentMessage[])[] = [];
  const model = async (
    messages: readonly AgentMessage[],
  ): Promise<AgentTurn> => {
    seen.push(messages);
    const n = messages.filter((m) => m.role === "assistant").length + 1;
    return {
      content: `turn ${n}`,
      toolCalls:
        n % 2 === 0 ? [] : [{ callId: `c${n}`, name: "tick", args: {} }],
    };
  };
  return { model, seen };
}

const continueWhen = (state: {
  readonly conversation: {
    readonly toolRecords: readonly {
      readonly outcome: { readonly kind: string };
    }[];
  } | null;
}) => {
  const left =
    5 -
    (state.conversation?.toolRecords.filter((r) => r.outcome.kind === "ok")
      .length ?? 0);
  return left > 0 ? `tick more: ${left} left` : null;
};

describe("continueWhen", () => {
  it("refuses premature finishes until five ticks settle and feeds each nudge back after its empty turn", async () => {
    const { model, seen } = scripted();
    const ticks: unknown[] = [];
    const collected = transcript();
    const agent = defineAgent({
      model,
      tools: [tick],
      instructions: "Tick five times before finishing.",
      continueWhen,
    });
    const final = await agent.run("go", {
      onEvent: (event) => {
        collected.onEvent(event);
        if (event._tag === "ToolSettled") ticks.push(event.result);
      },
    });
    expect(final.run.phase).toBe("done");
    expect(ticks).toHaveLength(5);
    expect(final.output).toEqual({ content: "turn 10", toolCalls: [] });
    expect(seen).toHaveLength(10);
    expect(collected.read().nudges).toEqual([
      { turn: 1, text: "tick more: 4 left" },
      { turn: 3, text: "tick more: 3 left" },
      { turn: 5, text: "tick more: 2 left" },
      { turn: 7, text: "tick more: 1 left" },
    ]);
    for (const [i, text] of [
      "tick more: 4 left",
      "tick more: 3 left",
      "tick more: 2 left",
      "tick more: 1 left",
    ].entries()) {
      expect(seen[(i + 1) * 2]?.slice(-2)).toEqual([
        { role: "assistant", content: `turn ${(i + 1) * 2}`, toolCalls: [] },
        { role: "user", content: text },
      ]);
    }
  });

  it.each([
    "no",
    "",
  ])("bounds a gate that never clears (%j) with maxTurns", async (nudge) => {
    const seen: (readonly AgentMessage[])[] = [];
    const agent = defineAgent({
      model: async (messages: readonly AgentMessage[]) => {
        seen.push(messages);
        return { content: "done?", toolCalls: [] };
      },
      tools: [tick],
      instructions: "Tick.",
      continueWhen: () => nudge,
      maxTurns: 4,
    });
    await expect(agent.run("go")).rejects.toMatchObject({
      state: {
        failure: { reason: "turn_limit" },
        conversation: { turnCount: 4 },
      },
    });
    expect(seen).toHaveLength(4);
  });

  it("consults stopWhen at a refused finish before calling the model again", async () => {
    const { model, seen } = scripted();
    const collected = transcript();
    const final = await defineAgent({
      model,
      tools: [tick],
      instructions: "Tick.",
      continueWhen: () => "no",
      stopWhen: (state) => state.conversation?.nudges.length === 1,
    }).run("go", { onEvent: collected.onEvent });
    expect(final.run.phase).toBe("cancelled");
    expect(final.conversation?.turnCount).toBe(2);
    expect(seen).toHaveLength(2);
    expect(collected.read().nudges).toEqual([{ turn: 1, text: "no" }]);
    expect(collected.read().turns).toHaveLength(2);
  });

  it("resumes the saved Model immediately after a nudge with identical inputs and outcome", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      type S = DefinedAgentState<typeof tick>;
      const saved: S[] = [];
      const live = memoryStore<S>();
      const store: Store<S> = {
        ...live,
        save: async (state) => {
          await live.save(state);
          if (state.conversation?.nudges.length === 1) {
            saved.push(JSON.parse(JSON.stringify(state)) as S);
          }
        },
      };
      const first = scripted();
      const config = { tools: [tick], instructions: "Tick.", continueWhen };
      const uninterrupted = await defineAgent({
        ...config,
        model: first.model,
      }).run("go", { store, runId: "durable" });
      const parked = saved[0];
      expect(parked?.conversation?.nudges).toEqual([
        { turn: 1, text: "tick more: 4 left" },
      ]);
      expect(parked?.conversation?.awaiting).toEqual({ kind: "llm" });
      const second = scripted();
      const collected = transcript(parked);
      const resumed = await defineAgent({ ...config, model: second.model }).run(
        "go",
        { store: memoryStore(parked), onEvent: collected.onEvent },
      );
      expect(resumed.run).toMatchObject({
        progressSeq: uninterrupted.run.progressSeq + 1,
      });
      expect({
        ...resumed,
        run: { ...resumed.run, progressSeq: uninterrupted.run.progressSeq },
      }).toEqual(uninterrupted);
      expect(second.seen).toEqual(first.seen.slice(2));
      expect(collected.read().nudges).toEqual([
        { turn: 1, text: "tick more: 4 left" },
        { turn: 3, text: "tick more: 3 left" },
        { turn: 5, text: "tick more: 2 left" },
        { turn: 7, text: "tick more: 1 left" },
      ]);
    } finally {
      clock.mockRestore();
    }
  });

  it("rehydrates an older conversation without nudges and renders its history unchanged", async () => {
    type S = DefinedAgentState<typeof tick>;
    let parked: S | undefined;
    const live = memoryStore<S>();
    const store: Store<S> = {
      ...live,
      save: async (state) => {
        await live.save(state);
        if (state.conversation?.turnCount === 1) {
          parked = JSON.parse(JSON.stringify(state)) as S;
        }
      },
    };
    const first = scripted();
    await defineAgent({
      model: first.model,
      tools: [tick],
      instructions: "Tick.",
    }).run("go", { store });
    if (parked?.conversation == null) throw new Error("No saved conversation");
    const legacy = JSON.parse(JSON.stringify(parked)) as S;
    Reflect.deleteProperty(legacy.conversation ?? {}, "nudges");
    const prompt = {
      instructions: "Tick.",
      input: "go",
      conversation: legacy.conversation ?? parked.conversation,
    };
    expect(renderPrompt(prompt)).toEqual(first.seen[1]);
    const seen: (readonly AgentMessage[])[] = [];
    const final = await defineAgent({
      tools: [tick],
      instructions: "Tick.",
      model: async (messages: readonly AgentMessage[]) => {
        seen.push(messages);
        return { content: "finished", toolCalls: [] };
      },
      continueWhen: (state) => {
        return state.conversation?.nudges.length === 0
          ? null
          : "unexpected feedback";
      },
    }).run("go", { store: memoryStore(legacy) });
    expect(final.run.phase).toBe("done");
    expect(seen).toEqual([first.seen[1]]);
  });

  it("folds only the old nudges and renders a surviving nudge and later tool after their renumbered turns", async () => {
    const seen: (readonly AgentMessage[])[] = [];
    const turns: readonly AgentTurn[] = [
      { content: "empty 1", toolCalls: [] },
      { content: "empty 2", toolCalls: [] },
      { content: "empty 3", toolCalls: [] },
      { content: "empty 4", toolCalls: [] },
      { content: "summary", toolCalls: [] },
      {
        content: "tick",
        toolCalls: [{ callId: "c5", name: "tick", args: {} }],
      },
      { content: "finished", toolCalls: [] },
    ];
    const final = await defineAgent({
      model: async (messages: readonly AgentMessage[]) => {
        const turn = turns[seen.length];
        seen.push(messages);
        if (turn === undefined) throw new Error("Unexpected call");
        return turn;
      },
      tools: [tick],
      instructions: "Tick.",
      compaction: { afterTurns: 4, keepTurns: 1 },
      continueWhen: (state) => {
        const c = state.conversation;
        return c?.toolRecords.length
          ? null
          : `retry ${c?.turns.at(-1)?.content}`;
      },
    }).run("go");
    expect(final.run.phase).toBe("done");
    expect(seen[4]?.filter((m) => m.role === "user")).toEqual([
      { role: "user", content: "retry empty 1" },
      { role: "user", content: "retry empty 2" },
      { role: "user", content: "retry empty 3" },
    ]);
    expect(seen[5]?.slice(2)).toEqual([
      { role: "assistant", content: "summary", toolCalls: [] },
      { role: "assistant", content: "empty 4", toolCalls: [] },
      { role: "user", content: "retry empty 4" },
    ]);
    expect(seen[6]?.slice(-2)).toEqual([
      { role: "assistant", content: "tick", toolCalls: turns[5]?.toolCalls },
      {
        role: "tool",
        callId: "c5",
        name: "tick",
        outcome: { kind: "ok", result: { ticked: true } },
      },
    ]);
  });
});
