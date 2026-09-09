import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  Cmd,
  DriveFailedError,
  driveToDone,
  replay,
  run,
  type Store,
} from "../index";
import { memoryJournal } from "../internal/journal";
import { memoryStore } from "../mem";
import {
  type AgentMachineMsg,
  type AgentMessage,
  type AgentPrompt,
  type AgentTurn,
  agentBootMsg,
  agentTurnSchema,
  COMPACTION_PURPOSE,
  createAgent,
  type DefinedAgentEvent,
  type DefinedAgentState,
  defineAgent,
  isAgentTurn,
  isStreamingModel,
  type LlmRunCmd,
  type ModelStream,
  renderPrompt,
  status,
  type TurnChunk,
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
  async ({ q }, ctx, { ok, fail }) => {
    const snippet = ctx.kb.lookup(q);
    return snippet === undefined
      ? fail({ _tag: "not_found", q })
      : ok({ snippet });
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
        "toolResilience",
        "refusedCalls",
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

describe("agent.run resumes a Model the Store hands back mid-run (#60)", () => {
  it("boots at the outstanding brain call: same runId, the tool is not re-run", async () => {
    const calls: string[] = [];
    const counted = tool(
      "search",
      {
        description: "Look a phrase up in the knowledge base.",
        input: z.object({ q: z.string() }),
        ok: z.object({ snippet: z.string() }),
        err: [],
      },
      async ({ q }, _ctx, { ok }) => {
        calls.push(q);
        return ok({ snippet: `about ${q}` });
      },
    );
    type S = DefinedAgentState<typeof counted>;

    // Run 1: the first turn asks for the tool; the second brain call is held
    // open, and the bytes the Store is handed at that moment — tool outcome
    // folded, `awaiting: llm` — are copied out at the `save` seam (the one
    // write a kill can never take back). The held call is then released so
    // this runtime can drain: `stop()` awaits in-flight Cmds, a kill does not.
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
    const firstRun = defineAgent({
      model: holding,
      tools: [counted],
      instructions: INSTRUCTIONS,
    }).run(INPUT, { store, runId: "run-1" });
    const parked = await parkedAt;
    release(ANSWER);
    await firstRun;
    expect(parked.run.phase).toBe("running");
    expect(calls).toEqual(["tea"]);

    // Run 2: the same three lines over a Store holding those bytes. The lid
    // boots the parked Model instead of starting over.
    const second = scripted([ANSWER]);
    const final = await defineAgent({
      model: second.model,
      tools: [counted],
      instructions: INSTRUCTIONS,
    }).run(INPUT, { store: memoryStore(parked), runId: "run-2" });

    expect(final.run.phase).toBe("done");
    expect(final.run.phase === "done" && final.run.runId).toBe("run-1");
    expect(final.output).toEqual(ANSWER);
    expect(calls).toEqual(["tea"]);
    // The resumed brain call carries the transcript the first process built.
    expect(second.seen).toHaveLength(1);
    expect(second.seen[0]?.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
    ]);
  });

  it("a Store holding a finished run resolves it without a model call", async () => {
    const store = memoryStore<DefinedAgentState<typeof search>>();
    const first = scripted([ASK, ANSWER]);
    const lid = { tools: [search], instructions: INSTRUCTIONS } as const;
    await defineAgent({ model: first.model, ...lid }).run(INPUT, {
      ctx: { kb },
      store,
    });
    const second = scripted([]);
    const again = await defineAgent({ model: second.model, ...lid }).run(
      INPUT,
      { ctx: { kb }, store },
    );
    expect(again.output).toEqual(ANSWER);
    expect(second.seen).toEqual([]);
  });
});

// The lid's boot predicate reads `status(model).kind` (#101): `running` and
// `suspended` are booted, `idle` is started, `done` resolves as it is. The
// `running` arm is the #60 test above; these pin the other three.
describe("agent.run picks start vs boot off status(model).kind (#101)", () => {
  type S = DefinedAgentState<typeof search>;
  const lid = { tools: [search], instructions: INSTRUCTIONS } as const;

  /** Run once with `model`, copying out the first Model saved for which `at` holds. */
  async function parkWhen(
    model: (messages: readonly AgentMessage[]) => Promise<AgentTurn>,
    at: (state: S) => boolean,
    runId: string,
  ): Promise<S> {
    let parked: S | undefined;
    const live = memoryStore<S>();
    const store: Store<S> = {
      ...live,
      save: async (state) => {
        await live.save(state);
        if (parked === undefined && at(state)) {
          parked = JSON.parse(JSON.stringify(state)) as S;
        }
      },
    };
    await defineAgent({ model, ...lid }).run(INPUT, {
      ctx: { kb },
      store,
      runId,
    });
    if (parked === undefined) throw new Error("never parked");
    return parked;
  }

  it("a suspended Model (awaiting tools) boots with the same runId; the tool is the resumed effect", async () => {
    const parked = await parkWhen(
      scripted([ASK, ANSWER]).model,
      (s) => s.conversation?.awaiting.kind === "tools",
      "run-1",
    );
    expect(status(parked).kind).toBe("suspended");

    const second = scripted([ANSWER]);
    const final = await defineAgent({ model: second.model, ...lid }).run(
      INPUT,
      { ctx: { kb }, store: memoryStore(parked), runId: "run-2" },
    );
    expect(final.run.phase === "done" && final.run.runId).toBe("run-1");
    expect(final.output).toEqual(ANSWER);
    // Booted, not started: the one model call it makes reads the transcript
    // the first process built, with the resumed tool's outcome folded in.
    expect(second.seen).toHaveLength(1);
    expect(second.seen[0]?.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
    ]);
  });

  it("an empty Store (idle Model) starts with the runId the call names", async () => {
    const { model, seen } = scripted([ANSWER]);
    const final = await defineAgent({ model, ...lid }).run(INPUT, {
      ctx: { kb },
      store: memoryStore<S>(),
      runId: "fresh",
    });
    expect(final.run.phase === "done" && final.run.runId).toBe("fresh");
    // Started, not booted: the first model call reads only the head.
    expect(seen).toEqual([
      [
        { role: "system", content: INSTRUCTIONS },
        { role: "user", content: INPUT },
      ],
    ]);
  });

  it("a done Model resolves as-is: its runId, no model call", async () => {
    const done = await parkWhen(
      scripted([ASK, ANSWER]).model,
      (s) => s.run.phase === "done",
      "run-1",
    );
    expect(status(done).kind).toBe("done");

    const second = scripted([]);
    const again = await defineAgent({ model: second.model, ...lid }).run(
      INPUT,
      { ctx: { kb }, store: memoryStore(done), runId: "run-2" },
    );
    expect(again).toEqual(done);
    expect(second.seen).toEqual([]);
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

// ---------------------------------------------------------------------------
// #93 — `AgentTurn.provider`: the opaque passthrough slot. What the adapter
// returns beside `content` / `toolCalls` (a signed thinking block, say) is
// stored on the turn and handed back verbatim on the `assistant` message after
// a persist + resume; a Model persisted before the slot existed still boots.
// ---------------------------------------------------------------------------

describe("AgentTurn.provider — the opaque passthrough slot (#93)", () => {
  const PROVIDER = {
    blocks: [{ type: "thinking", thinking: "…", signature: "sig-abc" }],
  };
  const ASK_WITH_PROVIDER: AgentTurn = { ...ASK, provider: PROVIDER };

  /**
   * Run 1 with `ask` as its first turn and snapshot the Model the store saved
   * at `suspended` (tools in flight) — the point a host dies at. The snapshot
   * crosses a JSON boundary, so it is the persisted shape a real store holds.
   */
  async function persistSuspended(
    ask: AgentTurn,
  ): Promise<DefinedAgentState<typeof search>> {
    const { model } = scripted([ask, ANSWER]);
    const agent = defineAgent({
      model,
      tools: [search],
      instructions: INSTRUCTIONS,
    });
    const handle = run(agent.machine(INPUT), { ctx: { kb } });
    const runtime = await handle.ready;
    let snapshot: DefinedAgentState<typeof search> | undefined;
    const off = runtime.observe((_msg, s) => {
      if (snapshot === undefined && status(s).kind === "suspended") {
        snapshot = JSON.parse(JSON.stringify(s));
      }
    });
    await driveToDone(
      handle,
      { type: "agent_start", runId: "run-1", at: 0 },
      (s) => s.run.phase === "done",
    );
    off();
    if (snapshot === undefined) throw new Error("run 1 never suspended");
    return snapshot;
  }

  /** Cold-wake `persisted` under a fresh lid and drive it to `done`. */
  async function resume(persisted: DefinedAgentState<typeof search>) {
    const second = scripted([ANSWER]);
    const again = defineAgent({
      model: second.model,
      tools: [search],
      instructions: INSTRUCTIONS,
    });
    const final = await driveToDone(
      run(again.machine(INPUT), { ctx: { kb }, store: memoryStore(persisted) }),
      agentBootMsg(0),
      (s) => s.run.phase === "done",
    );
    return { final, seen: second.seen };
  }

  it("isAgentTurn / agentTurnSchema accept the slot present and absent", () => {
    expect(isAgentTurn(ASK)).toBe(true);
    expect(isAgentTurn(ASK_WITH_PROVIDER)).toBe(true);
    expect(agentTurnSchema.parse(ASK)).toEqual(ASK);
    expect(agentTurnSchema.parse(ASK_WITH_PROVIDER)).toEqual(ASK_WITH_PROVIDER);
    // Whatever the adapter puts there is its own business — tea does not read it.
    expect(isAgentTurn({ ...ASK, provider: null })).toBe(true);
    expect(isAgentTurn({ ...ASK, provider: "raw" })).toBe(true);
  });

  it("renderPrompt passes the stored slot through verbatim, and omits it when absent", () => {
    const conversation = {
      turns: [ASK_WITH_PROVIDER, ASK],
      toolRecords: [],
      awaiting: { kind: "llm" as const },
    };
    const prompt = {
      instructions: null,
      input: null,
      conversation,
    } as unknown as AgentPrompt<unknown>;
    const [withSlot, without] = renderPrompt(prompt);
    expect(withSlot).toEqual({
      role: "assistant",
      content: ASK.content,
      toolCalls: ASK.toolCalls,
      provider: PROVIDER,
    });
    expect(withSlot).toHaveProperty("provider", PROVIDER);
    expect(without).toEqual({
      role: "assistant",
      content: ASK.content,
      toolCalls: ASK.toolCalls,
    });
    expect(without).not.toHaveProperty("provider");
  });

  it("round trip: a PlainModel's opaque value is persisted, resumed, and handed back on the earlier assistant turn", async () => {
    const persisted = await persistSuspended(ASK_WITH_PROVIDER);
    const stored = persisted.conversation?.turns[0];
    expect(stored?.provider).toEqual(PROVIDER);

    const { final, seen } = await resume(persisted);
    expect(final.run.phase).toBe("done");
    // The one model call after the cold wake reads the transcript back with
    // the slot exactly as the adapter returned it on run 1.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([
      { role: "system", content: INSTRUCTIONS },
      { role: "user", content: INPUT },
      {
        role: "assistant",
        content: ASK.content,
        toolCalls: ASK.toolCalls,
        provider: PROVIDER,
      },
      {
        role: "tool",
        callId: "c1",
        name: "search",
        outcome: { kind: "ok", result: { snippet: kb.lookup("tea") } },
      },
    ]);
  });

  it("a persisted Model whose turns lack the slot still boots and replays", async () => {
    // The fixture is a Model persisted before #93: its turns carry only
    // `{ content, toolCalls }`.
    const persisted = await persistSuspended(ASK);
    expect(persisted.conversation?.turns[0]).toEqual(ASK);
    expect(persisted.conversation?.turns[0]).not.toHaveProperty("provider");

    const { final, seen } = await resume(persisted);
    expect(final.run.phase).toBe("done");
    expect(seen).toHaveLength(1);
    const [, , assistant] = seen[0] ?? [];
    expect(assistant).toEqual({
      role: "assistant",
      content: ASK.content,
      toolCalls: ASK.toolCalls,
    });
    expect(assistant).not.toHaveProperty("provider");
  });
});

// ---------------------------------------------------------------------------
// #122 — `onEvent`: the progress seam. The lid forwards the runtime's existing
// semantic stream (`agentEvents()` / `runtime.on`) so a consumer sees a run's
// turn-level events without dropping to `machine(input)` and the raw kernel
// loop. It mints no vocabulary, does not re-emit what settled before a boot,
// and a throwing listener cannot take the run down.
// ---------------------------------------------------------------------------

describe("onEvent — turn-level events off the lid (#122)", () => {
  // A pinned identity and clock, so two runs of the same program are comparable
  // Model for Model — the only way to assert an omitted `onEvent` changed nothing.
  const PINNED = {
    ctx: { kb },
    runId: "run-pinned",
    clock: () => 0,
  } as const;

  /** Drive `INPUT` to done, collecting every event the lid forwards. */
  async function collect(opts: { readonly onEvent?: () => void } = {}) {
    const { model } = scripted([ASK, ANSWER]);
    const agent = defineAgent({
      model,
      tools: [search],
      instructions: INSTRUCTIONS,
    });
    const events: DefinedAgentEvent<typeof search>[] = [];
    const final = await agent.run(INPUT, {
      ...PINNED,
      onEvent: (event) => {
        events.push(event);
        opts.onEvent?.();
      },
    });
    return { final, events };
  }

  it("delivers TurnSettled / ToolSettled / RunDone in the order the kernel settles them", async () => {
    const { final, events } = await collect();

    expect(events.map((e) => e.type)).toEqual([
      "TurnSettled",
      "ToolSettled",
      "TurnSettled",
      "RunDone",
    ]);
    // Each event carries the settle it names, typed against this agent's tools.
    expect(events[0]).toEqual({ type: "TurnSettled", turn: ASK });
    expect(events[1]).toEqual({
      type: "ToolSettled",
      callId: "c1",
      result: { snippet: kb.lookup("tea") },
    });
    expect(events[2]).toEqual({ type: "TurnSettled", turn: ANSWER });
    expect(events[3]).toEqual({ type: "RunDone", output: ANSWER });
    expect(final.output).toEqual(ANSWER);
  });

  it("a resumed run re-emits nothing that settled before the boot", async () => {
    // Run 1 dies mid-flight: snapshot the Model at the moment the first turn
    // AND its tool have both settled and the second brain call is outstanding.
    // Everything in that snapshot is a step a listener on run 2 must not see.
    const first = scripted([ASK, ANSWER]);
    const agent = defineAgent({
      model: first.model,
      tools: [search],
      instructions: INSTRUCTIONS,
    });
    const handle = run(agent.machine(INPUT), { ctx: { kb } });
    const runtime = await handle.ready;
    let snapshot: DefinedAgentState<typeof search> | undefined;
    const off = runtime.observe((_msg, s) => {
      if (
        snapshot === undefined &&
        s.conversation?.awaiting.kind === "llm" &&
        s.conversation.toolRecords.length === 1
      ) {
        snapshot = JSON.parse(JSON.stringify(s));
      }
    });
    await driveToDone(
      handle,
      { type: "agent_start", runId: "run-1", at: 0 },
      (s) => s.run.phase === "done",
    );
    off();
    if (snapshot === undefined) throw new Error("run 1 never settled its tool");

    // Run 2 boots those bytes. Only transitions THIS process applies project
    // events, so the first turn and the tool the snapshot already carries are
    // not replayed to the listener.
    const second = scripted([ANSWER]);
    const events: DefinedAgentEvent<typeof search>[] = [];
    const final = await defineAgent({
      model: second.model,
      tools: [search],
      instructions: INSTRUCTIONS,
    }).run(INPUT, {
      ctx: { kb },
      store: memoryStore(snapshot),
      onEvent: (event) => events.push(event),
    });

    expect(final.run.phase).toBe("done");
    expect(events.map((e) => e.type)).toEqual(["TurnSettled", "RunDone"]);
    expect(events[0]).toEqual({ type: "TurnSettled", turn: ANSWER });
  });

  it("a listener that throws is contained: the run still resolves, the throw is warned", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { final, events } = await collect({
        onEvent: () => {
          throw new Error("listener defect");
        },
      });

      // Every event was still offered, and the run reached its terminal Model.
      expect(events.map((e) => e.type)).toEqual([
        "TurnSettled",
        "ToolSettled",
        "TurnSettled",
        "RunDone",
      ]);
      expect(final.run.phase).toBe("done");
      expect(final.output).toEqual(ANSWER);
      expect(warn).toHaveBeenCalledTimes(4);
    } finally {
      warn.mockRestore();
    }
  });

  it("omitting onEvent leaves run's contract as it was: same resolution, same DriveFailedError", async () => {
    const { model } = scripted([ASK, ANSWER]);
    const silent = await defineAgent({
      model,
      tools: [search],
      instructions: INSTRUCTIONS,
    }).run(INPUT, PINNED);
    const { final } = await collect();
    // The run's outcome, its identity and the transcript it built — every part
    // of the Model `run` promises a caller. A listener observes; it decides
    // nothing. (`run.lastProgressAt` is the watchdog's wall clock, not the
    // pinned one, so it is the run's timing rather than its contract.)
    expect(silent.run.phase).toBe(final.run.phase);
    expect(silent.run.phase === "done" && silent.run.runId).toBe(
      final.run.phase === "done" && final.run.runId,
    );
    expect(silent.run.progressSeq).toBe(final.run.progressSeq);
    expect(silent.output).toEqual(final.output);
    expect(silent.conversation).toEqual(final.conversation);
    expect(silent.instructions).toEqual(final.instructions);
    expect(silent.failure).toEqual(final.failure);

    const limited = scripted([ASK, ASK, ASK]);
    const failed = await defineAgent({
      model: limited.model,
      tools: [search],
      instructions: INSTRUCTIONS,
      maxTurns: 1,
    })
      .run(INPUT, { ctx: { kb } })
      .catch((e) => e);
    expect(failed).toBeInstanceOf(DriveFailedError);
    expect(
      (failed as DriveFailedError<DefinedAgentState<typeof search>>).state
        .failure?.reason,
    ).toBe("turn_limit");
  });
});

