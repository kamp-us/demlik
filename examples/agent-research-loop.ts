/**
 * The headline example: an AI agent is a PURE TEA machine — the LangGraph-runtime
 * replacement. No graph DSL, no node registry, no edges. The whole agent loop
 * `llm → tools → fold → llm → advance → done` is one reducer over plain data.
 *
 * Story: a research agent runs an ordered pipeline — plan → research → synthesize.
 *   - plan       asks the brain for one turn; it requests ONE tool (search a topic).
 *   - research   asks again; the brain fans out TWO tool calls at once
 *                (toolConcurrency 2), then on its next turn asks for NO tools →
 *                the stage is done and the pipeline advances.
 *   - synthesize asks once, the brain writes the report with no tools → done.
 *
 * Everything is FAKE + in-process: a scripted model (zero API keys, zero secrets)
 * and a canned search tool. So it runs anywhere — including the demlik.run site —
 * and prints the SAME story every time. Determinism is the point: the model is a
 * lookup table, the tools are pure, and time arrives as data (`at`), never read
 * from the clock inside the reducer.
 *
 * Run it:  node packages/tea/examples/agent-research-loop.ts   (Node 23 strips types)
 */

import { type Interpret, run } from "@demlik/tea";
import {
  type AgentMachineMsg,
  type AgentTurn,
  createAgent,
  type MonitoredRunCmd,
  type Schema,
  type ToolCall,
} from "@demlik/tea/agent";

// ===========================================================================
// The domain seams the consumer supplies — stages, the brain output, the tool.
// ===========================================================================

/** The ordered pipeline. Each stage runs the brain-call purpose of the same name. */
type Stage = "plan" | "research" | "synthesize";
type Purpose = Stage;

/** Every brain call parses to an `AgentTurn` (narration + the tools it wants run). */
type Outputs = { plan: AgentTurn; research: AgentTurn; synthesize: AgentTurn };

/** What the search tool returns — a canned snippet the brain folds back in next turn. */
type ToolResult = { readonly snippet: string };

/** The one tool effect Cmd. `toolOf` maps a model's `ToolCall` to this. */
type RunTool = { readonly type: "run_tool" } & ToolCall;

/** The message shape the (fake) model speaks. We never actually inspect it. */
type ChatMsg = { readonly role: "system" | "user"; readonly content: string };

// ===========================================================================
// The FAKE model — a deterministic lookup table standing in for an LLM.
// `withStructuredOutput(schema).invoke()` returns the SCRIPTED AgentTurn for the
// current stage — no network, no key, no randomness. The purpose is threaded in
// via the schema identity (each stage's schema is a distinct object that knows
// its own purpose), exactly the seam a real `z.object(...)` would occupy.
// ===========================================================================

/**
 * One scripted turn per (purpose × attempt). The research stage has TWO scripted
 * turns: attempt 1 fans out two tools, attempt 2 asks for none → stage advances.
 * This is the entire "intelligence" of the agent in this demo: a table.
 */
const SCRIPT: Record<Purpose, readonly AgentTurn[]> = {
  plan: [
    // Turn 1 — one tool: scope the research by searching the landscape.
    {
      content:
        "Goal: brief on durable AI agents. Step 1 — survey the runtime landscape.",
      toolCalls: [
        { callId: "c1", name: "search", args: { q: "durable agent runtimes" } },
      ],
    },
    // Turn 2 — the search came back; the plan is set, no more tools → advance.
    {
      content:
        "Landscape clear. Plan locked: compare TEA vs LangGraph, then synthesize.",
      toolCalls: [],
    },
  ],
  research: [
    // Turn 1 — fan out TWO lookups at once (toolConcurrency 2 lets both fly).
    {
      content:
        "Two open questions. Fan out: how does TEA model the loop, and how does LangGraph?",
      toolCalls: [
        {
          callId: "c2",
          name: "search",
          args: { q: "TEA agent loop as a reducer" },
        },
        {
          callId: "c3",
          name: "search",
          args: { q: "LangGraph runtime graph DSL" },
        },
      ],
    },
    // Turn 2 — both results in; enough evidence, no more tools → the stage is DONE.
    {
      content: "Enough evidence gathered. No further lookups needed.",
      toolCalls: [],
    },
  ],
  synthesize: [
    // One turn, no tools — write the report and the whole run is done.
    {
      content:
        "Report: a TEA agent is a pure reducer — the loop IS data, durable + replayable. " +
        "LangGraph wraps the same loop in a graph DSL plus a runtime to walk it.",
      toolCalls: [],
    },
  ],
};

/** Per-purpose call counters so the model returns the NEXT scripted turn each time. */
const attempts: Record<Purpose, number> = {
  plan: 0,
  research: 0,
  synthesize: 0,
};

