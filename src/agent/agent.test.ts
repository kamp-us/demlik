import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { deadlineSub } from "../deadline";
import { type Interpret, run } from "../index";
import { bindMachine } from "../testing";
import {
  type AgentLlmOkMsg,
  type AgentMachineMsg,
  type AgentTurn,
  createAgent,
  type LlmErr,
  type LlmOk,
  type LlmRunCmd,
  type MonitoredRunCmd,
  type Schema,
  type ToolCall,
} from "./index";

// ---------------------------------------------------------------------------
// Fixtures — a two-stage agent ("plan" → "act") whose brain calls both return
// an AgentTurn. A fake model factory + structural schemas mirror the seed's
// brain-only path; the tool effect is a plain `run_tool` Cmd the consumer's own
// interpret would perform. rng pinned to 0 so retry backoff collapses to 0.
// ---------------------------------------------------------------------------

type Stage = "plan" | "act";
type Purpose = "plan_turn" | "act_turn";

// Both purposes parse to an AgentTurn (the loop folds it).
interface Outputs extends Record<Purpose, unknown> {
  readonly plan_turn: AgentTurn;
  readonly act_turn: AgentTurn;
}

type Message = { readonly role: string; readonly text: string };

// A schema that just narrows to AgentTurn (the model resolves the turn directly).
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

// A fake model factory whose `withStructuredOutput().invoke` resolves to a
// per-test turn (or throws). Used only by the detached-handler tests.
function fakeModel(invoke: () => Promise<unknown>) {
  return () => ({
    withStructuredOutput<T>(_s: Schema<T>) {
      return { invoke: invoke as () => Promise<T> };
    },
  });
}

const STAGES: readonly Stage[] = ["plan", "act"];

// Which brain-call purpose each stage runs.
const turnOf = (stage: Stage | undefined): Purpose =>
  stage === "act" ? "act_turn" : "plan_turn";

// The per-tool effect, as data — the consumer's own interpret performs it. A
// CLOSED discriminated Cmd variant (`ToolCmd`) so the agent's `TC` type param
// stays precise and the wired machine's interpret merge type-checks per key.
type ToolCmd = { readonly type: "run_tool" } & ToolCall;
const toolOf = (call: ToolCall): ToolCmd => ({ type: "run_tool", ...call });

// rng pinned to 0 → "full" jitter delay collapses to 0, so retryAtMs == at.
const rngZero = () => 0;

const retry = {
  baseMs: 100,
  factor: 2,
  capMs: 10_000,
  maxAttempts: 3,
  jitter: "full" as const,
};

// The standard two-stage agent the unit tests reuse. No deadline / turn guard
// unless a test builds its own with those bricks.
function makeAgent(
  over?: Partial<
    Parameters<
      typeof createAgent<Stage, Purpose, Outputs, string, ToolCmd, Message>
    >[0]
  >,
) {
  return createAgent<Stage, Purpose, Outputs, string, ToolCmd, Message>({
    stages: STAGES,
    model: fakeModel(async () => ({ content: "", toolCalls: [] })),
    schemas,
    retry,
    turnOf,
    toolOf,
    rng: rngZero,
    ...over,
  });
}

// A turn with N tool calls.
const turnWith = (...calls: ToolCall[]): AgentTurn => ({
  content: "thinking",
  toolCalls: calls,
});
const tool = (callId: string, name = "navigate"): ToolCall => ({
  callId,
  name,
  args: {},
});

// The brain-call run Cmd the agent emits for a given purpose. payloadOf is omitted
// so payload is null. Typed `LlmRunCmd<Purpose>` (the precise brain Cmd) so the
// literal flows into the closed `AgentCmd<Purpose, ToolCmd>` expectations with no
// widened `type: string`.
const brainRunCmd = (purpose: Purpose): LlmRunCmd<Purpose> => ({
  type: "resilient_run",
  key: purpose,
  input: { purpose, model: null, payload: null },
});

// ---------------------------------------------------------------------------
// init + start
// ---------------------------------------------------------------------------

