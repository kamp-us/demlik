import { describe, expect, it } from "vitest";
import { type Interpret, run } from "../index";
import {
  type AgentEvent,
  type AgentMachineMsg,
  type AgentTurn,
  agentEvents,
  createAgent,
  type Schema,
  type ToolCall,
} from "./index";

// ---------------------------------------------------------------------------
// #47 — the SEMANTIC AgentEvent stream + typed `runtime.on` / `onBoot`.
//
// These tests pin the seam that decouples observability from the agent's
// PRIVATE retry/loop Msg vocabulary: a consumer folds `TurnSettled` /
// `ToolSettled` / `RunDone` via `runtime.on`, never `resilient_ok` /
// `agent_tool_ok` off the raw `observe` firehose. The fixtures mirror the WIRED
// machine test in `agent.test.ts`: a two-stage agent driven end-to-end through
// re-entry by a real `run(...)` runtime, with `events: agentEvents()` wired so
// `on` lights up.
// ---------------------------------------------------------------------------

type Stage = "plan" | "act";
type Purpose = "plan_turn" | "act_turn";

interface Outputs extends Record<Purpose, AgentTurn> {
  readonly plan_turn: AgentTurn;
  readonly act_turn: AgentTurn;
}

type ToolCmd = { readonly type: "run_tool" } & ToolCall;
const toolOf = (call: ToolCall): ToolCmd => ({ type: "run_tool", ...call });

const turnSchema = (): Schema<AgentTurn> => ({
  parse: (v) => {
    const o = v as AgentTurn;
    if (typeof o?.content !== "string" || !Array.isArray(o?.toolCalls)) {
      throw new Error("not an AgentTurn");
    }
    return o;
  },
});
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
const tool = (callId: string): ToolCall => ({
  callId,
  name: "navigate",
  args: {},
});

type M = AgentMachineMsg<Purpose, Outputs, string>;

// Build a wired runtime that drives plan(tool c1) → fold → plan(done) → act(done)
// → RunDone, with `agentEvents()` projecting the semantic stream. Returns the
// booted runtime plus the per-callId execution counter.
async function wiredRuntime() {
  // 1) plan #1: a turn with one tool. 2) plan #2: empty → advance to act.
  // 3) act: empty → done.
  const turns: AgentTurn[] = [turnWith(tool("c1")), turnWith(), turnWith()];
  let invokeIdx = 0;
  const model = fakeModel(async () => {
    const t = turns[invokeIdx] ?? turnWith();
    invokeIdx += 1;
    return t;
  });

  const agent = createAgent<Stage, Purpose, Outputs, string, ToolCmd, string>({
    stages: STAGES,
    model,
    schemas,
    retry,
    turnOf,
    toolOf,
    rng: rngZero,
  });

  const toolInterpret: Interpret<M, ToolCmd, object> = {
    run_tool: async (cmd) => ({
      type: "agent_tool_ok",
      callId: cmd.callId,
      result: `done:${cmd.callId}`,
      at: 0,
    }),
  };

  const machine = agent.toMachine<object>({ toolInterpret });
  // `events: agentEvents()` is the wiring that makes `runtime.on(...)` deliver
  // the semantic AgentEvent stream (#47).
  const runtime = await run(machine, {
    ctx: {} as object,
    terminal: (s) => s.run.phase === "done" || s.run.phase === "failed",
    events: agentEvents<Stage, Purpose, Outputs, string>(),
  }).ready;

  return runtime;
}

describe("#47 — runtime.on delivers the semantic AgentEvent stream", () => {
  it("a settled brain turn fires TurnSettled with the AgentTurn", async () => {
    const runtime = await wiredRuntime();
    const turns: AgentTurn[] = [];
    runtime.on("TurnSettled", (e) => {
      turns.push(e.turn);
    });

    await runtime.dispatch({ type: "agent_start", runId: "r", at: 0 });
    await runtime.done();
    await runtime.stop();

    // Three brain turns settled across the run: plan(tool) → plan(done) →
    // act(done). The first carries the tool call.
    expect(turns.length).toBe(3);
    expect(turns[0]).toEqual({ content: "thinking", toolCalls: [tool("c1")] });
    expect(turns[1]).toEqual({ content: "thinking", toolCalls: [] });
    expect(turns[2]).toEqual({ content: "thinking", toolCalls: [] });
  });

  it("a settled tool fires ToolSettled with its callId + result", async () => {
    const runtime = await wiredRuntime();
    const tools: { callId: string; result: string }[] = [];
    runtime.on("ToolSettled", (e) => {
      tools.push({ callId: e.callId, result: e.result });
    });

    await runtime.dispatch({ type: "agent_start", runId: "r", at: 0 });
    await runtime.done();
    await runtime.stop();

    expect(tools).toEqual([{ callId: "c1", result: "done:c1" }]);
  });

  it("run.phase → done fires RunDone exactly once, carrying the output", async () => {
    const runtime = await wiredRuntime();
    const dones: (AgentTurn | null)[] = [];
    runtime.on("RunDone", (e) => {
      dones.push(e.output);
    });

    await runtime.dispatch({ type: "agent_start", runId: "r", at: 0 });
    await runtime.done();
    await runtime.stop();

    // Fires once — the terminal `done` transition. Output is the last (empty)
    // model turn, the same first-class result `Runtime.result()` reads (#46).
    expect(dones.length).toBe(1);
    expect(dones[0]).toEqual({ content: "thinking", toolCalls: [] });
    expect(dones[0]).toEqual(runtime.result()?.output);
  });

  it("on('TurnSettled', …) only receives TurnSettled — typed narrowing", async () => {
    const runtime = await wiredRuntime();
    const seenTypes = new Set<string>();
    // The handler is typed `(e: Extract<AgentEvent, {type:'TurnSettled'}>)`, so
    // `e.turn` is reachable and `e.callId` / `e.output` are NOT on the type. We
    // additionally assert at runtime that no other event leaks into this bucket.
    runtime.on("TurnSettled", (e) => {
      seenTypes.add(e.type);
      // Type-level proof the narrowing holds: `e.turn` is an AgentTurn.
      const _turn: AgentTurn = e.turn;
      void _turn;
      // @ts-expect-error — `callId` is on ToolSettled, NOT the narrowed TurnSettled.
      void e.callId;
    });
    // @ts-expect-error — `resilient_ok` is a PRIVATE Msg name, not an AgentEvent type.
    runtime.on("resilient_ok", () => {});

    await runtime.dispatch({ type: "agent_start", runId: "r", at: 0 });
    await runtime.done();
    await runtime.stop();

    expect([...seenTypes]).toEqual(["TurnSettled"]);
  });

  it("the unsubscribe returned by on(...) detaches the handler", async () => {
    const runtime = await wiredRuntime();
    let count = 0;
    const off = runtime.on("TurnSettled", () => {
      count += 1;
    });
    off();

    await runtime.dispatch({ type: "agent_start", runId: "r", at: 0 });
    await runtime.done();
    await runtime.stop();

    expect(count).toBe(0);
  });
});

