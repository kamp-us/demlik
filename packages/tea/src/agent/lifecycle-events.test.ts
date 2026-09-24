import { describe, expect, expectTypeOf, it } from "vitest";
import type { Interpret } from "../index";
import { memoryStore } from "../mem";
import { run } from "../promise";
import {
  AGENT_EVENT_TYPES,
  type AgentEvent,
  type AgentMachineMsg,
  type AgentState,
  type AgentTurn,
  agentBootMsg,
  agentEvents,
  createAgent,
  type Schema,
  type ToolCall,
} from "./index";

// ---------------------------------------------------------------------------
// #331 — the started / failed / ended events a tracer needs: `BrainStarted`,
// `ToolStarted`, `ToolFailed`, and a `RunDone` for every ending, each carrying
// the run's durable `runId`.
// ---------------------------------------------------------------------------

type Purpose = "act";
interface Outputs extends Record<Purpose, AgentTurn> {
  readonly act: AgentTurn;
}
type ToolCmd = { readonly type: "run_tool" } & ToolCall;
type M = AgentMachineMsg<Purpose, Outputs, string>;
type S = AgentState<string, Purpose, Outputs, string>;

const turnSchema: Schema<AgentTurn> = { parse: (v) => v as AgentTurn };
const call = (callId: string, name: string): ToolCall => ({
  callId,
  name,
  args: { q: callId },
});
const ASK: AgentTurn = {
  content: "let me look",
  toolCalls: [call("c1", "search"), call("c2", "fetch")],
};
const ANSWER: AgentTurn = { content: "found it", toolCalls: [] };

/** A model that answers each call with the next scripted turn, or throws. */
function scripted(turns: readonly (AgentTurn | Error)[]) {
  let i = 0;
  return () => ({
    withStructuredOutput<T>(_s: Schema<T>) {
      return {
        invoke: async (): Promise<T> => {
          const next = turns[i++] ?? ANSWER;
          if (next instanceof Error) throw next;
          return next as T;
        },
      };
    },
  });
}

/** `c1` succeeds; `c2` fails with its own error. */
const toolInterpret: Interpret<M, ToolCmd, object> = {
  run_tool: async (cmd) =>
    cmd.name === "fetch"
      ? {
          type: "agent_tool_err",
          callId: cmd.callId,
          reason: "404",
          at: 0,
        }
      : {
          type: "agent_tool_ok",
          callId: cmd.callId,
          result: `ok:${cmd.callId}`,
          at: 0,
        },
};

function makeAgent(turns: readonly (AgentTurn | Error)[]) {
  return createAgent<string, Purpose, Outputs, string, ToolCmd>({
    stages: ["only"],
    model: scripted(turns),
    schemas: { act: turnSchema },
    turnOf: () => "act",
    toolOf: (c) => ({ type: "run_tool", ...c }),
    modelId: "test-model",
    rng: () => 0,
  });
}

/** Boot a runtime over `agent` that records every public event, in order. */
async function recorded(
  agent: ReturnType<typeof makeAgent>,
  loaded?: S,
  onState?: (s: S) => void,
) {
  const { machine, interpret, subscribe } = agent.toMachine<object>({
    toolInterpret,
  });
  let clock = 100;
  const runtime = await run(machine, {
    ctx: {},
    interpret,
    subscribe,
    clock: () => {
      clock += 1;
      return clock;
    },
    ...(loaded !== undefined ? { store: memoryStore(loaded) } : {}),
    terminal: (s) => agent.isSettled(s),
    events: agentEvents<string, Purpose, Outputs, string>(),
  }).ready;
  const events: AgentEvent<string>[] = [];
  for (const type of AGENT_EVENT_TYPES) {
    runtime.on(type, (e: AgentEvent<string>) => {
      events.push(e);
    });
  }
  if (onState !== undefined) runtime.observe((_m, s) => onState(s));
  return { runtime, events };
}

describe("#331 — the lifecycle event stream", () => {
  it("one brain turn, two tools (one failing): every start, settle and failure, in order", async () => {
    const { runtime, events } = await recorded(makeAgent([ASK, ANSWER]));
    await runtime.dispatch({ type: "agent_start", runId: "run-1", at: 0 });
    await runtime.done();
    await runtime.stop();

    expect(events.map((e) => e.type)).toEqual([
      "BrainStarted",
      "TurnSettled",
      // Serial by default: c2 is queued, and starts when c1 frees the slot.
      "ToolStarted",
      "ToolSettled",
      "ToolStarted",
      "ToolFailed",
      "BrainStarted",
      "TurnSettled",
      "RunDone",
    ]);
    expect(events[0]).toEqual({
      type: "BrainStarted",
      runId: "run-1",
      at: 0,
      turn: 0,
      purpose: "act",
      model: "test-model",
      payload: null,
    });
    expect(events[2]).toMatchObject({
      type: "ToolStarted",
      callId: "c1",
      name: "search",
      args: { q: "c1" },
    });
    expect(events[4]).toMatchObject({ type: "ToolStarted", callId: "c2" });
    expect(events[5]).toMatchObject({
      type: "ToolFailed",
      callId: "c2",
      name: "fetch",
      failure: { kind: "error", reason: "404" },
    });
    expect(events[6]).toMatchObject({ type: "BrainStarted", turn: 1 });
    expect(events[8]).toMatchObject({
      type: "RunDone",
      status: { kind: "done", output: ANSWER },
    });
    // One run, one id, on every event.
    expect(new Set(events.map((e) => e.runId))).toEqual(new Set(["run-1"]));
  });

  it("a run that fails still ends on one RunDone, carrying the failure", async () => {
    const { runtime, events } = await recorded(
      makeAgent([new Error("model down")]),
    );
    await runtime.dispatch({ type: "agent_start", runId: "run-1", at: 0 });
    await runtime.done();
    await runtime.stop();

    expect(events.map((e) => e.type)).toEqual(["BrainStarted", "RunDone"]);
    expect(events[1]).toMatchObject({
      type: "RunDone",
      status: { kind: "failed", failure: { reason: "llm" } },
    });
  });

  it("keeps the run id across a kill and a resume from the Store", async () => {
    // Run 1: snapshot the Model with the tools in flight — the point a host
    // dies at — through a JSON boundary, the shape a real Store holds.
    let parked: S | undefined;
    const first = await recorded(makeAgent([ASK, ANSWER]), undefined, (s) => {
      if (parked === undefined && s.conversation?.awaiting.kind === "tools") {
        parked = JSON.parse(JSON.stringify(s));
      }
    });
    await first.runtime.dispatch({
      type: "agent_start",
      runId: "run-1",
      at: 0,
    });
    await first.runtime.done();
    await first.runtime.stop();
    if (parked === undefined) throw new Error("run 1 never parked on tools");

    // Run 2 boots those bytes: the in-flight call starts again from this
    // process's point of view, and the run finishes.
    const second = await recorded(makeAgent([ANSWER]), parked);
    await second.runtime.dispatch(agentBootMsg(500));
    await second.runtime.done();
    await second.runtime.stop();

    expect(second.events[0]).toMatchObject({
      type: "ToolStarted",
      callId: "c1",
    });
    expect(second.events.at(-1)?.type).toBe("RunDone");
    const ids = new Set(
      [...first.events, ...second.events].map((e) => e.runId),
    );
    expect(ids).toEqual(new Set(["run-1"]));
  });

  it("AGENT_EVENT_TYPES lists every event type", () => {
    expectTypeOf<
      Exclude<AgentEvent<unknown>["type"], (typeof AGENT_EVENT_TYPES)[number]>
    >().toBeNever();
  });
});