// ---------------------------------------------------------------------------
// #123 — the streaming model port. `defineAgent` takes a second, optional brain
// shape — `async (messages, { onChunk }) => turn` — and forwards its deltas to
// the `onChunk` run option. The ruling these tests pin is "streaming is a side
// channel, never state": a chunk never reaches the Model, so the settled turn is
// the same whether or not anyone watched, a replay reproduces that Model, and a
// resume re-emits nothing.
// ---------------------------------------------------------------------------

describe("onChunk — the streaming model port (#123)", () => {
  const PINNED = {
    ctx: { kb },
    runId: "run-pinned",
    clock: () => 0,
  } as const;

  /**
   * The same scripted brain as `scripted`, in the STREAMING shape: it emits one
   * chunk per word of the turn it is about to resolve, then resolves that exact
   * turn. Written inline with no parameter annotations, so the config field's
   * type is what makes `messages` and `onChunk` typed — a reader pastes this.
   */
  function streamed(turns: readonly AgentTurn[]) {
    const seen: (readonly AgentMessage[])[] = [];
    let i = 0;
    const model = async (
      messages: readonly AgentMessage[],
      { onChunk }: ModelStream,
    ) => {
      seen.push(messages);
      const turn = turns[i] ?? { content: "", toolCalls: [] };
      i += 1;
      for (const text of turn.content.split(" ")) onChunk({ text });
      return turn;
    };
    return { model, seen };
  }

  const words = (turn: AgentTurn) => turn.content.split(" ");

  it("forwards the model's deltas to onChunk, each before the turn it belongs to settles", async () => {
    const { model } = streamed([ASK, ANSWER]);
    const agent = defineAgent({
      model,
      tools: [search],
      instructions: INSTRUCTIONS,
    });
    const trace: string[] = [];
    const final = await agent.run(INPUT, {
      ...PINNED,
      onChunk: (chunk) => trace.push(`chunk:${chunk.text}`),
      onEvent: (event) => trace.push(event.type),
    });

    // Every delta the model wrote, in the order it wrote them.
    expect(trace.filter((t) => t.startsWith("chunk:"))).toEqual(
      [...words(ASK), ...words(ANSWER)].map((w) => `chunk:${w}`),
    );
    // And each turn's deltas arrive while that turn is still in flight — the
    // whole point of the seam — so they land before its `TurnSettled`. Only
    // that relation is asserted: how a chunk interleaves with an event of
    // ANOTHER turn is the kernel's scheduling, not this seam's contract.
    const settles = trace.flatMap((t, i) => (t === "TurnSettled" ? [i] : []));
    const lastOf = (turn: AgentTurn) =>
      trace.lastIndexOf(`chunk:${words(turn).at(-1)}`);
    expect(lastOf(ASK)).toBeLessThan(settles[0] ?? -1);
    expect(lastOf(ANSWER)).toBeLessThan(settles[1] ?? -1);
    expect(trace.at(-1)).toBe("RunDone");
    expect(final.output).toEqual(ANSWER);
  });

  it("the settled Model is identical whether or not the chunks were consumed", async () => {
    const drive = (onChunk?: (chunk: TurnChunk) => void) =>
      defineAgent({
        model: streamed([ASK, ANSWER]).model,
        tools: [search],
        instructions: INSTRUCTIONS,
      }).run(INPUT, { ...PINNED, onChunk });

    const chunks: TurnChunk[] = [];
    const watched = await drive((chunk) => chunks.push(chunk));
    const unwatched = await drive();

    // Chunks did flow — otherwise this asserts nothing.
    expect(chunks.map((c) => c.text)).toEqual([
      ...words(ASK),
      ...words(ANSWER),
    ]);
    // And the durable Model does not record that they did — the two runs
    // serialize to the same bytes. `run.lastProgressAt` is normalized away: it
    // is the watchdog's wall clock, the run's timing rather than its contract.
    const durable = (s: DefinedAgentState<typeof search>) =>
      JSON.parse(
        JSON.stringify({ ...s, run: { ...s.run, lastProgressAt: 0 } }),
      );
    expect(durable(unwatched)).toEqual(durable(watched));
  });

  it("a replay of a streamed run reproduces the same Model, with no chunk in the journal", async () => {
    const { model } = streamed([ASK, ANSWER]);
    const agent = defineAgent({
      model,
      tools: [search],
      instructions: INSTRUCTIONS,
    });
    const machine = agent.machine(INPUT);
    const journal = memoryJournal<LidMsg>();
    const handle = run(machine, { ctx: { kb } });
    const runtime = await handle.ready;
    const off = runtime.observe((msg) => {
      void journal.append("run-1", msg);
    });
    const live = await driveToDone(
      handle,
      { type: "agent_start", runId: "run-1", at: 0 },
      (s) => s.run.phase === "done",
    );
    off();

    // Re-fold the recorded Msgs, purely. The replay makes no model call, so it
    // produces no chunk — and it does not need one, because the journal records
    // the settled turns and a chunk was never a Msg to record.
    const msgs = (await journal.list("run-1")).map((e) => e.record);
    const { state } = replay(machine, { msgs, ctx: { kb } });
    expect(state.conversation).toEqual(live.conversation);
    expect(state.output).toEqual(live.output);
    expect(JSON.stringify(msgs)).not.toContain("onChunk");
  });

  it("a resumed run re-emits no chunk of a turn that already settled", async () => {
    // Run 1 dies with the first turn and its tool settled — every delta of that
    // turn is spent. A listener on run 2 must hear only run 2's own turn.
    const first = streamed([ASK, ANSWER]);
    const agent = defineAgent({
      model: first.model,
      tools: [search],
      instructions: INSTRUCTIONS,
    });
    const handle = run(agent.machine(INPUT), { ctx: { kb } });
    const runtime = await handle.ready;
    let snapshot: DefinedAgentState<typeof search> | undefined;
    const off = runtime.observe((_msg, s) => {
      if (
        snapshot === undefined &&
        s.conversation?.awaiting.kind === "llm" &&
        s.conversation.toolRecords.length === 1
      ) {
        snapshot = JSON.parse(JSON.stringify(s));
      }
    });
    await driveToDone(
      handle,
      { type: "agent_start", runId: "run-1", at: 0 },
      (s) => s.run.phase === "done",
    );
    off();
    if (snapshot === undefined) throw new Error("run 1 never settled its tool");

    const chunks: TurnChunk[] = [];
    const final = await defineAgent({
      model: streamed([ANSWER]).model,
      tools: [search],
      instructions: INSTRUCTIONS,
    }).run(INPUT, {
      ctx: { kb },
      store: memoryStore(snapshot),
      onChunk: (chunk) => chunks.push(chunk),
    });

    expect(final.run.phase).toBe("done");
    expect(chunks.map((c) => c.text)).toEqual(words(ANSWER));
  });

  it("a plain model is invoked exactly as before: one argument, no chunks", async () => {
    // `rest` is not counted by `Function.length`, so this reads as the plain
    // shape — and it records what the port was actually handed.
    const rests: number[] = [];
    let i = 0;
    const turns = [ASK, ANSWER];
    const model = async (
      _messages: readonly AgentMessage[],
      ...rest: readonly unknown[]
    ) => {
      rests.push(rest.length);
      const turn = turns[i] ?? ANSWER;
      i += 1;
      return turn;
    };
    const chunks: TurnChunk[] = [];
    const final = await defineAgent({
      model,
      tools: [search],
      instructions: INSTRUCTIONS,
    }).run(INPUT, { ...PINNED, onChunk: (chunk) => chunks.push(chunk) });

    expect(final.output).toEqual(ANSWER);
    expect(rests).toEqual([0, 0]);
    expect(chunks).toEqual([]);
  });

  it("a throwing onChunk is contained: the run still resolves, the throw is warned", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const final = await defineAgent({
        model: streamed([ASK, ANSWER]).model,
        tools: [search],
        instructions: INSTRUCTIONS,
      }).run(INPUT, {
        ...PINNED,
        onChunk: () => {
          throw new Error("progress bar defect");
        },
      });

      // The model call did not reject, so no `resilient_err` was settled for a
      // defect in the listener — the run reached its terminal Model.
      expect(final.run.phase).toBe("done");
      expect(final.output).toEqual(ANSWER);
      expect(warn).toHaveBeenCalledTimes(
        words(ASK).length + words(ANSWER).length,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("isStreamingModel reads the arity, so neither shape needs a config flag", () => {
    expect(
      isStreamingModel(async (_m: readonly AgentMessage[]) => ANSWER),
    ).toBe(false);
    expect(
      isStreamingModel(
        async (_m: readonly AgentMessage[], _s: ModelStream) => ANSWER,
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #115 — the failure a tool declares is data the HOST can branch on, not only
// prose the model reads. The tag and its payload ride the outcome beside the
// rendered `reason`; `onToolError` is the lid's typed seam onto them.
// ---------------------------------------------------------------------------

/** A turn that asks for a search that misses, and for a tool nobody declared. */
const ASK_BADLY: AgentTurn = {
  content: "let me try two things",
  toolCalls: [
    { callId: "c1", name: "search", args: { q: "nope" } },
    { callId: "c2", name: "teleport", args: {} },
  ],
};

/**
 * Drive `turns` to done, keeping the last State that still HELD a conversation.
 * The terminal Model retires it (`conversation: null`), so a fold assertion has
 * to read the run in flight rather than its answer.
 */
async function lastConversationState(turns: readonly AgentTurn[]) {
  const { model } = scripted(turns);
  const agent = defineAgent({
    model,
    tools: [search],
    instructions: INSTRUCTIONS,
  });
  const handle = run(agent.machine(INPUT), { ctx: { kb } });
  const runtime = await handle.ready;
  let held: DefinedAgentState<typeof search> | undefined;
  const off = runtime.observe((_msg, s) => {
    if (s.conversation !== null) held = s;
  });
  const final = await driveToDone(
    handle,
    { type: "agent_start", runId: "run-1", at: 0 },
    (s) => s.run.phase === "done",
  );
  off();
  if (held === undefined) throw new Error("the run never held a conversation");
  return { held, final, records: held.conversation?.toolRecords ?? [] };
}

describe("tool failures carry their tag into the conversation (#115)", () => {
  it("the folded record keeps `{ _tag, …payload }` beside the reason", async () => {
    const { records } = await lastConversationState([ASK_BADLY, ANSWER]);

    const byId = new Map(records.map((r) => [r.call.callId, r]));
    expect(byId.get("c1")?.outcome).toEqual({
      kind: "error",
      _tag: "not_found",
      q: "nope",
      reason: 'not_found {"q":"nope"}',
    });
    expect(byId.get("c2")?.outcome).toEqual({
      kind: "error",
      _tag: "unknown_tool",
      name: "teleport",
      reason: 'unknown_tool {"name":"teleport"}',
    });
  });

  // ADR 0011: a failure is DATA folded into Model, so the widened arm has to
  // survive the Store like every other byte of the slice — a tag that does not
  // round-trip is a tag a resumed run cannot branch on.
  it("the structured outcome survives a Store save/load unchanged", async () => {
    const { held, records } = await lastConversationState([ASK_BADLY, ANSWER]);
    expect(records.length).toBe(2);

    const store = memoryStore<DefinedAgentState<typeof search>>();
    // Through the wire a Store is: serialize, keep, hand back, migrate.
    await store.save(JSON.parse(JSON.stringify(held)));
    const loaded = store.migrate(await store.load());

    expect(loaded?.conversation?.toolRecords).toEqual(records);
  });
});

describe("onToolError — the lid's typed failure seam (#115)", () => {
  type Seen = {
    readonly outcome: { readonly _tag: string; readonly reason: string };
    readonly name: string;
    readonly callId: string;
  };

  /** Drive the two-failure turn, collecting what the hook was handed. */
  async function collectFailures(
    hook: (seen: Seen) => void = () => {},
    turns: readonly AgentTurn[] = [ASK_BADLY, ANSWER],
  ) {
    const { model } = scripted(turns);
    const seen: Seen[] = [];
    const final = await defineAgent({
      model,
      tools: [search],
      instructions: INSTRUCTIONS,
      onToolError: (outcome, ctx) => {
        const entry = { outcome, name: ctx.name, callId: ctx.callId };
        seen.push(entry);
        hook(entry);
      },
    }).run(INPUT, { ctx: { kb } });
    return { final, seen };
  }

  it("fires once per failed call, with the tag, the payload and the call it belongs to", async () => {
    const { final, seen } = await collectFailures();

    expect(seen.map((s) => s.callId)).toEqual(["c1", "c2"]);
    expect(seen[0]).toEqual({
      callId: "c1",
      name: "search",
      outcome: {
        kind: "error",
        _tag: "not_found",
        q: "nope",
        reason: 'not_found {"q":"nope"}',
      },
    });
    // A rejection names the tool the MODEL asked for, not the router's own Cmd.
    expect(seen[1]?.name).toBe("teleport");
    expect(seen[1]?.outcome._tag).toBe("unknown_tool");
    expect(final.run.phase).toBe("done");
  });

  it("is silent on a successful call", async () => {
    const { final, seen } = await collectFailures(() => {}, [ASK, ANSWER]);
    expect(seen).toEqual([]);
    expect(final.output).toEqual(ANSWER);
  });

  it("wiring it changes nothing about the Model the run reaches", async () => {
    const PINNED = {
      ctx: { kb },
      runId: "run-pinned",
      clock: () => 0,
    } as const;
    const hooked = await defineAgent({
      model: scripted([ASK_BADLY, ANSWER]).model,
      tools: [search],
      instructions: INSTRUCTIONS,
      onToolError: () => {},
    }).run(INPUT, PINNED);
    const plain = await defineAgent({
      model: scripted([ASK_BADLY, ANSWER]).model,
      tools: [search],
      instructions: INSTRUCTIONS,
    }).run(INPUT, PINNED);

    expect(hooked.conversation).toEqual(plain.conversation);
  });

  it("a hook that throws is contained: the run still resolves, the throw is warned", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { final, seen } = await collectFailures(() => {
        throw new Error("hook defect");
      });

      // Both failures were still offered, and the run reached its terminal Model.
      expect(seen.map((s) => s.callId)).toEqual(["c1", "c2"]);
      expect(final.run.phase).toBe("done");
      expect(final.output).toEqual(ANSWER);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[0]?.[0]).toMatch(/onToolError hook threw/);
    } finally {
      warn.mockRestore();
    }
  });

  it("a rejected async hook is contained the same way", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { model } = scripted([ASK_BADLY, ANSWER]);
      const final = await defineAgent({
        model,
        tools: [search],
        instructions: INSTRUCTIONS,
        onToolError: async () => {
          await Promise.reject(new Error("async hook defect"));
        },
      }).run(INPUT, { ctx: { kb } });

      expect(final.run.phase).toBe("done");
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("a resumed run does not re-fire it for an outcome already folded", async () => {
    // Run 1 dies with both failures folded and the next brain call outstanding.
    const first = scripted([ASK_BADLY, ANSWER]);
    const handle = run(
      defineAgent({
        model: first.model,
        tools: [search],
        instructions: INSTRUCTIONS,
      }).machine(INPUT),
      { ctx: { kb } },
    );
    const runtime = await handle.ready;
    let snapshot: DefinedAgentState<typeof search> | undefined;
    const off = runtime.observe((_msg, s) => {
      if (
        snapshot === undefined &&
        s.conversation?.awaiting.kind === "llm" &&
        s.conversation.toolRecords.length === 2
      ) {
        snapshot = JSON.parse(JSON.stringify(s));
      }
    });
    await driveToDone(
      handle,
      { type: "agent_start", runId: "run-1", at: 0 },
      (s) => s.run.phase === "done",
    );
    off();
    if (snapshot === undefined) throw new Error("run 1 never folded its tools");

    // Run 2 boots those bytes. The failures are in the Model it was handed, so
    // nothing re-interprets them and the hook has nothing to be told about.
    expect(snapshot.conversation?.toolRecords.length).toBe(2);
    const second = scripted([ANSWER]);
    const seen: string[] = [];
    const final = await defineAgent({
      model: second.model,
      tools: [search],
      instructions: INSTRUCTIONS,
      onToolError: (_outcome, ctx) => {
        seen.push(ctx.callId);
      },
    }).run(INPUT, { ctx: { kb }, store: memoryStore(snapshot) });

    expect(final.run.phase).toBe("done");
    expect(seen).toEqual([]);
    // …and the failures were still in the prompt run 2 sent: folded, not lost.
    expect(
      second.seen[0]?.filter((m) => m.role === "tool").map((m) => m.callId),
    ).toEqual(["c1", "c2"]);
  });
});

// ---------------------------------------------------------------------------
// #136 — `.with({ interpret })`: the ramp between the lid's three intents and
// `createAgent`'s fourteen fields. One wrap point over the machine `defineAgent`
// built, so a single unusual requirement costs one cell rather than the whole
// wiring. The assertions are the ones the door has to keep: the named cell is
// wrapped and no other is, the wrapped cell still settles through the same
// typed Cmd→Msg edge (so a replay of a wrapped run is the unwrapped run's),
// wrapping is composable in a stated order, and the agent it was called on is
// unchanged.
// ---------------------------------------------------------------------------

/** Wrap a cell so it records that it ran, and forward the edge untouched. */
function tracing(trace: string[], label: string) {
  return <C extends (...args: never[]) => Promise<unknown>>(next: C): C =>
    (async (...args: Parameters<C>) => {
      trace.push(label);
      return next(...(args as never[]));
    }) as C;
}

describe("defineAgent(...).with — the one wrap point over the built machine", () => {
  it("wraps the cell it names and carries every other one over by reference", () => {
    const { model } = scripted([ASK, ANSWER]);
    const agent = defineAgent({
      model,
      tools: [search],
      instructions: INSTRUCTIONS,
    });
    const plain = agent.machine(INPUT).interpret;
    const wrapped = agent
      .with({ interpret: { search: tracing([], "search") } })
      .machine(INPUT).interpret;

    expect(Object.keys(wrapped).sort()).toEqual(Object.keys(plain).sort());
    expect(wrapped.search).not.toBe(plain.search);
    // The router's cells are minted once per agent, so an unnamed one is
    // literally the same function — reference equality is the claim, not a
    // behavioural stand-in for it. (The brain cell is minted per `machine`
    // call, so identity says nothing there; the replay test below covers it.)
    expect(wrapped.tool_rejected).toBe(plain.tool_rejected);
  });

  it("the wrapped cell settles through the same edge, so a replay reproduces the Model", async () => {
    const trace: string[] = [];
    const { model } = scripted([ASK, ANSWER]);
    const agent = defineAgent({
      model,
      tools: [search],
      instructions: INSTRUCTIONS,
    }).with({ interpret: { search: tracing(trace, "search") } });

    const machine = agent.machine(INPUT);
    const journal = memoryJournal<LidMsg>();
    const handle = run(machine, { ctx: { kb } });
    const runtime = await handle.ready;
    const off = runtime.observe((msg) => {
      void journal.append("run-1", msg);
    });
    const live = await driveToDone(
      handle,
      { type: "agent_start", runId: "run-1", at: 0 },
      (s) => s.run.phase === "done",
    );
    off();

    expect(trace).toEqual(["search"]);
    expect(live.run.phase).toBe("done");
    // The wrapper returned `next`'s Msg, so the journal holds the tool's own
    // `search_ok` and re-folding it purely lands on the same Model.
    const msgs = (await journal.list("run-1")).map((e) => e.record);
    expect(msgs.map((m) => m.type)).toContain("search_ok");
    const { state } = replay(machine, { msgs, ctx: { kb } });
    expect(state.conversation).toEqual(live.conversation);
    expect(state.output).toEqual(live.output);

    // …and it is the UNWRAPPED run's Model too: the wrap is over the effect
    // boundary, never over the fold.
    const bare = scripted([ASK, ANSWER]);
    const unwrapped = await defineAgent({
      model: bare.model,
      tools: [search],
      instructions: INSTRUCTIONS,
    }).run(INPUT, { ctx: { kb }, runId: "run-1", clock: () => 0 });
    const durable = (s: DefinedAgentState<typeof search>) =>
      JSON.parse(
        JSON.stringify({ ...s, run: { ...s.run, lastProgressAt: 0 } }),
      );
    expect(durable(live)).toEqual(durable(unwrapped));
  });

  it("composes — the later with is the outer wrapper, and the agent it wrapped is untouched", async () => {
    const trace: string[] = [];
    const { model } = scripted([ASK, ANSWER]);
    const agent = defineAgent({
      model,
      tools: [search],
      instructions: INSTRUCTIONS,
    });
    const inner = agent.with({
      interpret: { search: tracing(trace, "inner") },
    });
    const outer = inner.with({
      interpret: { search: tracing(trace, "outer") },
    });

    await outer.run(INPUT, { ctx: { kb } });
    expect(trace).toEqual(["outer", "inner"]);

    // The agent `with` was called on runs its own cells: `defineAgent` returns
    // a value, and `with` derives a new one rather than mutating it.
    trace.length = 0;
    const again = scripted([ASK, ANSWER]);
    await defineAgent({
      model: again.model,
      tools: [search],
      instructions: INSTRUCTIONS,
    }).run(INPUT, { ctx: { kb } });
    expect(trace).toEqual([]);
  });

  it("throws when it names a cell the machine has none of", () => {
    const { model } = scripted([ASK, ANSWER]);
    const agent = defineAgent({
      model,
      tools: [search],
      instructions: INSTRUCTIONS,
    }).with({
      interpret: {
        // A name no tool declares — reachable from untyped/wire config, and the
        // silent alternative is a wrapper nobody ever calls.
        serach: tracing([], "typo"),
      } as never,
    });

    expect(() => agent.machine(INPUT)).toThrow(/serach/);
  });
});

// ---------------------------------------------------------------------------
// #146 — the brain-call retry knob on the lid. Two claims live in-process: a
// declared policy carries a run past a model that throws once, and an omitted
// one leaves the old behaviour untouched — one throw, one attempt, terminal.
// The durability half cannot be proved in-process and is
// `./brain-retry-kill.test.ts`.
// ---------------------------------------------------------------------------

/** No jitter and a 1ms base, so the ladder's wait costs the test nothing. */
const BRAIN_RETRY = {
  baseMs: 1,
  factor: 1,
  capMs: 1,
  maxAttempts: 3,
  jitter: "none" as const,
};

/** A model that throws for its first `failures` calls, then answers. */
function flakyModel(failures: number) {
  let calls = 0;
  const model = async (_messages: readonly AgentMessage[]) => {
    calls += 1;
    if (calls <= failures) throw new Error("429 from the provider");
    return ANSWER;
  };
  return { model, calls: () => calls };
}

describe("defineAgent — the brain-call retry knob (#146)", () => {
  it("a model that throws once and then succeeds completes the run", async () => {
    const brain = flakyModel(1);
    const final = await defineAgent({
      model: brain.model,
      tools: [search],
      instructions: INSTRUCTIONS,
      retry: BRAIN_RETRY,
    }).run(INPUT, { ctx: { kb }, store: memoryStore() });

    expect(final.run.phase).toBe("done");
    expect(final.output).toEqual(ANSWER);
    // The second attempt is what finished it: the ladder retried rather than
    // the model having been lucky.
    expect(brain.calls()).toBe(2);
  });

  it("omitting it keeps today's behaviour: one throw is terminal after one attempt", async () => {
    const brain = flakyModel(1);
    const failed = await defineAgent({
      model: brain.model,
      tools: [search],
      instructions: INSTRUCTIONS,
    })
      .run(INPUT, { ctx: { kb } })
      .catch((e: unknown) => e);

    expect(failed).toBeInstanceOf(DriveFailedError);
    // No policy is defaulted in on the caller's behalf, so the model was never
    // called a second time.
    expect(brain.calls()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// #149 — the two lid knobs the appliance was missing: `compaction`, which
// bounds a long run's transcript, and `toolConcurrency`, which says how many of
// one turn's tool calls a transition LAUNCHES. Both were reachable only by
// dropping to `createAgent`.
// ---------------------------------------------------------------------------

const ASK_2: AgentTurn = {
  content: "one more look",
  toolCalls: [{ callId: "c2", name: "search", args: { q: "tea" } }],
};

const ASK_3: AgentTurn = {
  content: "and one more",
  toolCalls: [{ callId: "c3", name: "search", args: { q: "tea" } }],
};

/**
 * A model that answers the summarize round-trip and the brain call from the
 * same function, exactly as a real `defineAgent` model does. The two are told
 * apart by the system message: the lid sends the summarize call its own
 * instruction, never the agent's.
 */
function compactableModel(turns: readonly AgentTurn[]) {
  const brainPrompts: (readonly AgentMessage[])[] = [];
  let summaries = 0;
  let i = 0;
  const model = async (
    messages: readonly AgentMessage[],
  ): Promise<AgentTurn> => {
    const head = messages[0];
    const isBrain =
      head !== undefined &&
      head.role === "system" &&
      head.content === INSTRUCTIONS;
    if (!isBrain) {
      summaries += 1;
      return { content: "SUMMARY", toolCalls: [] };
    }
    brainPrompts.push(messages);
    const turn = turns[i] ?? ANSWER;
    i += 1;
    return turn;
  };
  return { model, brainPrompts, summaries: () => summaries };
}

describe("defineAgent — the compaction knob (#149)", () => {
  it("a run past the threshold folds its oldest turns into one summary", async () => {
    const brain = compactableModel([ASK, ASK_2, ANSWER]);
    const final = await defineAgent({
      model: brain.model,
      tools: [search],
      instructions: INSTRUCTIONS,
      compaction: { afterTurns: 2 },
    }).run(INPUT, { ctx: { kb }, store: memoryStore() });

    expect(final.run.phase).toBe("done");
    // The fold actually ran, through the agent's own model.
    expect(brain.summaries()).toBe(1);
    // The third brain call reads the summary in place of the two turns and
    // their tool records — the transcript shrank rather than grew.
    expect(brain.brainPrompts[2]).toEqual([
      { role: "system", content: INSTRUCTIONS },
      { role: "user", content: INPUT },
      { role: "assistant", content: "SUMMARY", toolCalls: [] },
    ]);
    // The dedicated compaction slice settled clean.
    expect(final.compaction.retry).toEqual({});
  });

  it("the same run without the knob grows the prompt instead", async () => {
    const brain = compactableModel([ASK, ASK_2, ANSWER]);
    const final = await defineAgent({
      model: brain.model,
      tools: [search],
      instructions: INSTRUCTIONS,
    }).run(INPUT, { ctx: { kb }, store: memoryStore() });

    expect(final.run.phase).toBe("done");
    // No policy is defaulted in on the caller's behalf.
    expect(brain.summaries()).toBe(0);
    // Both turns and both tool outcomes are still in the third prompt: 2 head
    // messages + 2 × (assistant + tool).
    expect(brain.brainPrompts[2]).toHaveLength(6);
  });

  it("a conversation below the threshold is left exactly as it was", async () => {
    const brain = compactableModel([ASK, ANSWER]);
    const final = await defineAgent({
      model: brain.model,
      tools: [search],
      instructions: INSTRUCTIONS,
      compaction: { afterTurns: 5 },
    }).run(INPUT, { ctx: { kb }, store: memoryStore() });

    expect(final.run.phase).toBe("done");
    expect(brain.summaries()).toBe(0);
    expect(brain.brainPrompts[1]).toHaveLength(4);
  });

  it("keepTurns leaves that many newest turns beside the summary", async () => {
    const brain = compactableModel([ASK, ASK_2, ASK_3, ANSWER]);
    await defineAgent({
      model: brain.model,
      tools: [search],
      instructions: INSTRUCTIONS,
      compaction: { afterTurns: 3, keepTurns: 1 },
    }).run(INPUT, { ctx: { kb }, store: memoryStore() });

    expect(brain.summaries()).toBe(1);
    // The summary, then the ONE kept turn with its tool outcome.
    expect(brain.brainPrompts[3]).toEqual([
      { role: "system", content: INSTRUCTIONS },
      { role: "user", content: INPUT },
      { role: "assistant", content: "SUMMARY", toolCalls: [] },
      { role: "assistant", content: ASK_3.content, toolCalls: ASK_3.toolCalls },
      {
        role: "tool",
        callId: "c3",
        name: "search",
        outcome: {
          kind: "ok",
          result: { snippet: "TEA folds the loop in one reducer." },
        },
      },
    ]);
  });

  it("a fold of fewer than two turns is skipped — the core's own no-gain rule", async () => {
    const brain = compactableModel([ASK, ASK_2, ANSWER]);
    await defineAgent({
      model: brain.model,
      tools: [search],
      instructions: INSTRUCTIONS,
      // Two turns, one kept → one turn to fold, which cannot shrink anything.
      compaction: { afterTurns: 2, keepTurns: 1 },
    }).run(INPUT, { ctx: { kb }, store: memoryStore() });

    expect(brain.summaries()).toBe(0);
    expect(brain.brainPrompts[2]).toHaveLength(6);
  });
});

// A tool that records when it starts and when it ends, so two calls in one turn
// either interleave or do not.
const slow = tool(
  "slow",
  {
    description: "Take a while.",
    input: z.object({ id: z.string() }),
    ok: z.object({ id: z.string() }),
    err: ["never"],
    needs: Cmd.needs<{
      readonly log: string[];
      // Per-call durations, so a test can make the SECOND call finish first and
      // ask what that does to the fold.
      readonly delayMs?: Readonly<Record<string, number>>;
    }>(),
  },
  async ({ id }, ctx, { ok }) => {
    ctx.log.push(`start:${id}`);
    await new Promise((r) => setTimeout(r, ctx.delayMs?.[id] ?? 20));
    ctx.log.push(`end:${id}`);
    return ok({ id });
  },
);

/** The Msg union the two-`slow`-calls machine folds — `LidMsg`'s sibling. */
type SlowMsg =
  | AgentMachineMsg<"act", { act: AgentTurn }, { id: string }>
  | WiredToolMsg<typeof slow>;

const TWO_SLOW: AgentTurn = {
  content: "both, please",
  toolCalls: [
    { callId: "a", name: "slow", args: { id: "a" } },
    { callId: "b", name: "slow", args: { id: "b" } },
  ],
};

/**
 * Drive one turn asking for two `slow` calls at the given concurrency, watching
 * the fan-out ledger and the Msg log as it goes.
 *
 * Two things are observable here and they answer two different questions. The
 * LEDGER (`running` vs `pending`) says how many calls the transition launched —
 * that has always been the knob's meaning. The `log` the tool writes says
 * whether they overlapped on the clock, which is what ADR 0018's option (c)
 * added. The `msgs` are the third: the order the settles actually folded in.
 */
async function twoSlowCalls(
  concurrency: number | undefined,
  delayMs?: Readonly<Record<string, number>>,
) {
  const log: string[] = [];
  const msgs: SlowMsg[] = [];
  const { model, seen } = scripted([TWO_SLOW, ANSWER]);
  const agent = defineAgent({
    model,
    tools: [slow],
    instructions: INSTRUCTIONS,
    ...(concurrency === undefined ? {} : { toolConcurrency: concurrency }),
  });
  const machine = agent.machine(INPUT);
  const ctx = { log, ...(delayMs === undefined ? {} : { delayMs }) };
  let maxRunning = 0;
  let everPending = false;
  const runtime = await run(machine, { ctx }).ready;
  const off = runtime.observe((m, s) => {
    msgs.push(m);
    maxRunning = Math.max(maxRunning, s.tools.running.length);
    everPending ||= s.tools.pending.length > 0;
  });
  await runtime.dispatch({ type: "agent_start", runId: "r", at: 0 });
  await vi.waitFor(() => expect(runtime.getState().run.phase).toBe("done"));
  off();
  const final = runtime.getState();
  await runtime.stop();
  return {
    log,
    msgs,
    seen,
    final,
    machine,
    ledger: { maxRunning, everPending },
  };
}

/** The `callId`s the run's `slow_ok` Msgs settled, in the order they folded. */
const settledIds = (msgs: readonly SlowMsg[]) =>
  msgs.flatMap((m) =>
    m.type === "slow_ok" ? [(m as { cmd: { callId: string } }).cmd.callId] : [],
  );

// ADR 0018's option (c), built: the kernel's `runInterpret` still interprets a
// transition's Cmds one at a time and never interleaves two handlers, and the
// overlap lives inside the tool Cmds' own handlers, which launch and return.
// So the ledger reads as it always did AND the clock finally agrees with it —
// without the fold order moving, which is the half these tests exist to hold.
describe("defineAgent — the toolConcurrency knob (#149, ADR 0018 option (c))", () => {
  it("two slow tools in one turn overlap on the clock when it is set above 1", async () => {
    const { log, ledger } = await twoSlowCalls(2);

    // Both calls are launched by ONE transition: neither waits in `pending`.
    expect(ledger.maxRunning).toBe(2);
    expect(ledger.everPending).toBe(false);
    // The INTERLEAVING itself, not a total duration: `b` had started before `a`
    // finished, which no serial dispatch can produce however fast it is.
    expect(log).toEqual(["start:a", "start:b", "end:a", "end:b"]);
    expect(log.indexOf("start:b")).toBeLessThan(log.indexOf("end:a"));
  });

  it("omitting it keeps them strictly serial: one in flight, the rest pending", async () => {
    const { log, ledger } = await twoSlowCalls(undefined);

    expect(ledger.maxRunning).toBe(1);
    expect(ledger.everPending).toBe(true);
    expect(log).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });

  it("settles fold in Cmd-emission order however the calls finish", async () => {
    // `b` is an order of magnitude faster, so completion order is b-then-a…
    const { log, msgs, seen } = await twoSlowCalls(2, { a: 60, b: 5 });
    expect(log).toEqual(["start:a", "start:b", "end:b", "end:a"]);

    // …and the fold is a-then-b anyway, because that is the order the Cmds were
    // emitted in. This is invariant 2's serializability, and it is the thing
    // overlap was not allowed to spend: a log replayed later folds these two
    // Msgs in this order or it is not the same run.
    expect(settledIds(msgs)).toEqual(["a", "b"]);
    // And the prompt the model reads next turn carries that order too — the
    // tool messages are rendered from the settle-ordered records, so a fold in
    // completion order would show the model its two tools the other way round.
    const next = seen.at(1) ?? [];
    expect(next.flatMap((m) => (m.role === "tool" ? [m.callId] : []))).toEqual([
      "a",
      "b",
    ]);
  });

  it("a replay of a fanned run reproduces the same Model", async () => {
    const { msgs, final, machine } = await twoSlowCalls(2, { a: 60, b: 5 });

    // Pure re-fold of exactly what the fanned run folded, no effects run.
    const { state } = replay(machine, { msgs, ctx: { log: [] } });
    expect(state).toEqual(final);
  });

  it("omitting it keeps today's serial dispatch", async () => {
    const log: string[] = [];
    const { model } = scripted([TWO_SLOW, ANSWER]);
    const final = await defineAgent({
      model,
      tools: [slow],
      instructions: INSTRUCTIONS,
    }).run(INPUT, { ctx: { log } });

    expect(final.run.phase).toBe("done");
    expect(log).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });
});

describe("defineAgent — the knobs leave the durable Model's shape alone (#149)", () => {
  it("an agent with both set has the same slice keys as a hand-wired createAgent", async () => {
    const brain = compactableModel([ASK, ASK_2, ANSWER]);
    const final = await defineAgent({
      model: brain.model,
      tools: [search],
      instructions: INSTRUCTIONS,
      compaction: { afterTurns: 2 },
      toolConcurrency: 4,
    }).run(INPUT, { ctx: { kb } });

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
      model: brain.model,
      toolOf: tools.toolOf,
      instructions: INSTRUCTIONS,
    });
    const keys = (s: object) => Object.keys(s).sort();
    expect(keys(final)).toEqual(keys(handWired.init()));
    expect(JSON.parse(JSON.stringify(final))).toEqual(final);
  });
});

// ---------------------------------------------------------------------------
// #153 — the two stop conditions the lid grew beside `maxTurns` / `deadlineMs`:
// `maxElapsedMs`, a total wall-clock cap that never restarts, and `stopWhen`, a
// predicate consulted at the turn boundary. Neither is Model: both are config
// this boot passed, read in the pure reducer off numbers already on the Model.
// ---------------------------------------------------------------------------

describe("maxElapsedMs / stopWhen — the lid's other two stop conditions (#153)", () => {
  type S = DefinedAgentState<typeof search>;

  /** A model that never stops asking, so only a guard can end the run. */
  function asking() {
    const seen: (readonly AgentMessage[])[] = [];
    const model = async (messages: readonly AgentMessage[]) => {
      seen.push(messages);
      return ASK;
    };
    return { model, seen };
  }

  it("maxElapsedMs ends an otherwise-unbounded run with elapsed_limit", async () => {
    const { model, seen } = asking();
    const failed = await defineAgent({
      model,
      tools: [search],
      instructions: INSTRUCTIONS,
      maxElapsedMs: 30,
    })
      .run(INPUT, { ctx: { kb } })
      .catch((e) => e);

    expect(failed).toBeInstanceOf(DriveFailedError);
    const state = (failed as DriveFailedError<S>).state;
    expect(state.failure?.reason).toBe("elapsed_limit");
    // It got there by running, not by refusing to start.
    expect(seen.length).toBeGreaterThan(0);
  });

  it("stopWhen ends the run cancelled — it resolves, and the model is not called again", async () => {
    const { model, seen } = asking();
    const final = await defineAgent({
      model,
      tools: [search],
      instructions: INSTRUCTIONS,
      stopWhen: (state) => (state.conversation?.turnCount ?? 0) >= 2,
    }).run(INPUT, { ctx: { kb } });

    // Two turns went out, the predicate answered `true` on the second boundary,
    // and no third call was made — a cancelled run, not a failed one.
    expect(seen).toHaveLength(2);
    expect(status(final).kind).toBe("cancelled");
    expect(final.failure).toBeNull();
    expect(final.conversation?.turnCount).toBe(2);
  });

  it("a resumed run is governed by the stopWhen THIS boot passed, model uncalled", async () => {
    // Run 1 parks a Model awaiting its tool, then ends on its turn cap.
    const first = asking();
    const live = memoryStore<S>();
    let parked: S | undefined;
    const store: Store<S> = {
      ...live,
      save: async (state) => {
        await live.save(state);
        if (
          parked === undefined &&
          state.conversation?.awaiting.kind === "tools"
        ) {
          parked = JSON.parse(JSON.stringify(state)) as S;
        }
      },
    };
    await defineAgent({
      model: first.model,
      tools: [search],
      instructions: INSTRUCTIONS,
      maxTurns: 1,
    })
      .run(INPUT, { ctx: { kb }, store, runId: "run-1" })
      .catch(() => undefined);
    if (parked === undefined) throw new Error("never parked");
    expect(status(parked).kind).toBe("suspended");

    // Run 2 boots those bytes with a predicate the first process never had. The
    // resumed tool settles, the turn folds, and the predicate stops it there —
    // so this process makes no model call at all.
    const second = asking();
    const final = await defineAgent({
      model: second.model,
      tools: [search],
      instructions: INSTRUCTIONS,
      stopWhen: () => true,
    }).run(INPUT, { ctx: { kb }, store: memoryStore(parked), runId: "run-2" });

    expect(second.seen).toEqual([]);
    expect(status(final).kind).toBe("cancelled");
    expect(final.run.phase === "cancelled" && final.run.runId).toBe("run-1");
  });
});