/**
 * A per-purpose schema that BOTH validates the turn (identity here — the scripted
 * value is already an `AgentTurn`) AND carries its purpose so the fake model can
 * pick the right script. A real consumer's schema is a `z.ZodType<AgentTurn>`;
 * this one just tags itself with the stage it parses for.
 */
function purposeSchema(
  purpose: Purpose,
): Schema<AgentTurn> & { readonly purpose: Purpose } {
  return { purpose, parse: (v: unknown): AgentTurn => v as AgentTurn };
}

const schemas = {
  plan: purposeSchema("plan"),
  research: purposeSchema("research"),
  synthesize: purposeSchema("synthesize"),
};

/**
 * An ordered log of every turn the model produced, tagged with its stage. The
 * narrator consumes from the FRONT on each brain settle — this is robust to the
 * conversation reset that `advance` performs (an empty-tool turn advances the
 * pipeline and clears the stage conversation before we could read it back).
 */
const produced: { purpose: Purpose; turn: AgentTurn }[] = [];

/**
 * The fake model factory — the `ModelFactory<ChatMsg>` the agent's `model` port
 * expects. It ignores the messages entirely and replays the script for the
 * purpose carried on the bound schema. The bound `invoke` resolves to the
 * scripted `AgentTurn`; `schema.parse` then validates it — exactly the real
 * `withStructuredOutput → parse` path, just with a deterministic source.
 */
function fakeModel() {
  return {
    withStructuredOutput<T>(schema: Schema<T> & { purpose?: Purpose }) {
      const purpose = (schema.purpose ?? "synthesize") as Purpose;
      return {
        invoke: async (_messages: readonly ChatMsg[]): Promise<T> => {
          const turns = SCRIPT[purpose];
          const i = Math.min(attempts[purpose], turns.length - 1);
          attempts[purpose] += 1;
          const turn = turns[i] ?? { content: "", toolCalls: [] };
          produced.push({ purpose, turn });
          // The model's job is to emit a value the schema parses to `T` — here
          // the scripted turn IS that value, so `schema.parse` narrows it with no
          // cast (exactly the real `withStructuredOutput → invoke → parse` path).
          return schema.parse(turn);
        },
      };
    },
  };
}

// ===========================================================================
// The FAKE tool — a canned search. The consumer owns the tool's interpret; it
// returns the tool-ok (or tool-err) Msg that RE-ENTERS the loop.
// ===========================================================================

/** Canned answers, keyed by the model's query. Deterministic and offline. */
const KNOWLEDGE: Record<string, string> = {
  "durable agent runtimes":
    "Durable agents persist loop state so an eviction mid-run resumes the exact turn.",
  "TEA agent loop as a reducer":
    "TEA folds llm→tools→fold→llm in one pure reducer; the Model is serializable JSON.",
  "LangGraph runtime graph DSL":
    "LangGraph encodes the loop as a node/edge graph and ships a runtime to execute it.",
};

// ===========================================================================
// Build the agent. This is the WHOLE wiring — no graph, no nodes, no edges.
// ===========================================================================

const agent = createAgent<
  Stage,
  Purpose,
  Outputs,
  ToolResult,
  RunTool,
  ChatMsg
>({
  stages: ["plan", "research", "synthesize"],
  model: fakeModel,
  schemas,
  // Which brain-call purpose a stage runs (here: same name). The `undefined`
  // stage (between stages / done) parks on "synthesize" — never actually used.
  turnOf: (stage) => stage ?? "synthesize",
  payloadOf: (stage) => ({ stage }),
  toolOf: (call): RunTool => ({ type: "run_tool", ...call }),
  toolConcurrency: 2, // fan-out: up to 2 search calls in flight at once.
  maxTurns: 20, // livelock guard — the loop can never spin forever.
});

// ===========================================================================
// The consumer's tool interpret — runs the canned search, returns the tool-ok
// (or tool-err) Msg that RE-ENTERS the loop. The agent owns the brain interpret.
// ===========================================================================

type Msg = AgentMachineMsg<Purpose, Outputs, ToolResult>;
type State = ReturnType<typeof agent.init>;
type Ctx = { readonly now: () => number };

const toolInterpret: Interpret<Msg, MonitoredRunCmd<unknown> | RunTool, Ctx> = {
  run_tool: async (cmd, ctx) => {
    const q = String((cmd.args as { q?: unknown }).q ?? "");
    const snippet = KNOWLEDGE[q];
    if (snippet === undefined) {
      // Errors are data: a miss routes back as a tool error the brain can see.
      return {
        type: "agent_tool_err",
        callId: cmd.callId,
        reason: `no result for "${q}"`,
        at: ctx.now(),
      };
    }
    return {
      type: "agent_tool_ok",
      callId: cmd.callId,
      result: { snippet },
      at: ctx.now(),
    };
  },
  // The agent forwards monitored-run checkpoint writes here; we set no
  // `snapshotEvery`, so this never fires — but the closed Cmd union requires it.
  snapshot_write: async () => undefined,
};

