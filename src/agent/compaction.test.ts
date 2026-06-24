import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Interpret, run } from "../index";
import { bindMachine } from "../testing";
import {
  type AgentCompactErrMsg,
  type AgentCompactOkMsg,
  type AgentCompactRunCmd,
  type AgentLlmOkMsg,
  type AgentMachineMsg,
  type AgentTurn,
  COMPACTION_PURPOSE,
  type CompactionPolicy,
  type CompactionSummary,
  compactionSummarySchema,
  createAgent,
  isCompactionSummary,
  type LlmErr,
  type LlmOk,
  type LlmRunCmd,
  type MonitoredRunCmd,
  type Schema,
  status,
  type ToolCall,
  type ToolRecord,
} from "./index";

// ---------------------------------------------------------------------------
// Fixtures — the same two-stage agent as agent.test.ts, plus a compaction
// policy whose `planCompaction` is a controllable pure heuristic. The summarize
// I/O is the consumer's `compact_run` cell (it owns it, like a tool); these
// tests script its result directly.
// ---------------------------------------------------------------------------

type Stage = "plan" | "act";
type Purpose = "plan_turn" | "act_turn";

interface Outputs extends Record<Purpose, unknown> {
  readonly plan_turn: AgentTurn;
  readonly act_turn: AgentTurn;
}

type Message = { readonly role: string; readonly text: string };

function turnSchema(): Schema<AgentTurn> {
  return {
    parse: (v) => {
      const o = v as AgentTurn;
      if (typeof o?.content !== "string" || !Array.isArray(o?.toolCalls)) {
        throw new Error("not an AgentTurn");
      }
      return o;
    },
  };
}

const schemas = { plan_turn: turnSchema(), act_turn: turnSchema() } as const;

function fakeModel(invoke: () => Promise<unknown>) {
  return () => ({
    withStructuredOutput<T>(_s: Schema<T>) {
      return { invoke: invoke as () => Promise<T> };
    },
  });
}

const STAGES: readonly Stage[] = ["plan", "act"];
const turnOf = (stage: Stage | undefined): Purpose =>
  stage === "act" ? "act_turn" : "plan_turn";

type ToolCmd = { readonly type: "run_tool" } & ToolCall;
const toolOf = (call: ToolCall): ToolCmd => ({ type: "run_tool", ...call });

const rngZero = () => 0;
const retry = {
  baseMs: 100,
  factor: 2,
  capMs: 10_000,
  maxAttempts: 3,
  jitter: "full" as const,
};

const turnWith = (...calls: ToolCall[]): AgentTurn => ({
  content: "thinking",
  toolCalls: calls,
});
const tool = (callId: string, name = "navigate"): ToolCall => ({
  callId,
  name,
  args: {},
});

// A compaction policy whose `planCompaction` returns a fixed N. `payloadOf` is
// optional; when supplied it threads the conversation through the compact call.
function policyFolding(
  n: number,
  over?: Partial<CompactionPolicy<string, Message>>,
): CompactionPolicy<string, Message> {
  return { planCompaction: () => n, ...over };
}

// The agent under test — compaction ON, folding N oldest turns when asked.
function makeCompactingAgent(
  n: number,
  over?: {
    readonly maxTurns?: number;
    readonly policy?: Partial<CompactionPolicy<string, Message>>;
  },
) {
  return createAgent<Stage, Purpose, Outputs, string, ToolCmd, Message>({
    stages: STAGES,
    model: fakeModel(async () => ({ content: "", toolCalls: [] })),
    schemas,
    retry,
    turnOf,
    toolOf,
    rng: rngZero,
    compaction: policyFolding(n, over?.policy),
    ...(over?.maxTurns !== undefined ? { maxTurns: over.maxTurns } : {}),
  });
}

// The brain-call run Cmd the agent emits for a purpose (payloadOf omitted).
const brainRunCmd = (purpose: Purpose): LlmRunCmd<Purpose> => ({
  type: "resilient_run",
  key: purpose,
  input: { purpose, model: null, payload: null },
});

// The compaction run Cmd the agent emits (the re-keyed dedicated discriminant).
const compactRunCmd = (payload: unknown = null): AgentCompactRunCmd => ({
  type: "compact_run",
  key: COMPACTION_PURPOSE,
  input: { purpose: COMPACTION_PURPOSE, model: null, payload },
});

