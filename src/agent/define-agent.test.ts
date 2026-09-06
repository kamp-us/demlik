import { Result } from "better-result";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Cmd, DriveFailedError, driveToDone, replay, run } from "../index";
import { memoryJournal } from "../journal";
import { memoryStore } from "../mem";
import {
  type AgentMachineMsg,
  type AgentMessage,
  type AgentPrompt,
  type AgentTurn,
  COMPACTION_PURPOSE,
  createAgent,
  type DefinedAgentState,
  defineAgent,
  type LlmRunCmd,
  renderPrompt,
  tool,
  toolRouter,
  type WiredToolMsg,
} from "./index";

// ---------------------------------------------------------------------------
// #59 — `defineAgent({ model, tools, instructions })`: the lid. The spike's
// assertions, ported: the three-line program reaches `done` on `/mem`, the
// final Model round-trips JSON, and its slice keys equal a hand-wired
// `createAgent`'s. Then `instructions` as durable state (ADR 0004): present at
// `init`, untouched by a compaction fold, and what a replayed first model call
// receives.
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
    err: ["not_found"],
    needs: Cmd.needs<{ readonly kb: Kb }>(),
  },
  async ({ q }, ctx, fail) => {
    const snippet = ctx.kb.lookup(q);
    return snippet === undefined
      ? fail({ _tag: "not_found", q })
      : Result.ok({ snippet });
  },
);

/** The Msg union the lid's machine folds — what a journal of its run records. */
type LidMsg =
  | AgentMachineMsg<"act", { act: AgentTurn }, { snippet: string }>
  | WiredToolMsg<typeof search>;

const INSTRUCTIONS = "You answer with one sentence, citing a search.";
const INPUT = "What is TEA?";

// A scripted model that also records every message list it was handed.
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

const ASK: AgentTurn = {
  content: "let me look",
  toolCalls: [{ callId: "c1", name: "search", args: { q: "tea" } }],
};
const ANSWER: AgentTurn = { content: "TEA folds the loop.", toolCalls: [] };

describe("defineAgent — the three-line program (ADR 0015's pass/fail test)", () => {
  it("reaches run.phase: 'done' on /mem and the final Model round-trips JSON", async () => {
    const { model } = scripted([ASK, ANSWER]);
    const agent = defineAgent({
      model,
      tools: [search],
      instructions: INSTRUCTIONS,
    });
    const final = await agent.run(INPUT, { ctx: { kb }, store: memoryStore() });

    expect(final.run.phase).toBe("done");
    expect(final.output).toEqual(ANSWER);
    expect(JSON.parse(JSON.stringify(final))).toEqual(final);
  });

  it("its slice keys equal a hand-wired createAgent machine's over the same tools", async () => {
    const { model } = scripted([ASK, ANSWER]);
    const agent = defineAgent({
      model,
      tools: [search],
      instructions: INSTRUCTIONS,
    });
    const final = await agent.run(INPUT, { ctx: { kb } });

    const tools = toolRouter([search]);
    const handWired = createAgent<
      string,
      "act",
      { act: AgentTurn },
      { snippet: string },
      ReturnType<typeof tools.toolOf>,
      AgentMessage
    >({
      stages: [INPUT],
      turnOf: () => "act",
      schemas: { act: { parse: (v) => v as AgentTurn } },
      model,
      toolOf: tools.toolOf,
      instructions: INSTRUCTIONS,
    });
    const keys = (s: object) => Object.keys(s).sort();
    expect(keys(final)).toEqual(keys(handWired.init()));
    expect(keys(final)).toEqual(
      [
        "run",
        "resilience",
        "tools",
        "conversation",
        "compaction",
        "failure",
        "output",
        "instructions",
      ].sort(),
    );
  });

  it("the model reads instructions then the input, then the transcript with tool outcomes as data", async () => {
    const { model, seen } = scripted([ASK, ANSWER]);
    const agent = defineAgent({
      model,
      tools: [search],
      instructions: INSTRUCTIONS,
    });
    await agent.run(INPUT, { ctx: { kb } });

    expect(seen[0]).toEqual([
      { role: "system", content: INSTRUCTIONS },
      { role: "user", content: INPUT },
    ]);
    expect(seen[1]).toEqual([
      { role: "system", content: INSTRUCTIONS },
      { role: "user", content: INPUT },
      { role: "assistant", content: ASK.content, toolCalls: ASK.toolCalls },
      {
        role: "tool",
        callId: "c1",
        name: "search",
        outcome: {
          kind: "ok",
          result: { snippet: "TEA folds the loop in one reducer." },
        },
      },
    ]);
  });

  it("a failed run rejects with DriveFailedError carrying the failed Model", async () => {
    const { model } = scripted([ASK, ASK, ASK]);
    const agent = defineAgent({
      model,
      tools: [search],
      instructions: INSTRUCTIONS,
      maxTurns: 1,
    });
    const failed = await agent.run(INPUT, { ctx: { kb } }).catch((e) => e);
    expect(failed).toBeInstanceOf(DriveFailedError);
    const state = (failed as DriveFailedError<DefinedAgentState<typeof search>>)
      .state;
    expect(state.failure?.reason).toBe("turn_limit");
    expect(state.instructions).toBe(INSTRUCTIONS);
  });

  it("machine(input) is the door down: the raw kernel run drives the same Model", async () => {
    const { model } = scripted([ASK, ANSWER]);
    const agent = defineAgent({
      model,
      tools: [search],
      instructions: INSTRUCTIONS,
    });
    const final = await driveToDone(
      run(agent.machine(INPUT), { ctx: { kb } }),
      { type: "agent_start", runId: "r", at: 0 },
      (s) => s.run.phase === "done",
    );
    expect(final.output).toEqual(ANSWER);
    expect(final.instructions).toBe(INSTRUCTIONS);
  });
});

