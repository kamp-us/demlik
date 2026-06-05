/**
 * The payoff you can't `npm i`: an AI agent that is reliable, durable, and
 * replayable — and your reducer authors NONE of it.
 *
 * Three acts, all RUNNABLE and deterministic with a FAKE in-process model and
 * FAKE tools (no API key, no secrets, runs anywhere):
 *
 *   ACT 1  RELIABILITY — a tool call hits a flaky API (fails once, succeeds the
 *          retry). One line of `withResilience(...)` (circuit + rateLimit +
 *          retry) then `withDeadline(...)` makes it self-heal. The machine never
 *          authored a retry; the wrapper diverted the effect through the gate.
 *
 *   ACT 2  DURABILITY — run a real `createAgent` agent partway, `JSON.stringify`
 *          its Model (it is plain data), DROP the runtime, and resume a FRESH
 *          `run()` from `JSON.parse(snapshot)`. It finishes from exactly where it
 *          stopped. On Cloudflare this snapshot IS the Durable Object storage;
 *          here a JSON round-trip proves it.
 *
 *   ACT 3  REPLAY — `recorder` captures the Msg trace of a run; `replayTrace`
 *          reconstructs the exact final state locally with NO model/tool calls.
 *          A stuck prod agent reproduces in milliseconds — the bug is a diff,
 *          not a re-run.
 *
 * Run it:  node packages/tea/examples/agent-resilient-and-durable.ts
 *          (Node 23 strips the types; no build step for the example itself.)
 */

import {
  type Cmd,
  defineMachine,
  type Interpret,
  type Machine,
  type Reducer,
  type Runtime,
  run,
  type Store,
} from "@demlik/tea";
import {
  type AgentCmd,
  type AgentMachineMsg,
  type AgentState,
  type AgentTurn,
  createAgent,
  type DeadlineSub,
  type MonitoredRunCmd,
  type Schema,
  type ToolCall,
} from "@demlik/tea/agent";
import { recorder } from "@demlik/tea/recorder";
import { replayTrace } from "@demlik/tea/trace-replay";
import { withDeadline } from "@demlik/tea/with-deadline";
import { withResilience } from "@demlik/tea/with-resilience";

// ===========================================================================
// Tiny presentation helpers — narrate the story, nothing load-bearing.
// ===========================================================================

const line = (label: string) =>
  console.log(`\n━━ ${label} ${"━".repeat(Math.max(0, 58 - label.length))}`);
const say = (s: string) => console.log(s);