describe("#47 — observe drops the boot null arm; onBoot carries it", () => {
  it("observe never delivers null; onBoot delivers the initial state once", async () => {
    const runtime = await wiredRuntime();

    // onBoot already booted (we awaited `.ready`) → fires immediately, exactly
    // once, with the initial State.
    const boots: { phase: string }[] = [];
    runtime.onBoot((s) => {
      boots.push({ phase: s.run.phase });
    });

    // Every observed msg is a real Msg (never null) — the boot arm is gone.
    let nullSeen = false;
    runtime.observe((msg) => {
      // `msg` is typed `M` (no `| null`); this runtime check proves it at
      // runtime too — a private boot-null would trip it.
      if ((msg as unknown) === null) nullSeen = true;
    });

    await runtime.dispatch({ type: "agent_start", runId: "r", at: 0 });
    await runtime.done();
    await runtime.stop();

    expect(boots).toEqual([{ phase: "running" }]);
    expect(nullSeen).toBe(false);
  });

  it("onBoot fires on the boot fanout for a subscriber attached before ready", async () => {
    // Attach onBoot on the BOOTING handle (before boot completes) so it lands
    // on the boot fanout, not the already-booted fast path.
    const turns: AgentTurn[] = [turnWith()];
    let i = 0;
    const model = fakeModel(async () => turns[i++] ?? turnWith());
    const agent = createAgent<Stage, Purpose, Outputs, string, ToolCmd, string>(
      {
        stages: STAGES,
        model,
        schemas,
        retry,
        turnOf,
        toolOf,
        rng: rngZero,
      },
    );
    const bootToolInterpret: Interpret<M, ToolCmd, object> = {
      run_tool: async (cmd) => ({
        type: "agent_tool_ok",
        callId: cmd.callId,
        result: "x",
        at: 0,
      }),
    };
    const machine = agent.toMachine<object>({
      toolInterpret: bootToolInterpret,
    });

    const booting = run(machine, {
      ctx: {} as object,
      events: agentEvents<Stage, Purpose, Outputs, string>(),
    });
    let bootCount = 0;
    booting.onBoot(() => {
      bootCount += 1;
    });

    const runtime = await booting.ready;
    await runtime.stop();

    expect(bootCount).toBe(1);
  });
});

describe("#47 — an `on`-based consumer references no private Msg name", () => {
  it("folds the run into a public summary without naming resilient_ok / agent_tool_ok", async () => {
    const runtime = await wiredRuntime();

    // A consumer built ENTIRELY on the semantic channel. The only strings it
    // ever matches are public AgentEvent types — the private Msg names appear
    // nowhere in this closure (the type system also forbids them: `on`'s key is
    // `AgentEvent["type"]`, which does not include `resilient_ok`).
    const summary: string[] = [];
    const fold = (e: AgentEvent<string>): void => {
      switch (e.type) {
        case "TurnSettled":
          summary.push(`turn:${e.turn.toolCalls.length}`);
          break;
        case "ToolSettled":
          summary.push(`tool:${e.callId}`);
          break;
        case "RunDone":
          summary.push(`done:${e.output ? "turn" : "none"}`);
          break;
      }
    };
    runtime.on("TurnSettled", fold);
    runtime.on("ToolSettled", fold);
    runtime.on("RunDone", fold);

    await runtime.dispatch({ type: "agent_start", runId: "r", at: 0 });
    await runtime.done();
    await runtime.stop();

    // The exact public sequence the run produced, derived without ever touching
    // a private Msg name.
    expect(summary).toEqual([
      "turn:1", // plan #1 — one tool call
      "tool:c1", // the tool settled
      "turn:0", // plan #2 — empty (advance to act)
      "turn:0", // act — empty (finish)
      "done:turn", // run finished with the terminal turn
    ]);

    // Guard the "no private name" claim against drift: this test source must not
    // mention the private Msg names anywhere in the consumer's vocabulary. (The
    // describe title / this assertion's own strings are the only mentions, and
    // they are not `on(...)` keys.)
    const consumerVocab = fold.toString();
    expect(consumerVocab).not.toContain("resilient_ok");
    expect(consumerVocab).not.toContain("agent_tool_ok");
  });
});