// The re-entered compaction success settle Msg (what the consumer's `compact_run`
// cell returns).
const compactOk = (summary: string): AgentCompactOkMsg => ({
  type: "compact_ok",
  key: COMPACTION_PURPOSE,
  result: {
    key: COMPACTION_PURPOSE,
    purpose: COMPACTION_PURPOSE,
    output: { summary },
  },
  at: 0,
});

// The re-entered brain-call success settle Msg.
const brainOk = (
  purpose: Purpose,
  output: AgentTurn,
): AgentLlmOkMsg<Purpose, Outputs> => ({
  type: "resilient_ok",
  key: purpose,
  result: { key: purpose, purpose, output },
  at: 0,
});

// ---------------------------------------------------------------------------
// 0. The reserved schema + guard (tea owns the $compact output shape).
// ---------------------------------------------------------------------------

describe("compaction — CompactionSummary schema + guard", () => {
  it("isCompactionSummary accepts a { summary: string } and rejects others", () => {
    expect(isCompactionSummary({ summary: "x" })).toBe(true);
    expect(isCompactionSummary({ summary: 1 })).toBe(false);
    expect(isCompactionSummary(null)).toBe(false);
    expect(isCompactionSummary("x")).toBe(false);
  });

  it("compactionSummarySchema.parse narrows or throws", () => {
    expect(compactionSummarySchema.parse({ summary: "ok" })).toEqual({
      summary: "ok",
    });
    expect(() => compactionSummarySchema.parse({})).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 1. Trigger purity — planCompaction is called with the live conversation and
// re-decides identically across replays (no clock / RNG).
// ---------------------------------------------------------------------------

describe("compaction — trigger purity (design D)", () => {
  it("planCompaction sees the live conversation and decides identically each call", () => {
    const seen: Array<{ turns: number; turnCount: number }> = [];
    const agent = makeCompactingAgent(0, {
      policy: {
        planCompaction: (conv) => {
          seen.push({ turns: conv.turns.length, turnCount: conv.turnCount });
          // A pure char/turn heuristic: fold all-but-one once we have >= 3 turns.
          return conv.turns.length >= 3 ? conv.turns.length - 1 : 0;
        },
      },
    });
    // Two tool turns: turnCount reaches 2, turns.length 2 → no fold yet.
    let [s] = agent.start(agent.init(), "r", 0);
    [s] = agent.turn(s, turnWith(tool("a")), 1);
    [s] = agent.toolOk(s, "a", "ra", 2);
    [s] = agent.turn(s, turnWith(tool("b")), 3);
    const [afterB] = agent.toolOk(s, "b", "rb", 4);
    // The trigger consulted the policy at each drained batch with the live conv.
    expect(seen).toEqual([
      { turns: 1, turnCount: 1 },
      { turns: 2, turnCount: 2 },
    ]);
    // turns.length 2 < 3 → no compaction → still awaiting the next brain call.
    expect(afterB.conversation?.awaiting).toEqual({ kind: "llm" });
  });

  it("a pure planCompaction yields an identical N for an identical conversation", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10 }), (n) => {
        const policy = policyFolding(n);
        const [s] = makeCompactingAgent(n).start(
          makeCompactingAgent(n).init(),
          "r",
          0,
        );
        const conv = s.conversation;
        if (conv === null) return true;
        // Same conversation in → same N out, every call.
        expect(policy.planCompaction(conv)).toBe(policy.planCompaction(conv));
        return true;
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// 2. The trigger fires the dedicated compaction round-trip (not a brain call).
// ---------------------------------------------------------------------------

describe("compaction — trigger fires compact_run instead of the brain call", () => {
  it("a drained batch with planCompaction >= 2 emits compact_run + flips awaiting → compacting", () => {
    // Fold 2 once we have >= 2 turns.
    const agent = makeCompactingAgent(0, {
      policy: { planCompaction: (c) => (c.turns.length >= 2 ? 2 : 0) },
    });
    let [s] = agent.start(agent.init(), "r", 0);
    [s] = agent.turn(s, turnWith(tool("a")), 1);
    [s] = agent.toolOk(s, "a", "ra", 2); // turns 1 → no fold
    [s] = agent.turn(s, turnWith(tool("b")), 3);
    const [compacting, cmds] = agent.toolOk(s, "b", "rb", 4); // turns 2 → fold 2

    // Awaiting flips to compacting; the brain call did NOT fire.
    expect(compacting.conversation?.awaiting).toEqual({
      kind: "compacting",
      folding: 2,
    });
    expect(cmds).toEqual([compactRunCmd()]);
    // No brain-call run Cmd in the batch (only the compaction round-trip).
    expect(cmds.filter((c) => c.type === "resilient_run")).toEqual([]);
    // The compaction slice tracks the call running.
    expect(compacting.compaction.calls[COMPACTION_PURPOSE]?.phase).toBe(
      "running",
    );
    // status() reports a compacting run as `running` (no new public kind).
    expect(status(compacting)).toEqual({ kind: "running" });
  });

  it("planCompaction is clamped to turns.length and skips a fold of < 2", () => {
    // A policy asking for a huge N folds only `turns.length`; < 2 turns skips.
    const agent = makeCompactingAgent(0, {
      policy: { planCompaction: () => 999 },
    });
    let [s] = agent.start(agent.init(), "r", 0);
    [s] = agent.turn(s, turnWith(tool("a")), 1);
    const [afterOne, cmds] = agent.toolOk(s, "a", "ra", 2); // turns 1 → skip
    expect(afterOne.conversation?.awaiting).toEqual({ kind: "llm" });
    expect(cmds).toEqual([brainRunCmd("plan_turn")]);
  });

  it("payloadOf threads the conversation + folding count into the compact_run Cmd", () => {
    const agent = makeCompactingAgent(0, {
      policy: {
        planCompaction: (c) => (c.turns.length >= 2 ? 2 : 0),
        payloadOf: (conv, folding) => ({ n: conv.turns.length, folding }),
      },
    });
    let [s] = agent.start(agent.init(), "r", 0);
    [s] = agent.turn(s, turnWith(tool("a")), 1);
    [s] = agent.toolOk(s, "a", "ra", 2);
    [s] = agent.turn(s, turnWith(tool("b")), 3);
    const [, cmds] = agent.toolOk(s, "b", "rb", 4);
    expect(cmds).toEqual([compactRunCmd({ n: 2, folding: 2 })]);
  });
});

// ---------------------------------------------------------------------------
// 3. Fold-back invariant (design A1): after compact_ok, turns shrink by N-1,
// the head is the summary turn, and NO toolRecord.turn < N survives.
// ---------------------------------------------------------------------------

describe("compaction — fold-back invariant (design A1)", () => {
  it("compact_ok replaces the oldest N turns + their records with one summary turn", () => {
    const agent = makeCompactingAgent(0, {
      policy: { planCompaction: (c) => (c.turns.length >= 3 ? 3 : 0) },
    });
    // Accumulate 3 tool turns (turns 0,1,2), each with one tool → 3 records.
    let [s] = agent.start(agent.init(), "r", 0);
    let at = 1;
    for (const id of ["a", "b", "c"]) {
      [s] = agent.turn(s, turnWith(tool(id)), at++);
      [s] = agent.toolOk(s, id, `ok-${id}`, at++);
    }
    // The 3rd drain triggered compaction (turns.length 3 → fold 3).
    expect(s.conversation?.awaiting).toEqual({
      kind: "compacting",
      folding: 3,
    });
    const before = s.conversation;
    if (before === null) throw new Error("expected a conversation");
    expect(before.turns).toHaveLength(3);
    expect(before.toolRecords.map((r) => r.turn)).toEqual([0, 1, 2]);

    // Fold the summary back.
    const [folded, cmds] = agent.compactOk(
      s,
      COMPACTION_PURPOSE,
      compactOk("SUMMARY"),
      99,
    );
    const conv = folded.conversation;
    if (conv === null) throw new Error("expected a conversation");
    // turns shrank by N-1 = 2 (3 → 1), head is the summary turn (no tool calls).
    expect(conv.turns).toHaveLength(1);
    expect(conv.turns).toHaveLength(before.turns.length - (3 - 1));
    expect(conv.turns[0]).toEqual({ content: "SUMMARY", toolCalls: [] });
    // No toolRecord.turn < N survives — all 3 records were folded away.
    expect(conv.toolRecords.every((r) => r.turn >= 0)).toBe(true);
    expect(conv.toolRecords).toEqual([]);
    // awaiting flipped back to llm and the next brain call fired.
    expect(conv.awaiting).toEqual({ kind: "llm" });
    expect(cmds).toEqual([brainRunCmd("plan_turn")]);
    // turnCount is UNCHANGED by compaction (decision C).
    expect(conv.turnCount).toBe(before.turnCount);
  });

  it("a PARTIAL fold drops only the folded records and re-indexes survivors", () => {
    // Fold only the 2 oldest of 4 turns; the 2 newer turns + their records survive.
    const agent = makeCompactingAgent(0, {
      policy: { planCompaction: (c) => (c.turns.length >= 4 ? 2 : 0) },
    });
    let [s] = agent.start(agent.init(), "r", 0);
    let at = 1;
    for (const id of ["a", "b", "c", "d"]) {
      [s] = agent.turn(s, turnWith(tool(id)), at++);
      [s] = agent.toolOk(s, id, `ok-${id}`, at++);
    }
    expect(s.conversation?.awaiting).toEqual({
      kind: "compacting",
      folding: 2,
    });
    const before = s.conversation;
    if (before === null) throw new Error("expected a conversation");
    expect(before.turns).toHaveLength(4);
    expect(before.toolRecords.map((r) => r.turn)).toEqual([0, 1, 2, 3]);

    const [folded] = agent.compactOk(s, COMPACTION_PURPOSE, compactOk("S"), 99);
    const conv = folded.conversation;
    if (conv === null) throw new Error("expected a conversation");
    // 4 turns - (2-1) = 3 turns: [summary, old-turn-2, old-turn-3].
    expect(conv.turns).toHaveLength(3);
    expect(conv.turns[0]).toEqual({ content: "S", toolCalls: [] });
    // No record with turn < 2 survives; survivors re-indexed (2→1, 3→2) so each
    // still equals its producing turn's NEW index in `turns`.
    expect(conv.toolRecords.map((r) => r.turn)).toEqual([1, 2]);
    expect(conv.toolRecords.every((r) => r.turn >= 0)).toBe(true);
    // The survivors' producing turns sit at exactly those indices.
    for (const rec of conv.toolRecords) {
      expect(conv.turns[rec.turn]).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. maxTurns is untouched by compaction (decision C).
// ---------------------------------------------------------------------------

describe("compaction — maxTurns untouched (decision C)", () => {
  it("a run that compacts K times still trips the turn limit only on real turns", () => {
    // maxTurns 5; fold 2 whenever turns >= 2. Each REAL drained batch bumps
    // turnCount; compaction never does. Drive 5 real turns and assert the guard
    // trips at turnCount 5 regardless of the compactions in between.
    const agent = makeCompactingAgent(0, {
      maxTurns: 5,
      policy: { planCompaction: (c) => (c.turns.length >= 2 ? 2 : 0) },
    });
    let [s] = agent.start(agent.init(), "r", 0);
    let at = 1;
    let realTurns = 0;
    while (!agent.isSettled(s)) {
      [s] = agent.turn(s, turnWith(tool(`c${at}`)), at++);
      const running = s.tools.running[0];
      if (running !== undefined) {
        [s] = agent.toolOk(s, running.callId, "ok", at++);
        realTurns += 1;
      }
      // If a compaction fired, resolve it so the loop can continue.
      if (s.conversation?.awaiting.kind === "compacting") {
        [s] = agent.compactOk(s, COMPACTION_PURPOSE, compactOk("sum"), at++);
      }
    }
    // The livelock guard tripped on the 5th REAL turn — compaction did not
    // inflate (or deflate) the count.
    expect(s.failure).toEqual({ reason: "turn_limit", at: expect.any(Number) });
    expect(realTurns).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 5. Off-path (#55 forbidden-cell proof): a { compaction?: never } agent NEVER
// emits a compact_run Cmd, across an arbitrary verb walk.
// ---------------------------------------------------------------------------

describe("compaction — off-path emits no compact_run ever (#55 forbidden cell)", () => {
  it("an agent with no policy never emits a compact_run Cmd", () => {
    const agent = createAgent<
      Stage,
      Purpose,
      Outputs,
      string,
      ToolCmd,
      Message
    >({
      stages: STAGES,
      model: fakeModel(async () => ({ content: "", toolCalls: [] })),
      schemas,
      retry,
      turnOf,
      toolOf,
      rng: rngZero,
      // no `compaction`
    });
    type Action =
      | { kind: "empty_turn" }
      | { kind: "tool_turn" }
      | { kind: "settle" };
    const action = fc.constantFrom<Action>(
      { kind: "empty_turn" },
      { kind: "tool_turn" },
      { kind: "settle" },
    );
    fc.assert(
      fc.property(fc.array(action, { maxLength: 30 }), (actions) => {
        let [s] = agent.start(agent.init(), "r", 0);
        let at = 1;
        for (const a of actions) {
          let cmds: readonly { type: string }[] = [];
          if (a.kind === "empty_turn") {
            [s, cmds] = agent.turn(s, turnWith(), at++);
          } else if (a.kind === "tool_turn") {
            [s, cmds] = agent.turn(s, turnWith(tool(`c${at}`)), at++);
          } else {
            const running = s.tools.running[0];
            if (running === undefined) continue;
            [s, cmds] = agent.toolOk(s, running.callId, "x", at++);
          }
          // The forbidden cell can never fire — no compact_run, ever.
          if (cmds.some((c) => c.type === "compact_run")) return false;
          // And the conversation never enters the compacting state.
          if (s.conversation?.awaiting.kind === "compacting") return false;
        }
        return true;
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// 6. compact_err proceeds without compacting on exhausted retry (errors are
// data — the chosen B1 fork).
// ---------------------------------------------------------------------------

describe("compaction — compact_err proceeds without compacting", () => {
  it("an exhausted-retry compact_err fires the brain call on the un-compacted transcript", () => {
    // No-retry agent so the first compact failure is terminal for the compact
    // slice → proceed without compacting.
    const agent = createAgent<
      Stage,
      Purpose,
      Outputs,
      string,
      ToolCmd,
      Message
    >({
      stages: STAGES,
      model: fakeModel(async () => ({ content: "", toolCalls: [] })),
      schemas,
      turnOf,
      toolOf,
      rng: rngZero,
      compaction: { planCompaction: (c) => (c.turns.length >= 2 ? 2 : 0) },
    });
    let [s] = agent.start(agent.init(), "r", 0);
    [s] = agent.turn(s, turnWith(tool("a")), 1);
    [s] = agent.toolOk(s, "a", "ra", 2);
    [s] = agent.turn(s, turnWith(tool("b")), 3);
    [s] = agent.toolOk(s, "b", "rb", 4); // → compacting
    expect(s.conversation?.awaiting.kind).toBe("compacting");
    const turnsBefore = s.conversation?.turns.length;

    const err: LlmErr<typeof COMPACTION_PURPOSE> = {
      key: COMPACTION_PURPOSE,
      purpose: COMPACTION_PURPOSE,
      reason: "provider 503",
      error: { _tag: "provider_error" },
    };
    const errMsg: AgentCompactErrMsg = {
      type: "compact_err",
      key: COMPACTION_PURPOSE,
      error: err,
      at: 5,
    };
    const [resumed, cmds] = agent.compactErr(s, COMPACTION_PURPOSE, errMsg, 5);
    // Proceed WITHOUT compacting: awaiting flips back to llm, brain call fires,
    // the transcript is UN-changed (not folded).
    expect(resumed.conversation?.awaiting).toEqual({ kind: "llm" });
    expect(resumed.conversation?.turns.length).toBe(turnsBefore);
    expect(cmds).toEqual([brainRunCmd("plan_turn")]);
    // The run is NOT failed — compaction failure is an optimization miss.
    expect(agent.isSettled(resumed)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. Boot reconcile — a compacting run re-fires its compaction round-trip.
// ---------------------------------------------------------------------------

describe("compaction — boot reconcile re-fires the in-flight compaction", () => {
  it("awaiting compacting → boot re-emits the compact_run Cmd", () => {
    const agent = makeCompactingAgent(0, {
      policy: { planCompaction: (c) => (c.turns.length >= 2 ? 2 : 0) },
    });
    let [s] = agent.start(agent.init(), "r", 0);
    [s] = agent.turn(s, turnWith(tool("a")), 1);
    [s] = agent.toolOk(s, "a", "ra", 2);
    [s] = agent.turn(s, turnWith(tool("b")), 3);
    [s] = agent.toolOk(s, "b", "rb", 4); // → compacting
    expect(s.conversation?.awaiting.kind).toBe("compacting");
    const [, cmds] = agent.boot(s, 5000);
    expect(cmds).toEqual([compactRunCmd()]);
  });
});

// ---------------------------------------------------------------------------
// 8. Replay byte-identity with a mid-loop compaction (design D). A recorded Msg
// log including a compaction round-trip replays to byte-identical state.
// ---------------------------------------------------------------------------

describe("compaction — replay byte-identity with a mid-loop compaction", () => {
  const agent = makeCompactingAgent(0, {
    policy: { planCompaction: (c) => (c.turns.length >= 2 ? 2 : 0) },
  });
  // The consumer's compact_run cell returns a fixed summary; the snapshot is OFF
  // (no snapshotEvery), so no snapshot_write cell.
  type M = AgentMachineMsg<Purpose, Outputs, string>;
  const compactInterpret: Interpret<M, AgentCompactRunCmd, object> = {
    compact_run: async () => compactOk("SUM"),
  };
  const machine = agent.toMachine<object>({
    toolInterpret: compactInterpret as Interpret<
      M,
      ToolCmd | AgentCompactRunCmd,
      object
    >,
  });
  const bound = bindMachine(machine, {} as object);

  // A Msg log that drives: plan turn (1 tool) → tool settle → fold (turnCount 1,
  // turns 1, no fold) ; plan turn (1 tool) → tool settle → fold triggers
  // compaction (turns 2 → fold 2) → compact_ok folds back → brain call.
  const msgs: M[] = [
    { type: "agent_start", runId: "r", at: 0 },
    brainOk("plan_turn", turnWith(tool("c1"))),
    { type: "agent_tool_ok", callId: "c1", result: "r1", at: 10 },
    brainOk("plan_turn", turnWith(tool("c2"))),
    { type: "agent_tool_ok", callId: "c2", result: "r2", at: 20 },
    // The 2nd drain fired compaction; resolve it.
    compactOk("SUM"),
  ];

  it("two replays of the same Msg log produce byte-identical state", () => {
    const a = bound.replay({ msgs });
    const b = bound.replay({ msgs });
    expect(a.state).toEqual(b.state);
    // And the state is JSON-stable (durable) — no Error / undefined / closure.
    expect(JSON.parse(JSON.stringify(a.state))).toEqual(a.state);
  });

  it("the replayed state shows the fold-back: one summary head turn", () => {
    const { state } = bound.replay({ msgs });
    const conv = state.conversation;
    if (conv === null) throw new Error("expected a conversation");
    // turns: [summary] (2 folded into 1) + the brain call re-fired afterwards
    // produced no new turn (no resilient_ok for it in the log).
    expect(conv.turns[0]).toEqual({ content: "SUM", toolCalls: [] });
    expect(conv.awaiting).toEqual({ kind: "llm" });
    // No surviving tool record from a folded turn.
    expect(conv.toolRecords).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 9. WIRED machine — the consumer's compact_run cell re-enters through the real
// runtime, driving llm → tool → fold → compact → fold-back → llm end to end.
// ---------------------------------------------------------------------------

describe("compaction — WIRED machine drives a real compaction round-trip", () => {
  type M = AgentMachineMsg<Purpose, Outputs, string>;

  it("the loop compacts mid-run and reaches terminal done with a clean slice", async () => {
    // Script the brain turns: two plan tool-turns (so the 2nd drain triggers a
    // fold), then an empty plan turn (→ act), then an empty act turn (→ done).
    const turns: AgentTurn[] = [
      turnWith(tool("c1")),
      turnWith(tool("c2")),
      turnWith(), // plan loop done → act
      turnWith(), // act loop done → done
    ];
    let invokeIdx = 0;
    const model = fakeModel(async () => {
      const t = turns[invokeIdx] ?? turnWith();
      invokeIdx += 1;
      return t;
    });

    const agent = createAgent<
      Stage,
      Purpose,
      Outputs,
      string,
      ToolCmd,
      Message
    >({
      stages: STAGES,
      model,
      schemas,
      retry,
      turnOf,
      toolOf,
      rng: rngZero,
      compaction: { planCompaction: (c) => (c.turns.length >= 2 ? 2 : 0) },
    });

    let compactRuns = 0;
    const toolInterpret: Interpret<M, ToolCmd | AgentCompactRunCmd, object> = {
      run_tool: async (cmd) => ({
        type: "agent_tool_ok",
        callId: cmd.callId,
        result: `done:${cmd.callId}`,
        at: 0,
      }),
      // The consumer owns the summarize I/O — here a deterministic fake.
      compact_run: async () => {
        compactRuns += 1;
        return compactOk("compacted");
      },
    };

    let resolveDone: () => void = () => {};
    const reachedDone = new Promise<void>((res) => {
      resolveDone = res;
    });
    const machine = agent.toMachine<object>({ toolInterpret });
    const runtime = await run(machine, { ctx: {} as object }).ready;
    const off = runtime.observe((_m, state) => {
      if (state.run.phase === "done" || state.run.phase === "failed") {
        resolveDone();
      }
    });
    await runtime.dispatch({ type: "agent_start", runId: "run-1", at: 0 });
    await reachedDone;
    await runtime.stop();
    off();

    const final = runtime.getState();
    expect(final.run.phase).toBe("done");
    expect(final.failure).toBeNull();
    // A compaction round-trip actually ran mid-loop.
    expect(compactRuns).toBeGreaterThanOrEqual(1);
    // Both retry slices are clean (every brain + compaction call settled).
    expect(final.resilience.retry).toEqual({});
    expect(final.compaction.retry).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Type-level guards (#55 reuse): the compact_run cell is REQUIRED when a policy
// is configured and FORBIDDEN when it is not. These are compile-time assertions.
// ---------------------------------------------------------------------------

describe("compaction — toMachine config-derives the compact_run obligation (#55)", () => {
  it("a no-policy agent forbids a compact_run cell; a policy agent requires it", () => {
    type M = AgentMachineMsg<Purpose, Outputs, string>;

    // OFF: the cell is FORBIDDEN — mentioning compact_run is a type error.
    const off = createAgent<Stage, Purpose, Outputs, string, ToolCmd, Message>({
      stages: STAGES,
      model: fakeModel(async () => ({ content: "", toolCalls: [] })),
      schemas,
      turnOf,
      toolOf,
      rng: rngZero,
    });
    off.toMachine<object>({
      toolInterpret: {
        run_tool: async () => undefined,
        // @ts-expect-error — compact_run is FORBIDDEN with no policy (#55).
        compact_run: async () => compactOk("x"),
      },
    });

    // ON: the cell is REQUIRED — omitting compact_run is a type error.
    const on = makeCompactingAgent(0);
    on.toMachine<object>({
      // @ts-expect-error — compact_run is REQUIRED when a policy is configured (#55).
      toolInterpret: {
        run_tool: async () => undefined,
      } as Interpret<M, ToolCmd, object>,
    });
    // The well-typed ON wiring (supplies compact_run) compiles.
    const okInterpret: Interpret<M, ToolCmd | AgentCompactRunCmd, object> = {
      run_tool: async () => undefined,
      compact_run: async () => compactOk("x"),
    };
    on.toMachine<object>({ toolInterpret: okInterpret });
    expect(true).toBe(true);
  });
});

// A standalone exercise of the exported ToolRecord shape — the turn field is
// part of the public type (#85, A1).
const _sampleRecord: ToolRecord<string> = {
  call: tool("x"),
  outcome: { kind: "ok", result: "r" },
  turn: 0,
};
void _sampleRecord;

// Touch the LlmOk import so the fixture types stay honest.
const _ok: LlmOk<Purpose, Outputs> = {
  key: "plan_turn",
  purpose: "plan_turn",
  output: turnWith(),
};
void _ok;

// Touch CompactionSummary directly.
const _sum: CompactionSummary = { summary: "s" };
void _sum;

// Touch MonitoredRunCmd so a snapshotting consumer's import path is type-checked
// elsewhere; here we only assert the type name resolves.
type _Snap = MonitoredRunCmd<unknown>;