/** Wait until `cond()` is true, polling the runtime's settled tail. */
async function until(cond: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

// ===========================================================================
// ACT 1 — RELIABILITY
//
// A focused machine: ONE agent tool call against a flaky weather API. The base
// machine authors only the plain effect Cmd `call_tool`; `withResilience`
// diverts it through cache → circuit → rateLimit → retry, and `withDeadline`
// caps the whole thing. The base never sees a retry — the wrapper owns it.
// ===========================================================================

interface ToolState {
  readonly status: "idle" | "calling" | "done";
  readonly result: string | null;
}

// `call` carries `at` — the wall time the triggering Msg supplies as data
// (time-as-data). The resilience wrapper reads it off this Msg to gate the cold
// attempt, so the breaker / bucket compare against real wall time, never `0`.
type ToolMsg =
  | { readonly type: "call"; readonly city: string; readonly at: number }
  | { readonly type: "tool_ok"; readonly result: string };

// The TARGET effect Cmd — the base emits it plainly; the wrapper hardens it.
type CallTool = Cmd<"call_tool"> & { readonly city: string };

interface ToolCtx {
  // The flaky downstream — throws the first time, succeeds the retry.
  readonly weather: (city: string) => Promise<string>;
}

const toolStep = defineMachine<ToolState, ToolMsg, CallTool, never, ToolCtx>({
  init: (loaded) =>
    loaded !== null ? [loaded, []] : [{ status: "idle", result: null }, []],
  update: {
    call: (_s, m) => [
      { status: "calling", result: null },
      [{ type: "call_tool", city: m.city }],
    ],
    // The follow-up the base interpret returns on success — records the result.
    tool_ok: (_s, m) => [{ status: "done", result: m.result }, []],
  },
  interpret: {
    // The TARGET's base handler — the actual fallible work the wrapper wraps.
    call_tool: async (cmd, ctx): Promise<ToolMsg> => {
      const result = await ctx.weather(cmd.city);
      return { type: "tool_ok", result };
    },
  },
});

async function act1Reliability() {
  line("ACT 1 — RELIABILITY: the retry you do not write");

  // The flaky tool: attempt #1 throws (transient 503), attempt #2 returns.
  let attempts = 0;
  const ctx: ToolCtx = {
    weather: async (city) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error(`503 from weather-api (attempt ${attempts})`);
      }
      return `${city}: 18°C, clear`;
    },
  };

  // ONE line of wrapping. The base `toolStep` knows nothing about any of it.
  const resilient = withResilience(
    toolStep,
    {
      target: "call_tool", // harden THIS Cmd; everything else passes through
      at: (m) => (m.type === "call" ? m.at : 0), // cold-gate wall time, as data
      circuit: { threshold: 3, cooldownMs: 1 }, // open after repeated failures
      rateLimit: { capacity: 5, refillPerSec: 5 }, // token bucket per call key
      retry: {
        baseMs: 10, // tiny backoff → the demo stays snappy + deterministic
        factor: 2,
        capMs: 50,
        maxAttempts: 5,
        jitter: "none", // pinned: no RNG in the delay
      },
    },
    () => 0, // injected jitter RNG (unused with jitter:"none") — pinned anyway
  );
  const guarded = withDeadline(resilient, { ms: 10_000 });

  const runtime = run(guarded, { ctx });
  await runtime.ready;

  say("the agent dispatched ONE tool call: weather('Istanbul')");
  await runtime.dispatch({ type: "call", city: "Istanbul", at: Date.now() });

  // The wrapper diverts the effect through its gate: the first attempt throws,
  // it schedules a retry timer, fires it, re-gates, and the second attempt
  // succeeds. The recovered result + the breaker/retry state live in the
  // wrapper's `$resilience` slice — the base never authored a line of it.
  await until(
    () =>
      runtime.getState().base.$resilience.calls.call_tool?.phase ===
      "succeeded",
    "tool recovered",
  );

  const r = runtime.getState().base.$resilience;
  const call = r.calls.call_tool;
  say(
    `tool hit the flaky API ${attempts}× (attempt 1 threw 503, attempt 2 recovered)`,
  );
  say(`$resilience.call phase: ${call?.phase}`);
  say(
    `$resilience.call result: ${JSON.stringify(call?.phase === "succeeded" ? call.result : null)}`,
  );
  say(
    `circuit breaker now: ${r.circuit.phase} (it absorbed the failure, then closed)`,
  );
  say(
    `retry slice for the call: ${JSON.stringify(r.retry)}  ← reset on success`,
  );
  say(
    "→ the base machine authored ONE effect Cmd. withResilience retried +\n" +
      "  recovered it; withDeadline caps the whole thing. Reliability is a\n" +
      "  function over machine data — not code your reducer ever wrote.",
  );
  await runtime.stop();
}

// ===========================================================================
// Shared fake brain + fake tools for ACTS 2 & 3 — a real `createAgent` agent.
//
// A two-stage pipeline: "research" → "report". Each stage runs ONE brain call
// that returns an AgentTurn. The fake model is scripted by invoke order, so the
// whole run is deterministic with no API key.
// ===========================================================================

type Stage = "research" | "report";
type Purpose = "research_turn" | "report_turn";
interface Outputs extends Record<Purpose, unknown> {
  readonly research_turn: AgentTurn;
  readonly report_turn: AgentTurn;
}
type Msg = { readonly role: string; readonly text: string };

// A schema that narrows an unknown to an AgentTurn (the seed's brain-only path).
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
const schemas = {
  research_turn: turnSchema(),
  report_turn: turnSchema(),
} as const;

// Which brain-call purpose each stage runs.
const turnOf = (stage: Stage | undefined): Purpose =>
  stage === "report" ? "report_turn" : "research_turn";

// The per-tool effect Cmd, as data — a CLOSED variant so the agent's `TC` type
// stays precise and the wired interpret merge type-checks per key.
type RunTool = { readonly type: "run_tool" } & ToolCall;
const toolOf = (call: ToolCall): RunTool => ({ type: "run_tool", ...call });

