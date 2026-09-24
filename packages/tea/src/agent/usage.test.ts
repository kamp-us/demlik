import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Store } from "../index";
import { memoryStore } from "../mem";
import {
  type AgentMessage,
  type AgentTurn,
  agentTurnSchema,
  createAgent,
  type DefinedAgentEvent,
  type DefinedAgentState,
  defineAgent,
  isAgentTurn,
  status,
  type TurnUsage,
  tool,
} from "./index";
import { foldSummary, freshConversation } from "./internal";

// ---------------------------------------------------------------------------
// #332 — provider-reported token usage. A turn carries what the provider said
// the call cost; the run sums it into its running total (`state.usage`, #354)
// and the conversation keeps the latest context size; `compaction.afterContextTokens` folds on that size and
// `stopWhen` reads the total as a budget. Nothing here estimates a token.
// ---------------------------------------------------------------------------

const INSTRUCTIONS = "You answer with one sentence, citing a search.";
const INPUT = "What is TEA?";

const search = tool(
  "search",
  {
    description: "Look a phrase up.",
    input: z.object({ q: z.string() }),
    ok: z.object({ snippet: z.string() }),
    err: [],
  },
  async ({ q }, _ctx, { ok }) => ok({ snippet: `about ${q}` }),
);

type S = DefinedAgentState<typeof search>;

/**
 * A model whose `k`th brain turn asks for one more search and reports
 * `usages[k]` (nothing when that slot is `undefined`). By default `k` counts
 * this model's brain calls. `"prompt"` reads it off how many assistant turns the
 * prompt already carries instead, so a process that resumes mid-run is handed
 * the turn an uninterrupted one would be — which only holds while nothing folds
 * the transcript. A prompt that does not open with the agent's instructions is
 * the compaction summarize call: it is counted and answered with a summary.
 */
function metered(
  usages: readonly (TurnUsage | undefined)[],
  index: "call" | "prompt" = "call",
) {
  let calls = 0;
  let summaries = 0;
  const model = async (
    messages: readonly AgentMessage[],
  ): Promise<AgentTurn> => {
    const head = messages[0];
    if (head?.role !== "system" || head.content !== INSTRUCTIONS) {
      summaries += 1;
      return { content: "SUMMARY", toolCalls: [] };
    }
    const k =
      index === "call"
        ? calls
        : messages.filter((m) => m.role === "assistant").length;
    calls += 1;
    const ask: AgentTurn = {
      content: `turn ${k}`,
      toolCalls: [{ callId: `c${calls}`, name: "search", args: { q: "tea" } }],
    };
    const usage = usages[k];
    return usage === undefined ? ask : { ...ask, usage };
  };
  return { model, calls: () => calls, summaries: () => summaries };
}

/** Stop (cancelled, conversation standing) once `n` turns have folded. */
const afterTurns = (n: number) => (state: S) =>
  (state.conversation?.turnCount ?? 0) >= n;

describe("TurnUsage on AgentTurn — the schema reads it, never estimates it", () => {
  const turn = { content: "hi", toolCalls: [] };

  it("accepts a turn with no usage — a persisted pre-#332 turn still parses", () => {
    expect(isAgentTurn(turn)).toBe(true);
    expect(agentTurnSchema.parse(turn)).toEqual(turn);
  });

  it("accepts a well-formed usage, with and without the optional counts", () => {
    const bare = { ...turn, usage: { inputTokens: 120, outputTokens: 30 } };
    const full = {
      ...turn,
      usage: {
        inputTokens: 120,
        outputTokens: 30,
        reasoningTokens: 12,
        cachedInputTokens: 0,
      },
    };
    expect(isAgentTurn(bare)).toBe(true);
    expect(isAgentTurn(full)).toBe(true);
    expect(agentTurnSchema.parse(full)).toEqual(full);
  });

  it.each([
    ["a non-numeric count", { inputTokens: "120", outputTokens: 30 }],
    ["a negative count", { inputTokens: -1, outputTokens: 30 }],
    ["a non-integer count", { inputTokens: 120, outputTokens: 1.5 }],
    ["a NaN count", { inputTokens: Number.NaN, outputTokens: 30 }],
    ["an infinite count", { inputTokens: Infinity, outputTokens: 30 }],
    ["a missing required count", { inputTokens: 120 }],
    [
      "a malformed optional count",
      { inputTokens: 120, outputTokens: 30, cachedInputTokens: -4 },
    ],
    [
      "a non-integer optional count",
      { inputTokens: 120, outputTokens: 30, reasoningTokens: 0.5 },
    ],
    ["null", null],
    ["a bare number", 150],
  ])("rejects %s", (_what, usage) => {
    const bad = { ...turn, usage };
    expect(isAgentTurn(bad)).toBe(false);
    expect(() => agentTurnSchema.parse(bad)).toThrow();
  });

  it("a brain turn with a malformed usage is the run's llm failure, not a NaN total", async () => {
    const model = async (): Promise<AgentTurn> =>
      ({
        content: "hi",
        toolCalls: [],
        usage: { inputTokens: -1, outputTokens: 0 },
      }) as AgentTurn;
    const failed = await defineAgent({
      model,
      tools: [search],
      instructions: INSTRUCTIONS,
    })
      .run(INPUT)
      .catch((e: { state: S }) => e.state);
    expect(status(failed).kind).toBe("failed");
    expect(failed.failure?.reason).toBe("llm");
  });
});