describe("createAgent — init + start", () => {
  it("init produces every brick's starting slice and no conversation", () => {
    const agent = makeAgent();
    const s = agent.init();
    expect(s.run.phase).toBe("running");
    expect(s.run.runId).toBe("");
    expect(s.resilience.calls).toEqual({});
    expect(s.resilience.circuit).toEqual({ phase: "closed", failures: 0 });
    expect(s.tools).toEqual({
      pending: [],
      running: [],
      done: [],
      failed: [],
      items: [],
      waveDoneFrom: 0,
      waveFailedFrom: 0,
      joined: false,
    });
    expect(s.conversation).toBeNull();
    expect(s.failure).toBeNull();
  });

  it("start seeds the pipeline, a fresh conversation, and fires the first brain call", () => {
    const agent = makeAgent();
    const [s, cmds] = agent.start(agent.init(), "run-1", 0);
    // monitored-run claimed the first stage as the position.
    expect(agent.currentStage(s)).toBe("plan");
    expect(s.run.runId).toBe("run-1");
    // A fresh conversation awaiting the first brain call.
    expect(s.conversation).toEqual({
      turns: [],
      toolRecords: [],
      turnCount: 0,
      awaiting: { kind: "llm" },
    });
    // The brain call for the "plan" stage's purpose.
    expect(cmds).toEqual([brainRunCmd("plan_turn")]);
    // The resilient slice tracks it running.
    expect(s.resilience.calls.plan_turn?.phase).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// turn — the core of the loop (the seed's applyAiTurn, generalized)
// ---------------------------------------------------------------------------

describe("createAgent — turn (empty tool calls → advance the pipeline)", () => {
  it("an empty-tool turn retires the stage and fires the NEXT stage's brain call", () => {
    const agent = makeAgent();
    let [s] = agent.start(agent.init(), "r", 0);
    const [next, cmds] = agent.turn(s, turnWith(), 10);
    s = next;
    // Pipeline advanced plan → act.
    expect(agent.currentStage(s)).toBe("act");
    // Fresh conversation for the new stage.
    expect(s.conversation?.turns).toEqual([]);
    expect(s.conversation?.awaiting).toEqual({ kind: "llm" });
    // The act stage's brain call fired.
    expect(cmds).toEqual([brainRunCmd("act_turn")]);
  });

  it("an empty-tool turn on the LAST stage finishes the run to done, no brain call", () => {
    const agent = makeAgent();
    let [s] = agent.start(agent.init(), "r", 0);
    [s] = agent.turn(s, turnWith(), 10); // plan → act
    const [done, cmds] = agent.turn(s, turnWith(), 20); // act → done
    expect(done.run.phase).toBe("done");
    expect(done.conversation).toBeNull();
    expect(cmds).toEqual([]); // no further brain call
  });
});

describe("createAgent — turn (tool calls → scatter across fan-out)", () => {
  it("scatters tool calls, records the turn, flips awaiting → tools", () => {
    const agent = makeAgent();
    let [s] = agent.start(agent.init(), "r", 0);
    const [next, cmds] = agent.turn(s, turnWith(tool("c1"), tool("c2")), 10);
    s = next;
    // The model turn was recorded.
    expect(s.conversation?.turns).toHaveLength(1);
    expect(s.conversation?.awaiting).toEqual({ kind: "tools", batchTurn: 0 });
    // Serial dispatch (concurrency default 1): exactly ONE tool launched.
    expect(cmds).toEqual([toolOf(tool("c1"))]);
    expect(s.tools.running.map((c) => c.callId)).toEqual(["c1"]);
    expect(s.tools.pending.map((c) => c.callId)).toEqual(["c2"]);
  });

  it("toolConcurrency launches up to N tools at once", () => {
    const agent = makeAgent({ toolConcurrency: 3 });
    let [s] = agent.start(agent.init(), "r", 0);
    const [next, cmds] = agent.turn(
      s,
      turnWith(tool("c1"), tool("c2"), tool("c3")),
      10,
    );
    s = next;
    expect(cmds).toEqual([
      toolOf(tool("c1")),
      toolOf(tool("c2")),
      toolOf(tool("c3")),
    ]);
    expect(s.tools.running).toHaveLength(3);
    expect(s.tools.pending).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// toolOk / toolErr — fold each tool, launch the next, fold → llm on drain
// ---------------------------------------------------------------------------

describe("createAgent — tool settle (serial drain → fold → next brain call)", () => {
  it("settling the in-flight tool launches the next queued tool (serial)", () => {
    const agent = makeAgent();
    let [s] = agent.start(agent.init(), "r", 0);
    [s] = agent.turn(s, turnWith(tool("c1"), tool("c2")), 10);
    const [next, cmds] = agent.toolOk(s, "c1", "ok-1", 20);
    s = next;
    // c1 recorded; c2 launched.
    expect(s.conversation?.toolRecords).toEqual([
      { call: tool("c1"), outcome: { kind: "ok", result: "ok-1" } },
    ]);
    expect(cmds).toEqual([toolOf(tool("c2"))]);
    expect(s.conversation?.awaiting).toEqual({ kind: "tools", batchTurn: 0 });
  });

  it("settling the LAST tool folds the turn, bumps turnCount, fires the next brain call", () => {
    const agent = makeAgent();
    let [s] = agent.start(agent.init(), "r", 0);
    [s] = agent.turn(s, turnWith(tool("c1"), tool("c2")), 10);
    [s] = agent.toolOk(s, "c1", "ok-1", 20);
    const [next, cmds] = agent.toolOk(s, "c2", "ok-2", 30);
    s = next;
    // Both tool outcomes folded onto the conversation.
    expect(s.conversation?.toolRecords).toEqual([
      { call: tool("c1"), outcome: { kind: "ok", result: "ok-1" } },
      { call: tool("c2"), outcome: { kind: "ok", result: "ok-2" } },
    ]);
    // The turn count bumped and awaiting flipped back to llm.
    expect(s.conversation?.turnCount).toBe(1);
    expect(s.conversation?.awaiting).toEqual({ kind: "llm" });
    // The same stage's brain call re-fired (still "plan"; loop continues).
    expect(agent.currentStage(s)).toBe("plan");
    expect(cmds).toEqual([brainRunCmd("plan_turn")]);
    // The tool ledger reset for the next turn's batch.
    expect(s.tools.running).toEqual([]);
  });

  it("a failed tool still counts toward completion (errors are data)", () => {
    const agent = makeAgent();
    let [s] = agent.start(agent.init(), "r", 0);
    [s] = agent.turn(s, turnWith(tool("c1")), 10);
    const [next, cmds] = agent.toolErr(s, "c1", "boom", 20);
    s = next;
    expect(s.conversation?.toolRecords).toEqual([
      { call: tool("c1"), outcome: { kind: "error", reason: "boom" } },
    ]);
    // Single tool batch drained → next brain call fires.
    expect(cmds).toEqual([brainRunCmd("plan_turn")]);
    expect(s.conversation?.turnCount).toBe(1);
  });

  it("a settle for an unknown callId is a no-op", () => {
    const agent = makeAgent();
    let [s] = agent.start(agent.init(), "r", 0);
    [s] = agent.turn(s, turnWith(tool("c1")), 10);
    const [next, cmds] = agent.toolOk(s, "nope", "x", 20);
    expect(next).toBe(s);
    expect(cmds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The full loop, end to end (replay through a runnable machine)
// ---------------------------------------------------------------------------

describe("createAgent — full loop through the wired machine (replay)", () => {
  const agent = makeAgent();
  // The FIXED machine — no `ports`. The brain call is the no-arg llm-call
  // handler; its returned settle Msg re-enters the `resilient_ok` / `resilient_err`
  // arms. These replay tests hand-feed the re-entered settle Msg directly to
  // exercise the reducer arms; the true end-to-end re-entry is the WIRED test
  // below, which runs the real runtime so the handler return drives the loop.
  const machine = agent.toMachine<object>();
  const bound = bindMachine(machine, {} as object);

  // The re-entered brain-call success settle Msg (what `brainHandlers` returns).
  const ok = (
    purpose: Purpose,
    output: AgentTurn,
  ): AgentLlmOkMsg<Purpose, Outputs> => ({
    type: "resilient_ok",
    key: purpose,
    result: { key: purpose, purpose, output },
    at: 0,
  });

  it("start fires the plan brain call through the reducer", () => {
    bound.expectCmdSequence(
      { msgs: [{ type: "agent_start", runId: "r", at: 0 }] },
      [brainRunCmd("plan_turn")],
    );
  });

  it("plan turn with a tool → tool settle → fold → next plan brain call", () => {
    const { state, cmds } = bound.replay({
      msgs: [
        { type: "agent_start", runId: "r", at: 0 },
        // The brain-call success re-enters — `succeed` resets retry AND folds the
        // parsed turn (one tool) in ONE Msg.
        ok("plan_turn", turnWith(tool("c1"))),
        // The tool resolves.
        { type: "agent_tool_ok", callId: "c1", result: "r1", at: 20 },
      ],
    });
    // After the batch drained the loop re-fired the SAME stage's brain call.
    expect(agent.currentStage(state)).toBe("plan");
    expect(state.conversation?.turnCount).toBe(1);
    // The retry slice reset on the success — clean across the run.
    expect(state.resilience.retry).toEqual({});
    // Cmds across the run: plan call, tool launch, next plan call.
    expect(cmds).toEqual([
      brainRunCmd("plan_turn"),
      toolOf(tool("c1")),
      brainRunCmd("plan_turn"),
    ]);
  });

  it("an empty-tool turn on each stage walks plan → act → done", () => {
    const { state } = bound.replay({
      msgs: [
        { type: "agent_start", runId: "r", at: 0 },
        ok("plan_turn", turnWith()), // plan done → act (re-entered settle)
        ok("act_turn", turnWith()), // act done → done
      ],
    });
    expect(state.run.phase).toBe("done");
    expect(state.conversation).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// THE WIRED MACHINE — a real `run(...)` runtime driving the full multi-turn
// loop end to end through RE-ENTRY (the missing test class). The brain handler's
// returned settle Msg re-enters the reducer; the consumer's tool interpret
// dispatches `agent_tool_ok` back. No intermediate Msg is hand-fed past the
// initial `agent_start` — the runtime drives llm -> tool -> fold -> llm -> done
// itself. We assert the END STATE, not the intermediate Msgs.
//
// This fails against the pre-fix code: the old detached handler dispatched
// `agent_turn` (never re-entering `resilient_ok`), so `succeed` never ran — the
// resilient slice stayed stuck `running`, the retry counter never reset, and a
// duplicate `callId` double-executed the tool.
// ---------------------------------------------------------------------------

describe("createAgent — WIRED machine drives the full loop to terminal done", () => {
  type M = AgentMachineMsg<Purpose, Outputs, string>;

  it("llm -> tool -> fold -> llm -> done: terminal, clean retry slice, each callId once", async () => {
    // Per-callId execution counter — proves no double-execution.
    const execCount = new Map<string, number>();
    // Script the brain calls in order: the model is invoked once per brain call.
    // 1) plan #1: a turn with a tool — and a DUPLICATE callId, proving dedup.
    // 2) plan #2: empty turn → advance plan → act.
    // 3) act    : empty turn → finish to done.
    const turns: AgentTurn[] = [
      turnWith(tool("c1"), tool("c1")), // duplicate callId in one turn
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
    >({ stages: STAGES, model, schemas, retry, turnOf, toolOf, rng: rngZero });

    // A latch that resolves the moment the run reaches a terminal state, so the
    // test waits on the END STATE rather than a fixed Msg count.
    let resolveDone: () => void = () => {};
    const reachedDone = new Promise<void>((res) => {
      resolveDone = res;
    });

    // The consumer's interpret for the non-brain Cmds. `run_tool` (the precise
    // `ToolCmd` `toolOf` produces) counts the execution and routes the result
    // back into the loop as a follow-up Msg (re-entry). The closed `ToolCmd`
    // type means `cmd.callId` is reachable with NO cast — the precise `TC` param
    // flows the discriminated shape straight into the cell. (No `snapshot_write`
    // here: this agent sets no `snapshotEvery`, so that Cmd is never emitted.)
    const toolInterpret: Interpret<
      M,
      MonitoredRunCmd<unknown> | ToolCmd,
      object
    > = {
      run_tool: async (cmd) => {
        execCount.set(cmd.callId, (execCount.get(cmd.callId) ?? 0) + 1);
        // Re-enter: settle the tool back into the loop as a FOLLOW-UP Msg
        // (returned, not awaited — awaiting `dispatch` here would deadlock the
        // serial tail, since the current step holds it).
        return {
          type: "agent_tool_ok",
          callId: cmd.callId,
          result: `done:${cmd.callId}`,
          at: 0,
        };
      },
      snapshot_write: async () => {},
    };

    const machine = agent.toMachine<object>({ toolInterpret });
    const runtime = run(machine, { ctx: {} as object });

    // Stop driving once the run is terminal.
    const off = runtime.observe((_msg, state) => {
      if (state.run.phase === "done" || state.run.phase === "failed") {
        resolveDone();
      }
    });

    await runtime.ready;
    await runtime.dispatch({ type: "agent_start", runId: "run-1", at: 0 });
    await reachedDone;
    // Drain the tail so the final transition's effects all settle.
    await runtime.stop();
    off();

    const final = runtime.getState();
    // END STATE — the loop reached terminal done (not stuck `running`).
    expect(final.run.phase).toBe("done");
    expect(final.conversation).toBeNull();
    expect(final.failure).toBeNull();
    // Clean retry slice — `succeed` ran on every brain call and dropped the key.
    expect(final.resilience.retry).toEqual({});
    // The brain calls all settled; none is left stuck `running`.
    for (const phase of Object.values(final.resilience.calls)) {
      expect(phase.phase).toBe("succeeded");
    }
    // Each tool callId executed EXACTLY once — the duplicate `c1` did NOT
    // double-run (dedup by callId).
    expect(execCount.get("c1")).toBe(1);
    expect([...execCount.keys()]).toEqual(["c1"]);
  });
});

// ---------------------------------------------------------------------------
// Livelock guard (turn limit) + deadline watchdog
// ---------------------------------------------------------------------------

describe("createAgent — guards", () => {
  it("the turn limit fails the run when turnCount crosses maxTurns", () => {
    const agent = makeAgent({ maxTurns: 1 });
    let [s] = agent.start(agent.init(), "r", 0);
    [s] = agent.turn(s, turnWith(tool("c1")), 10);
    // Draining the single-tool batch bumps turnCount to 1 == maxTurns → fail.
    const [failed, cmds] = agent.toolOk(s, "c1", "x", 20);
    expect(failed.failure).toEqual({ reason: "turn_limit", at: 20 });
    expect(agent.isSettled(failed)).toBe(true);
    expect(cmds).toEqual([]); // no further brain call
  });

  it("the safety deadline arms while running and fails the run when it fires", () => {
    const agent = makeAgent({ deadlineMs: 1000 });
    const [s] = agent.start(agent.init(), "r", 100);
    // A monitored-run safety deadline is desired at lastProgressAt + deadlineMs.
    const safety = agent
      .subs(s)
      .find((sub) => sub.id.startsWith("monitored:safety:"));
    expect(safety).toBeDefined();
    // Firing the matching timer fails the run.
    const [failed] = agent.onTimer(s, {
      type: "deadline_exceeded",
      id: safety?.id ?? "",
      atMs: 2000,
    });
    expect(failed.run.phase).toBe("failed");
    expect(failed.run.failure).toEqual({ reason: "deadline", at: 2000 });
  });

  it("a stale safety timer (old progressSeq) is a no-op", () => {
    const agent = makeAgent({ deadlineMs: 1000 });
    let [s] = agent.start(agent.init(), "r", 100);
    // Bump progress so the live alarm id changes.
    [s] = agent.turn(s, turnWith(tool("c1")), 200);
    const [same] = agent.onTimer(s, {
      type: "deadline_exceeded",
      id: "monitored:safety:r:0", // the pre-bump seq
      atMs: 3000,
    });
    expect(same.run.phase).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// Subs — the merged set across both bricks
// ---------------------------------------------------------------------------

describe("createAgent — subs (merged across llm-call + monitored-run)", () => {
  it("running with a deadline brick arms ONLY the safety deadline", () => {
    const agent = makeAgent({ deadlineMs: 1000 });
    const [s] = agent.start(agent.init(), "r", 100);
    expect(agent.subs(s)).toEqual([deadlineSub("monitored:safety:r:0", 1100)]);
  });

  it("a brain-call retry adds a retry timer alongside the safety deadline", () => {
    const agent = makeAgent({ deadlineMs: 1000 });
    let [s] = agent.start(agent.init(), "r", 100);
    // Fail the brain call → resilient slice backs off into waiting_retry.
    const err: LlmErr<Purpose> = {
      key: "plan_turn",
      purpose: "plan_turn",
      reason: "e",
      error: "e",
    };
    [s] = agent.fail(
      s,
      "plan_turn",
      { type: "resilient_err", key: "plan_turn", error: err, at: 100 },
      100,
    );
    const ids = agent.subs(s).map((sub) => sub.id);
    expect(ids).toContain("resilient:retry:plan_turn");
    expect(ids).toContain("monitored:safety:r:0");
  });

  it("no deadline brick → only retry timers ever appear", () => {
    const agent = makeAgent(); // no deadlineMs
    const [s] = agent.start(agent.init(), "r", 0);
    expect(agent.subs(s)).toEqual([]); // running, no retry pending, no watchdog
  });
});

// ---------------------------------------------------------------------------
// Boot reconcile (crash recovery — the seed's outstandingEffect)
// ---------------------------------------------------------------------------

describe("createAgent — boot reconcile", () => {
  it("awaiting llm → boot re-fires the current stage's brain call", () => {
    const agent = makeAgent({ deadlineMs: 1000 });
    const [s] = agent.start(agent.init(), "r", 100);
    expect(s.conversation?.awaiting.kind).toBe("llm");
    // Cold wake at a later time.
    const [rebooted, cmds] = agent.boot(s, 5000);
    expect(cmds).toEqual([brainRunCmd("plan_turn")]);
    // The watchdog clock re-seeded to NOW (boot is not a no-progress wedge).
    expect(rebooted.run.lastProgressAt).toBe(5000);
  });

  it("awaiting tools → boot re-fires every in-flight tool effect", () => {
    const agent = makeAgent({ toolConcurrency: 2 });
    let [s] = agent.start(agent.init(), "r", 0);
    [s] = agent.turn(s, turnWith(tool("c1"), tool("c2"), tool("c3")), 10);
    // c1, c2 running; c3 queued.
    const [, cmds] = agent.boot(s, 100);
    expect(cmds).toEqual([toolOf(tool("c1")), toolOf(tool("c2"))]);
  });

  it("no conversation (between stages / never started) → boot emits no effect", () => {
    const agent = makeAgent();
    const [rebooted, cmds] = agent.boot(agent.init(), 100);
    expect(cmds).toEqual([]);
    expect(rebooted.conversation).toBeNull();
  });

  it("a settled run → boot is a no-op", () => {
    const agent = makeAgent();
    let [s] = agent.start(agent.init(), "r", 0);
    [s] = agent.turn(s, turnWith(), 10); // plan → act
    [s] = agent.turn(s, turnWith(), 20); // act → done
    expect(s.run.phase).toBe("done");
    const [rebooted, cmds] = agent.boot(s, 100);
    expect(cmds).toEqual([]);
    expect(rebooted.run.phase).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// The detached brain-call handler (inherited from llm-call)
// ---------------------------------------------------------------------------

describe("createAgent — handlers (detached brain call)", () => {
  type HostMsg =
    | { type: "agent_turn"; turn: AgentTurn; at: number }
    | { type: "llm_failed"; reason: string };

  const ports = {
    onOk: (okv: LlmOk<Purpose, Outputs>): HostMsg => ({
      type: "agent_turn",
      turn: okv.output,
      at: 0,
    }),
    onErr: (err: LlmErr<Purpose>): HostMsg => ({
      type: "llm_failed",
      reason: err.reason,
    }),
  };

  function fakeCtx() {
    const dispatched: HostMsg[] = [];
    let pending: Promise<unknown> = Promise.resolve();
    return {
      dispatched,
      ctx: {
        waitUntil(p: Promise<unknown>) {
          pending = p;
        },
        async dispatch(msg: HostMsg) {
          dispatched.push(msg);
        },
      },
      settled: () => pending,
    };
  }

  it("dispatches the parsed AgentTurn on a model success (detached)", async () => {
    const agent = makeAgent({
      model: fakeModel(async () => ({
        content: "go",
        toolCalls: [tool("c1")],
      })),
    });
    const handler = agent.handlers<HostMsg>(ports).resilient_run;
    const { ctx, dispatched, settled } = fakeCtx();
    // `handlers(ports)` now returns the precise `AgentDetachedHandlers<P, HostMsg>`
    // — the `resilient_run` cell takes the brain run Cmd + a `{ waitUntil, dispatch }`
    // ctx, so the literal Cmd and `fakeCtx().ctx` flow in with NO `as never`.
    const ret = handler(
      {
        type: "resilient_run",
        key: "plan_turn",
        input: { purpose: "plan_turn", model: null, payload: null },
      },
      ctx,
    );
    // Detached: returns synchronously.
    expect(ret).toBeUndefined();
    await settled();
    expect(dispatched).toEqual([
      {
        type: "agent_turn",
        turn: { content: "go", toolCalls: [tool("c1")] },
        at: 0,
      },
    ]);
  });

  it("dispatches the failure Msg on a model throw", async () => {
    const agent = makeAgent({
      model: fakeModel(async () => {
        throw new Error("provider 503");
      }),
    });
    const handler = agent.handlers<HostMsg>(ports).resilient_run;
    const { ctx, dispatched, settled } = fakeCtx();
    handler(
      {
        type: "resilient_run",
        key: "act_turn",
        input: { purpose: "act_turn", model: null, payload: null },
      },
      ctx,
    );
    await settled();
    expect(dispatched).toEqual([
      { type: "llm_failed", reason: "provider 503" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// payloadOf — the consumer's prompt source threads through the brain call
// ---------------------------------------------------------------------------

describe("createAgent — payloadOf threads the conversation into the brain call", () => {
  it("the brain call carries the payload built from stage + conversation", () => {
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
      payloadOf: (stage, conv) => ({ stage, turnCount: conv.turnCount }),
      rng: rngZero,
    });
    const [, cmds] = agent.start(agent.init(), "r", 0);
    expect(cmds).toEqual([
      {
        type: "resilient_run",
        key: "plan_turn",
        input: {
          purpose: "plan_turn",
          model: null,
          payload: { stage: "plan", turnCount: 0 },
        },
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Properties — invariants over arbitrary loop drives
// ---------------------------------------------------------------------------

describe("createAgent — properties", () => {
  const agent = makeAgent({ toolConcurrency: 2, maxTurns: 50 });

  it("verbs never mutate their input slice (immutability)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000 }), (at) => {
        const s0 = Object.freeze(agent.init());
        const [s1] = agent.start(s0, "r", at);
        expect(s1).not.toBe(s0);
        const [s2] = agent.turn(s1, turnWith(tool("c1")), at);
        expect(s2).not.toBe(s1);
        const [s3] = agent.toolOk(s2, "c1", "x", at);
        expect(s3).not.toBe(s2);
        return true;
      }),
    );
  });

  it("running tools never exceed the concurrency budget", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 6 }), {
          minLength: 1,
          maxLength: 10,
        }),
        (rawIds) => {
          // De-dup ids so each is a distinct fan-out item.
          const ids = [...new Set(rawIds)];
          let [s] = agent.start(agent.init(), "r", 0);
          [s] = agent.turn(s, turnWith(...ids.map((id) => tool(id))), 1);
          // concurrency is 2 → at most 2 in flight at the scatter.
          expect(s.tools.running.length).toBeLessThanOrEqual(2);
          // Settle them one at a time; the in-flight count never exceeds the budget.
          let at = 2;
          for (const id of ids) {
            const running = s.tools.running.find((c) => c.callId === id);
            if (running === undefined) continue;
            [s] = agent.toolOk(s, id, "ok", at++);
            expect(s.tools.running.length).toBeLessThanOrEqual(2);
          }
          return true;
        },
      ),
    );
  });

  it("at most one brain-call run cmd is emitted per verb call (the gate is single-shot)", () => {
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
      fc.property(fc.array(action, { maxLength: 25 }), (actions) => {
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
          // A brain-call run cmd is keyed `resilient_run`. At most one per verb.
          const brainCmds = cmds.filter((c) => c.type === "resilient_run");
          if (brainCmds.length > 1) return false;
        }
        return true;
      }),
    );
  });

  // -------------------------------------------------------------------------
  // DURABILITY GUARD (package-wide invariant, the agent's share).
  //
  // Every reachable TERMINAL agent slice must round-trip through JSON
  // unchanged: `JSON.parse(JSON.stringify(slice))` deep-equals `slice`. A run
  // is terminal (`isSettled`) when:
  //   - `run.phase === "done"`              — empty turn retired the last stage;
  //   - `run.phase === "failed"`            — the safety watchdog fired
  //                                           (`run.failure = { reason: "deadline" }`);
  //   - `failure = { reason: "turn_limit" }`— the livelock guard tripped;
  //   - `failure = { reason: "llm", error }`— a brain call exhausted retry.
  // The `llm` failure carries the brain error; the canon pins it as plain-data
  // (`{_tag}` sentinel, never a `new Error(...)`), so the terminal slice the
  // agent stamps stays JSON-stable across a DO eviction / reload. We drive
  // arbitrary verb sequences (no-retry agent so one `fail` settles terminal)
  // and assert the round-trip on the WHOLE slice at every settled state, so the
  // property fails if any composed brick or the agent's own annotation ever
  // lands a non-serializable value in a terminal slice.
  // -------------------------------------------------------------------------
  it("every reachable terminal slice round-trips through JSON unchanged (durable)", () => {
    // No `retry` → the first brain-call failure settles the resilient slice
    // `failed` (terminal) and stamps the agent `llm` failure. deadlineMs +
    // maxTurns make the watchdog and livelock terminals reachable too.
    const durable = createAgent<
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
      deadlineMs: 1000,
      maxTurns: 4,
      rng: rngZero,
    });

    type Action =
      | { kind: "empty_turn" }
      | { kind: "tool_turn" }
      | { kind: "settle" }
      | { kind: "deadline" }
      | { kind: "llm_fail" };
    const action = fc.constantFrom<Action>(
      { kind: "empty_turn" },
      { kind: "tool_turn" },
      { kind: "settle" },
      { kind: "deadline" },
      { kind: "llm_fail" },
    );

    fc.assert(
      fc.property(fc.array(action, { maxLength: 40 }), (actions) => {
        let [s] = durable.start(durable.init(), "r", 0);
        let at = 1;
        for (const a of actions) {
          const now = at++;
          if (a.kind === "empty_turn") {
            [s] = durable.turn(s, turnWith(), now);
          } else if (a.kind === "tool_turn") {
            [s] = durable.turn(s, turnWith(tool(`c${now}`)), now);
          } else if (a.kind === "settle") {
            const running = s.tools.running[0];
            if (running !== undefined) {
              [s] = durable.toolOk(s, running.callId, `ok-${now}`, now);
            }
          } else if (a.kind === "deadline") {
            // Fire the live safety timer (if armed) → settles `run` failed.
            const safety = durable
              .subs(s)
              .find((sub) => sub.id.startsWith("monitored:safety:"));
            if (safety !== undefined) {
              [s] = durable.onTimer(s, {
                type: "deadline_exceeded",
                id: safety.id,
                atMs: now,
              });
            }
          } else {
            // Drive a brain-call failure with a PLAIN-DATA error sentinel (the
            // canon: errors as `{_tag}` data, never a `new Error(...)`), so the
            // `llm`-failed terminal slice stays JSON-stable.
            const err: LlmErr<Purpose> = {
              key: "plan_turn",
              purpose: "plan_turn",
              reason: "provider 503",
              error: { _tag: "provider_error", status: 503 },
            };
            [s] = durable.fail(
              s,
              "plan_turn",
              { type: "resilient_err", key: "plan_turn", error: err, at: now },
              now,
            );
          }

          // Whenever the run has reached a terminal state, the WHOLE slice must
          // round-trip equal under JSON — no Error object, no undefined, no
          // function/closure ever lands in a terminal agent slice.
          if (durable.isSettled(s)) {
            expect(JSON.parse(JSON.stringify(s))).toEqual(s);
          }
        }
        return true;
      }),
    );
  });

  // The random walk above robustly reaches the `done`, `deadline`, and `llm`
  // terminals; the `turn_limit` terminal needs maxTurns drained tool batches in
  // a row without the watchdog / a brain failure preempting, which the random
  // walk almost never threads. Pin each of the FOUR reachable terminals with a
  // deterministic walk so the durability invariant is asserted on every terminal
  // KIND, not just the ones a random walk happens to hit.
  it("each of the four terminal kinds round-trips through JSON unchanged (durable)", () => {
    const llmErr: LlmErr<Purpose> = {
      key: "plan_turn",
      purpose: "plan_turn",
      reason: "provider 503",
      error: { _tag: "provider_error", status: 503 },
    };
    const roundTrips = (s: unknown) =>
      expect(JSON.parse(JSON.stringify(s))).toEqual(s);

    // 1) done — two empty turns retire plan → act → done.
    {
      const a = makeAgent(); // retry present, but the brain never fails here
      let [s] = a.start(a.init(), "r", 0);
      [s] = a.turn(s, turnWith(), 1); // plan → act
      [s] = a.turn(s, turnWith(), 2); // act → done
      expect(s.run.phase).toBe("done");
      roundTrips(s);
    }

    // 2) deadline — arm the watchdog, fire its live safety timer.
    {
      const a = makeAgent({ deadlineMs: 1000 });
      const [s0] = a.start(a.init(), "r", 100);
      const safety = a
        .subs(s0)
        .find((sub) => sub.id.startsWith("monitored:safety:"));
      expect(safety).toBeDefined();
      const [s] = a.onTimer(s0, {
        type: "deadline_exceeded",
        id: safety?.id ?? "",
        atMs: 2000,
      });
      expect(s.run.phase).toBe("failed");
      expect(s.run.failure?.reason).toBe("deadline");
      roundTrips(s);
    }

    // 3) turn_limit — drain a single-tool batch maxTurns times in a row.
    {
      const a = makeAgent({ maxTurns: 3 });
      let [s] = a.start(a.init(), "r", 0);
      let at = 1;
      while (!a.isSettled(s)) {
        [s] = a.turn(s, turnWith(tool(`c${at}`)), at);
        const running = s.tools.running[0];
        if (running !== undefined) {
          [s] = a.toolOk(s, running.callId, "ok", at);
        }
        at += 1;
      }
      expect(s.failure).toEqual({
        reason: "turn_limit",
        at: expect.any(Number),
      });
      roundTrips(s);
    }

    // 4) llm — a no-retry agent settles `failed` on the first brain failure and
    // stamps the agent `llm` failure carrying the plain-data error sentinel.
    {
      const a = createAgent<Stage, Purpose, Outputs, string, ToolCmd, Message>({
        stages: STAGES,
        model: fakeModel(async () => ({ content: "", toolCalls: [] })),
        schemas,
        turnOf,
        toolOf,
        rng: rngZero,
      });
      let [s] = a.start(a.init(), "r", 0);
      [s] = a.fail(
        s,
        "plan_turn",
        { type: "resilient_err", key: "plan_turn", error: llmErr, at: 10 },
        10,
      );
      // `fail` stamps the agent `llm` failure carrying the resilient Msg's
      // `error` (the typed `LlmErr`) when the resilient slice settled terminal.
      expect(s.failure).toEqual({ reason: "llm", error: llmErr, at: 10 });
      roundTrips(s);
    }
  });
});