const tool = (callId: string, name: string): ToolCall => ({
  callId,
  name,
  args: {},
});

// The scripted brain: research asks for one tool, then (after the tool result
// folds back) emits an empty turn → advance to report → empty turn → done.
//   research #1 → call `fetch_docs`
//   research #2 → done with research (empty turn) → advance to report
//   report    #1 → done (empty turn) → finish
const RESEARCH_TOOL_TURN: AgentTurn = {
  content: "I should look up the docs.",
  toolCalls: [tool("c1", "fetch_docs")],
};
const RESEARCH_DONE_TURN: AgentTurn = {
  content: "Research complete.",
  toolCalls: [],
};
const REPORT_DONE_TURN: AgentTurn = {
  content: "Report written.",
  toolCalls: [],
};
const TURNS: readonly AgentTurn[] = [
  RESEARCH_TOOL_TURN,
  RESEARCH_DONE_TURN,
  REPORT_DONE_TURN,
];

/** A fake model factory: `withStructuredOutput().invoke` resolves a scripted turn. */
function scriptedModel(cursor: { i: number }) {
  return () => ({
    withStructuredOutput<T>(_schema: Schema<T>) {
      return {
        invoke: async (): Promise<T> => {
          const turn = TURNS[cursor.i] ?? { content: "", toolCalls: [] };
          cursor.i += 1;
          return turn as unknown as T;
        },
      };
    },
  });
}

type ResearchAgent = ReturnType<
  typeof createAgent<Stage, Purpose, Outputs, string, RunTool, Msg>
>;
type AgentMsg = AgentMachineMsg<Purpose, Outputs, string>;
type ResearchState = AgentState<Stage, Purpose, Outputs, string>;
type ResearchCmd = AgentCmd<Purpose, RunTool>;
type ResearchMachine = Machine<
  ResearchState,
  AgentMsg,
  ResearchCmd,
  DeadlineSub,
  object
>;

/** Build the two-stage agent. `cursor` lets the caller share/reset the script. */
function makeAgent(cursor: { i: number }): ResearchAgent {
  return createAgent<Stage, Purpose, Outputs, string, RunTool, Msg>(
    {
      stages: ["research", "report"],
      model: scriptedModel(cursor),
      schemas,
      turnOf,
      toolOf,
      retry: {
        baseMs: 10,
        factor: 2,
        capMs: 50,
        maxAttempts: 3,
        jitter: "none",
      },
    },
    () => 0, // pinned jitter RNG
  );
}

// The consumer's tool interpret: perform the fake tool and route the result
// back into the loop as a FOLLOW-UP Msg (re-entry). A `tools` map keeps it
// deterministic and offline.
const FETCH_DOCS_RESULT = "docs: TEA = init + update + view, effects as data.";
const TOOLS: Record<string, string> = { fetch_docs: FETCH_DOCS_RESULT };
function toolInterpret(): Interpret<
  AgentMsg,
  MonitoredRunCmd<unknown> | RunTool,
  object
> {
  return {
    run_tool: async (cmd): Promise<AgentMsg> => ({
      type: "agent_tool_ok",
      callId: cmd.callId,
      result: TOOLS[cmd.name] ?? `ran:${cmd.name}`,
      at: 0,
    }),
    // No `snapshotEvery` is set, so `snapshot_write` is never emitted — but the
    // closed `AgentCmd` union still requires the cell to type-check.
    snapshot_write: async () => {},
  };
}

/** Drive an agent runtime to a terminal state (done/failed). */
async function driveToDone(
  runtime: Runtime<ResearchState, AgentMsg>,
): Promise<void> {
  await until(() => {
    const p = runtime.getState().run.phase;
    return p === "done" || p === "failed";
  }, "agent terminal");
}

// ===========================================================================
// ACT 2 — DURABILITY
//
// Run the agent partway, snapshot its Model as JSON, DROP the runtime, then
// resume a FRESH `run()` from the parsed snapshot via a one-field in-memory
// Store. The substrate feeds the snapshot to `init(loaded)`, which the agent's
// `toMachine` rehydrates as `[loaded, []]`. It finishes from where it stopped.
// ===========================================================================