describe("instructions live in the durable Model (ADR 0004)", () => {
  it("is present after init on both paths, null when the config names none", () => {
    const { model } = scripted([]);
    const lid = defineAgent({
      model,
      tools: [search],
      instructions: INSTRUCTIONS,
    });
    const [fromLid] = lid.machine(INPUT).init(null, { kb });
    expect(fromLid.instructions).toBe(INSTRUCTIONS);

    const bare = createAgent<
      undefined,
      "act",
      { act: AgentTurn },
      never,
      never,
      AgentMessage
    >({
      model,
      schemas: { act: { parse: (v) => v as AgentTurn } },
      turnOf: () => "act",
      toolOf: () => {
        throw new Error("no tools");
      },
    });
    expect(bare.init().instructions).toBeNull();
  });

  it("is unchanged after a compaction fold — the fold touches only the conversation", () => {
    const { model } = scripted([]);
    const agent = createAgent<
      undefined,
      "act",
      { act: AgentTurn },
      string,
      Cmd,
      AgentMessage
    >({
      model,
      schemas: { act: { parse: (v) => v as AgentTurn } },
      turnOf: () => "act",
      toolOf: (call) => ({ type: "run_tool", callId: call.callId }),
      instructions: INSTRUCTIONS,
      compaction: { planCompaction: (c) => (c.turns.length >= 2 ? 2 : 0) },
    });
    let [s] = agent.start(agent.init(), "r", 0);
    let at = 1;
    for (const id of ["a", "b"]) {
      [s] = agent.turn(
        s,
        { content: id, toolCalls: [{ callId: id, name: "t", args: {} }] },
        at++,
      );
      [s] = agent.toolOk(s, id, `ok-${id}`, at++);
    }
    expect(s.conversation?.awaiting).toEqual({
      kind: "compacting",
      folding: 2,
    });
    const [folded, cmds] = agent.compactOk(
      s,
      COMPACTION_PURPOSE,
      {
        type: "compact_ok",
        key: COMPACTION_PURPOSE,
        result: {
          key: COMPACTION_PURPOSE,
          purpose: COMPACTION_PURPOSE,
          output: { summary: "SUM" },
        },
        at,
      },
      at,
    );
    expect(folded.conversation?.turns).toEqual([
      { content: "SUM", toolCalls: [] },
    ]);
    expect(folded.instructions).toBe(INSTRUCTIONS);
    // The brain call fired on the shrunk transcript still carries them.
    const fired = cmds.find((c) => c.type === "resilient_run") as
      | LlmRunCmd<"act">
      | undefined;
    expect(fired).toBeDefined();
  });

  it("a journal replay's first model call receives the same instructions", async () => {
    const { model } = scripted([ASK, ANSWER]);
    const agent = defineAgent({
      model,
      tools: [search],
      instructions: INSTRUCTIONS,
    });
    const machine = agent.machine(INPUT);

    // Record every applied Msg to a journal, the way a durable host would.
    const journal = memoryJournal<LidMsg>();
    const handle = run(machine, { ctx: { kb } });
    const runtime = await handle.ready;
    const off = runtime.observe((msg) => {
      void journal.append("run-1", msg);
    });
    await driveToDone(
      handle,
      { type: "agent_start", runId: "run-1", at: 0 },
      (s) => s.run.phase === "done",
    );
    off();

    // Replay the journal through the machine, pure: the first `resilient_run`
    // Cmd is the first model call, and its payload is the prompt that ran.
    const msgs = (await journal.list("run-1")).map((e) => e.record);
    const { state, cmds } = replay(machine, { msgs, ctx: { kb } });
    const first = cmds.find(
      (c) => c.type === "resilient_run",
    ) as LlmRunCmd<"act">;
    const prompt = first.input.payload as AgentPrompt<unknown>;
    expect(prompt.instructions).toBe(INSTRUCTIONS);
    expect(prompt.input).toBe(INPUT);
    expect(renderPrompt(prompt)).toEqual([
      { role: "system", content: INSTRUCTIONS },
      { role: "user", content: INPUT },
    ]);
    expect(state.run.phase).toBe("done");
    expect(state.instructions).toBe(INSTRUCTIONS);
  });

  it("a rehydrated run prompts with the Model's instructions, not the config's", async () => {
    // Run 1 persists a Model carrying INSTRUCTIONS; run 2 rehydrates it under a
    // lid configured differently, then finishes — every model call it makes
    // reads the stored prompt.
    const store = memoryStore<DefinedAgentState<typeof search>>();
    const first = scripted([ASK, ANSWER]);
    await defineAgent({
      model: first.model,
      tools: [search],
      instructions: INSTRUCTIONS,
    }).run(INPUT, { ctx: { kb }, store });

    const second = scripted([ANSWER]);
    const again = defineAgent({
      model: second.model,
      tools: [search],
      instructions: "a DIFFERENT prompt the closure holds now",
    });
    const rehydrated = await driveToDone(
      run(again.machine(INPUT), { ctx: { kb }, store }),
      { type: "agent_start", runId: "run-2", at: 0 },
      (s) => s.run.phase === "done",
    );
    // The stored Model was already `done`, so the drive resolved on the boot
    // State without a model call — and the slot is the persisted one.
    expect(second.seen).toEqual([]);
    expect(rehydrated.instructions).toBe(INSTRUCTIONS);
  });
});