// ===========================================================================
// Narration — turn each transition into a line of the story.
// ===========================================================================

const line = (label: string) =>
  console.log(`\n━━ ${label} ${"━".repeat(Math.max(0, 56 - label.length))}`);

/** Print the `▸ stage: X` banner the first time a stage is entered. */
let lastStage: Stage | undefined;
function stageBanner(stage: Stage) {
  if (stage !== lastStage) {
    console.log(`\n▸ stage: ${stage}`);
    lastStage = stage;
  }
}

function narrate(msg: Msg) {
  switch (msg.type) {
    case "agent_start":
      console.log("start → fire the first brain call");
      break;
    case "resilient_ok": {
      // A brain call settled — pull the turn it produced (FIFO; survives the
      // conversation reset an empty-tool advance performs).
      const entry = produced.shift();
      if (entry) {
        stageBanner(entry.purpose);
        console.log(`  • brain: "${entry.turn.content}"`);
        if (entry.turn.toolCalls.length === 0) {
          const done = entry.purpose === "synthesize";
          console.log(
            done
              ? "    → no tool calls → pipeline complete → done"
              : "    → no tool calls → stage done → advance the pipeline",
          );
        } else {
          const names = entry.turn.toolCalls
            .map((c) => `${c.name}(${JSON.stringify(c.args)})`)
            .join(", ");
          console.log(
            `    → ${entry.turn.toolCalls.length} tool call(s) scattered: ${names}`,
          );
        }
      }
      break;
    }
    case "agent_tool_ok":
      console.log(`  • tool ok  [${msg.callId}]: "${msg.result.snippet}"`);
      break;
    case "agent_tool_err":
      console.log(`  • tool err [${msg.callId}]: ${msg.reason}`);
      break;
    default:
      break;
  }
}

// ===========================================================================
// Drive it: run() the machine, dispatch the start verb, watch the loop fold.
// ===========================================================================

async function main() {
  // A monotonically advancing fake clock — time is DATA, injected via ctx.
  let clock = 1_000;
  const ctx: Ctx = {
    now: () => {
      clock += 1;
      return clock;
    },
  };

  const machine = agent.toMachine<Ctx>({ toolInterpret });
  const runtime = await run(machine, { ctx }).ready;

  line("the agent loop, narrated");
  console.log(
    "stages: plan → research → synthesize   (toolConcurrency 2, no graph DSL)",
  );

  // `observe` fires once per completed transition with the (msg, state) pair —
  // the exact devtools trace hook. We turn it into a story, and resolve `settled`
  // the moment the run reaches a terminal state.
  let resolveSettled: () => void;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  runtime.observe((msg, state) => {
    if (msg !== null) narrate(msg);
    if (agent.isSettled(state)) resolveSettled();
  });

  // The single entry point: start the run. Everything after is the reducer
  // folding brain turns and tool results — no imperative orchestration. The loop
  // re-enters itself via follow-up Msgs (brain settle + tool results) the
  // substrate enqueues on its dispatch tail; we just await the terminal.
  await runtime.dispatch({
    type: "agent_start",
    runId: "research-001",
    at: ctx.now(),
  });
  await settled;

  // === The terminal Model — plain, serializable JSON ===
  line("final Model (plain serializable JSON)");
  const final = runtime.getState();
  console.log(`run.runId        : ${final.run.runId}`);
  console.log(`run.phase        : ${final.run.phase}`);
  console.log(
    `run.progressSeq  : ${final.run.progressSeq}  (watchdog saw the loop advance, never wedged)`,
  );
  console.log(
    `brain calls made : ${Object.keys(final.resilience.calls).join(", ")}  (one resilient call per stage)`,
  );
  console.log(`failure          : ${JSON.stringify(final.failure)}`);
  console.log(`settled?         : ${agent.isSettled(final)}`);

  // Prove it round-trips through JSON — durable across an eviction / reload.
  const json = JSON.stringify(final);
  const rehydrated = JSON.parse(json) as State;
  console.log(
    `\nJSON round-trips : ${JSON.stringify(rehydrated) === json}  (Model is pure data — durable)`,
  );
  console.log(`Model size       : ${json.length} bytes`);

  line("the point");
  console.log(
    "The entire loop — llm → tools → fold → llm → advance → done — was a",
  );
  console.log(
    "PURE REDUCER. No graph DSL, no node registry, no edges, no runtime to",
  );
  console.log(
    "interpret a graph. Just `update(state, msg) → [state, cmds]` over plain",
  );
  console.log(
    "data. The final Model is JSON: persist it, evict the agent, reload, and",
  );
  console.log(
    "`boot` re-derives the one outstanding effect and resumes the exact turn.",
  );

  await runtime.stop();
}

main();