/** A trivial Store whose `load()` hands back a snapshot the host stuffed in. */
function snapshotStore(snapshot: string | null): Store<ResearchState> {
  return {
    load: async () => (snapshot === null ? null : JSON.parse(snapshot)),
    save: async () => {}, // the DO would persist here; the demo round-trips by hand
    migrate: (raw) => (raw === null ? null : (raw as ResearchState)),
  };
}

async function act2Durability() {
  line("ACT 2 — DURABILITY: the checkpointer you do not write");

  // --- Advance the agent PARTWAY with its pure verbs (no clock, no I/O), so the
  //     stop point is deterministic: start → fold the research turn that calls a
  //     tool → settle the tool. The loop is now back in the "research" stage,
  //     awaiting the next brain call (turnCount === 1). This is exactly the state
  //     a live worker would hold the instant before eviction. ---
  const agentA = makeAgent({ i: 0 });
  let [partway] = agentA.start(agentA.init(), "run-42", 0);
  [partway] = agentA.turn(partway, RESEARCH_TOOL_TURN, 10); // model asked for fetch_docs
  [partway] = agentA.toolOk(partway, "c1", FETCH_DOCS_RESULT, 20); // tool folded back

  say("runtime A ran partway, then the worker was evicted mid-pipeline:");
  say(
    `  stage=${agentA.currentStage(partway)}, ` +
      `turns=${partway.conversation?.turns.length}, ` +
      `toolRecords=${partway.conversation?.toolRecords.length}, ` +
      `awaiting=${partway.conversation?.awaiting.kind}, phase=${partway.run.phase}`,
  );

  // --- The snapshot. The Model is PLAIN DATA — it JSON-round-trips exactly. ---
  const snapshot = JSON.stringify(partway);
  say(
    `snapshot is ${snapshot.length} bytes of plain JSON (no closures, no classes)`,
  );
  say(
    `round-trips exactly: ${JSON.stringify(JSON.parse(snapshot)) === snapshot}`,
  );
  say("→ on Cloudflare this IS the Durable Object's stored state. We drop the");
  say("  runtime here and prove resume with a JSON round-trip.");

  // --- Runtime B: a FRESH agent + runtime, booted from the parsed snapshot.
  //     The brain has no memory of its own — the durable Model carries the whole
  //     conversation, so the next brain call resumes the research stage. The fake
  //     model's script continues at turn #1 (the empty turn that finishes
  //     research); in production the prompt is rebuilt from the durable turns. ---
  const agentB = makeAgent({ i: 1 });
  const machineB = agentB.toMachine<object>({ toolInterpret: toolInterpret() });
  const runtimeB = run(machineB, {
    ctx: {} as object,
    store: snapshotStore(snapshot),
  });
  await runtimeB.ready;

  const resumed = runtimeB.getState();
  say(
    `\nruntime B booted from snapshot: stage=${agentB.currentStage(resumed)}, ` +
      `turns=${resumed.conversation?.turns.length} (exactly where A stopped)`,
  );

  // Boot reconcile re-fires the ONE outstanding effect (the in-flight brain
  // call), and the loop runs to completion — across two stages, to `done`.
  await runtimeB.dispatch({ type: "agent_boot", at: 1000 });
  await driveToDone(runtimeB);

  const finished = runtimeB.getState();
  say(
    `runtime B finished: phase=${finished.run.phase}, failure=${finished.failure}`,
  );
  say(
    `final stage retired; conversation cleared = ${finished.conversation === null}`,
  );
  say(
    "→ no checkpointer code. The agent slice is plain data; the substrate's\n" +
      "  `init(loaded)` rehydrate + `agent_boot` reconcile resumed the exact run.",
  );
  await runtimeB.stop();
}

// ===========================================================================
// ACT 3 — REPLAY
//
// Record the Msg trace of a run, then `replayTrace(machine, trace)` to
// reconstruct the exact final state locally — NO model, NO tools, NO clock.
// A stuck prod agent reproduces in milliseconds; a regression is a diff.
// ===========================================================================

