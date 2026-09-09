import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Store } from "../index";
import { memoryStore } from "../mem";
import {
  type AgentMessage,
  type AgentTurn,
  type DefinedAgentState,
  defineAgent,
  type ToolResult,
  tool,
  transcript,
} from "./index";

// ---------------------------------------------------------------------------
// #152 — the transcript collector. A finished run's Model clears
// `conversation`; this is the built-in seam that keeps the turns anyway,
// folded off the `onEvent` stream that already exists. Nothing about the Model
// changes, and the tests below say so both ways: the collected transcript is
// whole, AND a run without one is byte for byte what it was.
// ---------------------------------------------------------------------------

type Kb = { readonly lookup: (q: string) => string | undefined };
const kb: Kb = {
  lookup: (q) => ({ tea: "TEA folds the loop in one reducer." })[q],
};

const search = tool(
  "search",
  {
    description: "Look a phrase up in the knowledge base.",
    input: z.object({ q: z.string() }),
    ok: z.object({ snippet: z.string() }),
    err: [],
  },
  async ({ q }, _ctx, { ok }) => ok({ snippet: `about ${q}` }),
);

type Result = ToolResult<typeof search>;
type S = DefinedAgentState<typeof search>;

const INSTRUCTIONS = "You answer with one sentence, citing a search.";
const INPUT = "What is TEA?";

const ASK: AgentTurn = {
  content: "let me look",
  toolCalls: [{ callId: "c1", name: "search", args: { q: "tea" } }],
};
const ASK_AGAIN: AgentTurn = {
  content: "one more",
  toolCalls: [{ callId: "c2", name: "search", args: { q: "elm" } }],
};
const ANSWER: AgentTurn = { content: "TEA folds the loop.", toolCalls: [] };

function scripted(turns: readonly AgentTurn[]) {
  const seen: (readonly AgentMessage[])[] = [];
  let i = 0;
  const model = async (messages: readonly AgentMessage[]) => {
    seen.push(messages);
    const turn = turns[i] ?? { content: "", toolCalls: [] };
    i += 1;
    return turn;
  };
  return { model, seen };
}

describe("transcript — a finished run's turns, without hand-writing a collector", () => {
  it("holds every turn and every settled tool result of a multi-turn run", async () => {
    const { model } = scripted([ASK, ASK_AGAIN, ANSWER]);
    const t = transcript<Result>();
    const final = await defineAgent({
      model,
      tools: [search],
      instructions: INSTRUCTIONS,
    }).run(INPUT, { ctx: { kb }, store: memoryStore<S>(), onEvent: t.onEvent });

    // The Model kept its policy: the answer survives, the transcript does not.
    expect(final.run.phase).toBe("done");
    expect(final.conversation).toBeNull();
    expect(final.output).toEqual(ANSWER);

    // The collector kept what the Model dropped.
    const read = t.read();
    expect(read.turns).toEqual([ASK, ASK_AGAIN, ANSWER]);
    expect(read.tools).toEqual([
      { callId: "c1", result: { snippet: "about tea" } },
      { callId: "c2", result: { snippet: "about elm" } },
    ]);
    expect(read.outcome).toEqual({ kind: "done", output: ANSWER });
  });

  it("reads `running` until RunDone, and each read is an immutable snapshot", () => {
    const t = transcript<Result>();
    expect(t.read().outcome).toEqual({ kind: "running" });

    t.onEvent({ type: "TurnSettled", turn: ASK });
    const midRun = t.read();
    expect(midRun.turns).toEqual([ASK]);

    t.onEvent({ type: "RunDone", output: null });
    // The earlier snapshot did not move under the later events.
    expect(midRun.turns).toEqual([ASK]);
    expect(midRun.outcome).toEqual({ kind: "running" });
    expect(t.read().outcome).toEqual({ kind: "done", output: null });
  });

  it("a run with no collector attached is the run it always was", async () => {
    const lid = { tools: [search], instructions: INSTRUCTIONS } as const;
    // One frozen clock across both runs, so the only thing left that could
    // differ is the collector.
    const clock = () => 1_000;
    const bare = await defineAgent({
      model: scripted([ASK, ANSWER]).model,
      ...lid,
    }).run(INPUT, { ctx: { kb }, store: memoryStore<S>(), clock });

    const t = transcript<Result>();
    const collected = await defineAgent({
      model: scripted([ASK, ANSWER]).model,
      ...lid,
    }).run(INPUT, {
      ctx: { kb },
      store: memoryStore<S>(),
      clock,
      onEvent: t.onEvent,
    });

    // Model for Model, modulo the two stamps that are per-process by
    // construction: the runId each run minted fresh, and the watchdog's
    // `lastProgressAt`, which reads the host clock rather than `clock`.
    const erase = (s: S) =>
      JSON.parse(
        JSON.stringify({
          ...s,
          run: { ...s.run, runId: "x", lastProgressAt: 0 },
        }),
      );
    expect(erase(collected)).toEqual(erase(bare));
    expect(bare.conversation).toBeNull();
    expect(collected.conversation).toBeNull();
    expect(t.read().turns).toEqual([ASK, ANSWER]);
  });
});

describe("transcript — a run that survives a kill and a resume", () => {
  it("a seeded collector holds the killed process's turns beside its own", async () => {
    // Run 1: the first turn asks for the tool, and the SECOND brain call is
    // held open so the run never finishes. The bytes the Store is handed at
    // that moment — tool outcome folded, `awaiting: llm` — are the Model a
    // kill leaves behind.
    const first = scripted([ASK]);
    let release: (turn: AgentTurn) => void = () => {};
    const held = new Promise<AgentTurn>((resolve) => {
      release = resolve;
    });
    const holding = async (messages: readonly AgentMessage[]) =>
      first.seen.length === 0 ? first.model(messages) : held;

    let park: (state: S) => void = () => {};
    const parkedAt = new Promise<S>((resolve) => {
      park = resolve;
    });
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

    const killed = transcript<Result>();
    const firstRun = defineAgent({
      model: holding,
      tools: [search],
      instructions: INSTRUCTIONS,
    }).run(INPUT, {
      ctx: { kb },
      store,
      runId: "run-1",
      onEvent: killed.onEvent,
    });
    const parked = await parkedAt;
    release(ANSWER);
    await firstRun;

    // Run 2 is a NEW process, so it gets a new collector — seeded from the
    // Model the Store handed back, which is the whole point of the seed.
    const resumed = transcript<Result>({ conversation: parked.conversation });
    const final = await defineAgent({
      model: scripted([ANSWER]).model,
      tools: [search],
      instructions: INSTRUCTIONS,
    }).run(INPUT, {
      ctx: { kb },
      store: memoryStore(parked),
      runId: "run-2",
      onEvent: resumed.onEvent,
    });

    expect(final.run.phase).toBe("done");
    expect(final.conversation).toBeNull();

    // Every turn of the run is here — the one the killed process settled and
    // the one this process did — plus the tool the killed process ran.
    const read = resumed.read();
    expect(read.turns).toEqual([ASK, ANSWER]);
    expect(read.tools).toEqual([
      { callId: "c1", result: { snippet: "about tea" } },
    ]);
    expect(read.outcome).toEqual({ kind: "done", output: ANSWER });

    // And the seed is what earned it: an UNSEEDED collector on the resumed
    // process would have held only this process's leg.
    expect(transcript<Result>().read().turns).toEqual([]);
  });
});