describe("state.usage — the run's running total", () => {
  it("sums every turn that reported usage, optional counts included, and skips the rest", async () => {
    const brain = metered([
      { inputTokens: 100, outputTokens: 10 },
      { inputTokens: 200, outputTokens: 20, cachedInputTokens: 80 },
      undefined,
    ]);
    const final = await defineAgent({
      model: brain.model,
      tools: [search],
      instructions: INSTRUCTIONS,
      stopWhen: afterTurns(3),
    }).run(INPUT);

    expect(status(final).kind).toBe("cancelled");
    expect(final.usage).toEqual({
      inputTokens: 300,
      outputTokens: 30,
      cachedInputTokens: 80,
    });
    // The last turn reported nothing, so there is no current context size.
    expect(final.conversation?.contextTokens).toBeNull();
  });

  it("a provider that never reports usage leaves a zero total with no optional counts", async () => {
    const brain = metered([]);
    const final = await defineAgent({
      model: brain.model,
      tools: [search],
      instructions: INSTRUCTIONS,
      stopWhen: afterTurns(2),
    }).run(INPUT);

    expect(final.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it("the latest context size is the last turn's input plus output", async () => {
    const brain = metered([
      { inputTokens: 100, outputTokens: 10 },
      { inputTokens: 240, outputTokens: 16 },
    ]);
    const final = await defineAgent({
      model: brain.model,
      tools: [search],
      instructions: INSTRUCTIONS,
      stopWhen: afterTurns(2),
    }).run(INPUT);

    expect(final.conversation?.contextTokens).toBe(256);
  });

  it("survives a compaction fold: the folded turns still count", async () => {
    const brain = metered([
      { inputTokens: 100, outputTokens: 10 },
      { inputTokens: 200, outputTokens: 20 },
      { inputTokens: 50, outputTokens: 5 },
    ]);
    const final = await defineAgent({
      model: brain.model,
      tools: [search],
      instructions: INSTRUCTIONS,
      compaction: { afterTurns: 2 },
      stopWhen: afterTurns(3),
    }).run(INPUT);

    expect(brain.summaries()).toBe(1);
    // The two folded turns are gone from the transcript, not from the total.
    expect(final.conversation?.turns[0]?.content).toBe("SUMMARY");
    expect(final.usage).toEqual({
      inputTokens: 350,
      outputTokens: 35,
    });
  });

  it("a fold clears the context size, and has no total of its own to touch", () => {
    const conv = {
      ...freshConversation<unknown>(),
      turns: [
        { content: "a", toolCalls: [] },
        { content: "b", toolCalls: [] },
      ],
      contextTokens: 550,
    };
    const folded = foldSummary(conv, 2, { content: "S", toolCalls: [] });
    expect("usage" in folded).toBe(false);
    expect(folded.contextTokens).toBeNull();
  });

  it("the next stage starts a fresh transcript but keeps the run's total", () => {
    type Stage = "plan" | "act";
    const agent = createAgent<
      Stage,
      "turn",
      { turn: AgentTurn },
      string,
      { readonly type: "noop" },
      unknown
    >({
      stages: ["plan", "act"],
      model: async () => ({ content: "", toolCalls: [] }),
      schemas: { turn: agentTurnSchema },
      turnOf: () => "turn",
      toolOf: () => ({ type: "noop" }),
    });
    let [s] = agent.start(agent.init(), "r", 0);
    [s] = agent.turn(
      s,
      {
        content: "planned",
        toolCalls: [],
        usage: { inputTokens: 70, outputTokens: 7 },
      },
      1,
    );

    expect(agent.currentStage(s)).toBe("act");
    expect(s.conversation?.turns).toEqual([]);
    expect(s.usage).toEqual({ inputTokens: 70, outputTokens: 7 });
    expect(s.conversation?.contextTokens).toBeNull();

    // A restart is a new run: its total starts from zero.
    [s] = agent.start(s, "r2", 2);
    expect(s.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe("state.usage is durable across a kill and a resume", () => {
  const USAGES: readonly TurnUsage[] = [
    { inputTokens: 100, outputTokens: 10 },
    { inputTokens: 200, outputTokens: 20, reasoningTokens: 4 },
    { inputTokens: 300, outputTokens: 30 },
  ];

  /**
   * Run 1 until the first tool's outcome is folded and the second brain call
   * is in flight, and copy out the bytes the Store holds at that moment — the
   * write a kill can never take back.
   */
  async function parkedAfterFirstTurn(): Promise<S> {
    const brain = metered(USAGES, "prompt");
    let park: (state: S) => void = () => {};
    const parkedAt = new Promise<S>((resolve) => {
      park = resolve;
    });
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = async (messages: readonly AgentMessage[]) => {
      if (messages.some((m) => m.role === "assistant")) await held;
      return brain.model(messages);
    };
    const live = memoryStore<S>();
    const store: Store<S> = {
      ...live,
      save: async (state) => {
        await live.save(state);
        if (
          state.conversation?.awaiting.kind === "llm" &&
          state.conversation.toolRecords.length === 1
        ) {
          park(JSON.parse(JSON.stringify(state)) as S);
        }
      },
    };
    const firstRun = defineAgent({
      model: holding,
      tools: [search],
      instructions: INSTRUCTIONS,
      stopWhen: afterTurns(3),
    }).run(INPUT, { store, runId: "run-1" });
    const parked = await parkedAt;
    release();
    await firstRun;
    return parked;
  }

  it("a resumed run reports the same total as an uninterrupted one", async () => {
    const uninterrupted = await defineAgent({
      model: metered(USAGES, "prompt").model,
      tools: [search],
      instructions: INSTRUCTIONS,
      stopWhen: afterTurns(3),
    }).run(INPUT);

    const parked = await parkedAfterFirstTurn();
    // The parked bytes already carry the first turn's cost.
    expect(parked.usage).toEqual(USAGES[0]);

    const second = metered(USAGES, "prompt");
    const resumed = await defineAgent({
      model: second.model,
      tools: [search],
      instructions: INSTRUCTIONS,
      stopWhen: afterTurns(3),
    }).run(INPUT, { store: memoryStore(parked), runId: "run-2" });

    // The resume made only the two calls the kill left outstanding…
    expect(second.calls()).toBe(2);
    expect(resumed.run.phase === "cancelled" && resumed.run.runId).toBe(
      "run-1",
    );
    // …and still reports what the whole run cost.
    expect(uninterrupted.usage).toEqual({
      inputTokens: 600,
      outputTokens: 60,
      reasoningTokens: 4,
    });
    expect(resumed.usage).toEqual(uninterrupted.usage);
    expect(resumed.conversation?.contextTokens).toBe(
      uninterrupted.conversation?.contextTokens,
    );
  });

  it("a Model persisted by 0.17.x (no usage fields) rehydrates, its total starting from zero", async () => {
    const parked = await parkedAfterFirstTurn();
    const conversation = parked.conversation;
    if (conversation === null) throw new Error("never parked");
    // What 0.17.x wrote: no usage readings, and turns that carry none.
    const { contextTokens: _c, ...legacy } = conversation;
    const { usage: _u, ...run } = parked;
    const persisted = {
      ...run,
      conversation: {
        ...legacy,
        turns: legacy.turns.map(({ usage: _t, ...t }) => t),
      },
    } as unknown as S;

    const resumed = await defineAgent({
      model: metered(USAGES, "prompt").model,
      tools: [search],
      instructions: INSTRUCTIONS,
      stopWhen: afterTurns(3),
    }).run(INPUT, { store: memoryStore(persisted) });

    expect(status(resumed).kind).toBe("cancelled");
    // Only the two turns this version saw are counted.
    expect(resumed.usage).toEqual({
      inputTokens: 500,
      outputTokens: 50,
      reasoningTokens: 4,
    });
  });

  it("a Model that held its total on the conversation (#332, before #354) resumes with it on the run, once", async () => {
    const parked = await parkedAfterFirstTurn();
    const conversation = parked.conversation;
    if (conversation === null) throw new Error("never parked");
    // What #332 wrote: the total on the conversation, none on the run.
    const { usage, ...run } = parked;
    const persisted = {
      ...run,
      conversation: { ...conversation, usage },
    } as unknown as S;

    const resumed = await defineAgent({
      model: metered(USAGES, "prompt").model,
      tools: [search],
      instructions: INSTRUCTIONS,
      stopWhen: afterTurns(3),
    }).run(INPUT, { store: memoryStore(persisted) });

    expect(resumed.usage).toEqual({
      inputTokens: 600,
      outputTokens: 60,
      reasoningTokens: 4,
    });
    // The conversation's copy went with the lift: one field holds the total.
    expect(
      resumed.conversation !== null && "usage" in resumed.conversation,
    ).toBe(false);
  });
});

describe("stopWhen over the running total — a token budget with no new knob", () => {
  it("stops the run at the first turn boundary past the budget", async () => {
    const brain = metered(
      Array.from({ length: 10 }, () => ({
        inputTokens: 100,
        outputTokens: 10,
      })),
    );
    const BUDGET = 250;
    const final = await defineAgent({
      model: brain.model,
      tools: [search],
      instructions: INSTRUCTIONS,
      stopWhen: ({ usage }) => usage.inputTokens + usage.outputTokens >= BUDGET,
    }).run(INPUT);

    // 110, 220, 330: the third turn crosses 250, so there is no fourth call.
    expect(status(final).kind).toBe("cancelled");
    expect(brain.calls()).toBe(3);
    expect(final.usage).toEqual({
      inputTokens: 300,
      outputTokens: 30,
    });
  });
});

describe("the run's total outlives the run (#354)", () => {
  type Stage = "plan" | "act";
  const TURN_USAGES: readonly TurnUsage[] = [
    { inputTokens: 100, outputTokens: 10 },
    { inputTokens: 200, outputTokens: 20, cachedInputTokens: 50 },
    { inputTokens: 300, outputTokens: 30, reasoningTokens: 6 },
  ];
  const SUM: TurnUsage = {
    inputTokens: 600,
    outputTokens: 60,
    cachedInputTokens: 50,
    reasoningTokens: 6,
  };

  function pipeline() {
    return createAgent<
      Stage,
      "turn",
      { turn: AgentTurn },
      string,
      { readonly type: "noop" },
      unknown
    >({
      stages: ["plan", "act"],
      model: async () => ({ content: "", toolCalls: [] }),
      schemas: { turn: agentTurnSchema },
      turnOf: () => "turn",
      toolOf: () => ({ type: "noop" }),
    });
  }

  it("a two-stage pipeline reports the sum of every turn once it is done", () => {
    const agent = pipeline();
    const [u0, u1, u2] = TURN_USAGES;
    let [s] = agent.start(agent.init(), "r", 0);
    // plan: a turn that asks for a tool, then one that ends the stage.
    [s] = agent.turn(
      s,
      {
        content: "look",
        toolCalls: [{ callId: "c1", name: "noop", args: {} }],
        usage: u0,
      },
      1,
    );
    // Live: the total is on the run, and the conversation holds no copy of it.
    expect(s.usage).toEqual(u0);
    expect(s.conversation !== null && "usage" in s.conversation).toBe(false);
    [s] = agent.toolOk(s, "c1", "seen", 2);
    [s] = agent.turn(s, { content: "planned", toolCalls: [], usage: u1 }, 3);
    expect(agent.currentStage(s)).toBe("act");
    // act: one turn ends the stage and the run.
    const last: AgentTurn = { content: "acted", toolCalls: [], usage: u2 };
    [s] = agent.turn(s, last, 4);

    expect(s.conversation).toBeNull();
    expect(s.usage).toEqual(SUM);
    expect(status(s)).toEqual({ kind: "done", output: last, usage: SUM });
    // The same total comes back across a Store round-trip.
    const saved = JSON.parse(JSON.stringify(s)) as typeof s;
    expect(status(saved)).toEqual({ kind: "done", output: last, usage: SUM });
  });

  it("RunDone's done status carries the total the run ended on", async () => {
    const brain = metered([...TURN_USAGES]);
    const ended: DefinedAgentEvent<typeof search>[] = [];
    let k = 0;
    const final = await defineAgent({
      // Two searches, then an answer: three turns, each reporting.
      model: async (messages: readonly AgentMessage[]) => {
        const turn = await brain.model(messages);
        k += 1;
        return k < 3 ? turn : { ...turn, toolCalls: [] };
      },
      tools: [search],
      instructions: INSTRUCTIONS,
    }).run(INPUT, {
      onEvent: (event) => {
        if (event.type === "RunDone") ended.push(event);
      },
    });

    expect(status(final)).toMatchObject({ kind: "done", usage: SUM });
    expect(ended).toHaveLength(1);
    const [done] = ended;
    expect(done?.type === "RunDone" && done.status).toMatchObject({
      kind: "done",
      usage: SUM,
    });
  });
});

describe("compaction.afterContextTokens — fold on the reported context size", () => {
  it("folds once the latest context size reaches the threshold, and not twice off one reading", async () => {
    const brain = metered([
      { inputTokens: 100, outputTokens: 10 }, // 110 — under
      { inputTokens: 240, outputTokens: 10 }, // 250 — at the threshold: fold
      undefined, // reports nothing: the cleared reading stays cleared
      { inputTokens: 90, outputTokens: 10 }, // 100 — under again
    ]);
    const final = await defineAgent({
      model: brain.model,
      tools: [search],
      instructions: INSTRUCTIONS,
      compaction: { afterContextTokens: 250 },
      stopWhen: afterTurns(4),
    }).run(INPUT);

    expect(status(final).kind).toBe("cancelled");
    expect(brain.summaries()).toBe(1);
    expect(final.conversation?.turns.map((t) => t.content)).toEqual([
      "SUMMARY",
      "turn 2",
      "turn 3",
    ]);
  });

  it("a rising size folds again only on a fresh reading past the threshold", async () => {
    const brain = metered([
      { inputTokens: 300, outputTokens: 0 }, // past it, but one turn folds nothing
      { inputTokens: 400, outputTokens: 0 }, // past it: fold the two turns
      { inputTokens: 500, outputTokens: 0 }, // a new reading past it: fold again
      { inputTokens: 100, outputTokens: 0 }, // under: no fold
    ]);
    const final = await defineAgent({
      model: brain.model,
      tools: [search],
      instructions: INSTRUCTIONS,
      compaction: { afterContextTokens: 250 },
      stopWhen: afterTurns(4),
    }).run(INPUT);

    expect(brain.summaries()).toBe(2);
    expect(final.conversation?.turns.map((t) => t.content)).toEqual([
      "SUMMARY",
      "turn 3",
    ]);
  });

  it("a model that reports no usage never fires it", async () => {
    const brain = metered([]);
    await defineAgent({
      model: brain.model,
      tools: [search],
      instructions: INSTRUCTIONS,
      compaction: { afterContextTokens: 1 },
      stopWhen: afterTurns(4),
    }).run(INPUT);

    expect(brain.summaries()).toBe(0);
  });

  it("beside afterTurns, whichever is reached first folds", async () => {
    const brain = metered([]);
    await defineAgent({
      model: brain.model,
      tools: [search],
      instructions: INSTRUCTIONS,
      compaction: { afterTurns: 2, afterContextTokens: 1_000_000 },
      stopWhen: afterTurns(3),
    }).run(INPUT);

    // Turn count reached, no usage reported: the count alone folds.
    expect(brain.summaries()).toBe(1);
  });
});

describe("TurnSettled carries the settled turn's usage", () => {
  it("beside the turn when reported, absent when not", async () => {
    const brain = metered([{ inputTokens: 120, outputTokens: 30 }, undefined]);
    const settled: DefinedAgentEvent<typeof search>[] = [];
    await defineAgent({
      model: brain.model,
      tools: [search],
      instructions: INSTRUCTIONS,
      stopWhen: afterTurns(2),
    }).run(INPUT, {
      onEvent: (event) => {
        if (event.type === "TurnSettled") settled.push(event);
      },
    });

    expect(settled).toHaveLength(2);
    const [first, second] = settled;
    expect(first?.type === "TurnSettled" && first.usage).toEqual({
      inputTokens: 120,
      outputTokens: 30,
    });
    expect(second !== undefined && "usage" in second).toBe(false);
  });
});