async function act3Replay() {
  line("ACT 3 — REPLAY: the tracer you do not need");

  // --- IN PROD: run the agent end to end, recording every Msg. ---
  const cursor = { i: 0 };
  const agent = makeAgent(cursor);
  const machine = agent.toMachine<object>({ toolInterpret: toolInterpret() });
  const runtime = run(machine, { ctx: {} as object });
  const rec = recorder<ResearchState, AgentMsg>(runtime);
  await runtime.ready;

  say("prod: recording the Msg trace of a full agent run...");
  await runtime.dispatch({ type: "agent_start", runId: "run-99", at: 0 });
  await driveToDone(runtime);
  await runtime.stop();

  const trace = rec.dump();
  rec.stop();
  say(
    `recorder captured ${trace.msgs.length} msgs: ` +
      `[${trace.msgs.map((m) => m.type).join(", ")}]`,
  );

  // --- DEBUG LOCALLY: replay the trace against the SAME machine — no I/O. ---
  // `replayTrace` re-folds the recorded msgs through `init + update` only:
  // never `interpret`, so the fake model + tools are NEVER called again.
  const sameMachine = makeAgent({ i: 0 }).toMachine<object>({
    toolInterpret: toolInterpret(),
  });
  const onSame = replayTrace(sameMachine, trace, {} as object);
  say(`\nreplayTrace(same reducer)   matches: ${onSame.matches}`);
  say(
    "→ the exact prod final state reconstructed locally with ZERO model/tool calls.",
  );

  // --- VERIFY A BUG IS A DIFF: replay the SAME trace against a BUGGY reducer.
  //     The buggy variant forgets to clear the conversation when the pipeline
  //     finishes — a classic "stuck agent" leak. Replay pinpoints the field. ---
  const buggy = buildBuggyMachine();
  const onBuggy = replayTrace(buggy, trace, {} as object);
  say(`\nreplayTrace(buggy reducer)  matches: ${onBuggy.matches}`);
  if (onBuggy.divergence) {
    const d = onBuggy.divergence;
    say(`divergence at  ${d.path}`);
    say(`   prod (correct) = ${JSON.stringify(d.expected)}`);
    say(`   buggy          = ${JSON.stringify(d.actual)}`);
    say(
      "→ a stuck prod agent reproduces in milliseconds. The bug is a DIFF at one\n" +
        "  field, not a re-run against the live model.",
    );
  }
}

/**
 * The same agent machine, but with a planted regression: when the brain-success
 * cell (`resilient_ok`) retires the LAST stage, the buggy variant FORGETS to let
 * the conversation clear — it re-attaches the conversation the correct reducer
 * nulled. A classic "stuck agent" leak. We reuse the real machine's cells and
 * override exactly one, faithful to the real types — no `any`, no laundering.
 */
function buildBuggyMachine(): ResearchMachine {
  const agent = makeAgent({ i: 0 });
  const good = agent.toMachine<object>({ toolInterpret: toolInterpret() });

  // The agent's `update` is a flat `Reducer` (one cell per Msg.type). Spread it,
  // then override the `resilient_ok` cell to plant the leak.
  const goodUpdate = good.update as Reducer<
    ResearchState,
    AgentMsg,
    ResearchCmd
  >;
  const realResilientOk = goodUpdate.resilient_ok;
  const buggyUpdate: Reducer<ResearchState, AgentMsg, ResearchCmd> = {
    ...goodUpdate,
    resilient_ok: (s, m) => {
      const [next, cmds] = realResilientOk(s, m);
      if (next.run.phase === "done" && next.conversation === null) {
        // BUG: re-attach the conversation the correct reducer cleared.
        return [{ ...next, conversation: s.conversation }, cmds];
      }
      return [next, cmds];
    },
  };

  // Reuse the good machine's other fields verbatim; swap in the buggy update.
  return defineMachine<
    ResearchState,
    AgentMsg,
    ResearchCmd,
    DeadlineSub,
    object
  >({
    init: good.init,
    update: buggyUpdate,
    subscriptions: good.subscriptions,
    subscribe: good.subscribe,
    interpret: good.interpret,
  });
}

// ===========================================================================
// main
// ===========================================================================

async function main() {
  say("@demlik/tea — an agent that is reliable, durable, and replayable.");
  say("FAKE model + FAKE tools. Deterministic. No API key. Runs anywhere.");
  await act1Reliability();
  await act2Durability();
  await act3Replay();
  line("done");
}

main();
