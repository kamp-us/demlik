/**
 * #145 — a `callId` the ladder already settled is silent on EVERY public
 * channel.
 *
 * The fan-out has always dropped a late handler result: `forget(slice, key)`
 * removes the bookkeeping at settle time, so the late `_ok` folds nothing. But
 * "folds nothing" and "emits nothing" are two different facts, and the event
 * projector only had the first one. It is Msg-shaped — it pushed `ToolSettled`
 * off the settle Msg alone — so the exact late success the fold ignored still
 * reached `onEvent`, for a `callId` `onToolError` had already reported as
 * `{ _tag: "timeout" }`. A UI on `onEvent` showed a success for a call the
 * model was told had failed.
 *
 * The discriminator is `state.refusedCalls`, written at the one settle body
 * every failure passes through. It has to be carried rather than derived: the
 * projector reads the POST-transition state, by which point the ladder has
 * forgotten the key, and a presence check cannot tell "settled OK just now"
 * from "settled by the ladder earlier".
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { memoryStore } from "../mem";
import {
  type AgentEvent,
  type AgentMachineMsg,
  type AgentTurn,
  agentEvents,
  createAgent,
  defineAgent,
  type Schema,
  type ToolCall,
  tool,
  toolRouter,
} from "./index";

// ---------------------------------------------------------------------------
// The pure half: `agentEvents` itself, one arm at a time. Both settle arms get
// the same Msg twice and differ only in the state's `refusedCalls`, so the
// guard is pinned per arm with no scheduling in the assertion at all.
// ---------------------------------------------------------------------------

type Stage = "act";
type Purpose = "act_turn";
interface Outputs extends Record<Purpose, AgentTurn> {
  readonly act_turn: AgentTurn;
}
type ToolCmd = { readonly type: "run_tool" } & ToolCall;
type M = AgentMachineMsg<Purpose, Outputs, string>;

const turnSchema: Schema<AgentTurn> = { parse: (v) => v as AgentTurn };
const turnWith = (...calls: ToolCall[]): AgentTurn => ({
  content: "thinking",
  toolCalls: calls,
});

function makeAgent(turns: readonly AgentTurn[]) {
  let i = 0;
  const model = () => ({
    withStructuredOutput<T>(_s: Schema<T>) {
      return {
        invoke: (async () => turns[i++] ?? turnWith()) as () => Promise<T>,
      };
    },
  });
  return createAgent<Stage, Purpose, Outputs, string, ToolCmd, string>({
    stages: ["act"],
    model,
    schemas: { act_turn: turnSchema },
    turnOf: () => "act_turn",
    toolOf: (c) => ({ type: "run_tool", ...c }),
    toolConcurrency: 2,
    rng: () => 0,
  });
}

describe("#145 — the projector refuses a settled call's late success", () => {
  it("the fan-out-settled arm emits only while the call is not refused", () => {
    const project = agentEvents<Stage, Purpose, Outputs, string>();
    const base = makeAgent([]).init();
    const lateOk: M = {
      type: "agent_tool_ok",
      callId: "c1",
      result: "late",
      at: 2,
    };

    // Same Msg, two states: the only difference is whether this call's public
    // outcome is already a failure.
    expect(project(lateOk, { ...base, refusedCalls: [] })).toEqual([
      { type: "ToolSettled", callId: "c1", result: "late" },
    ] satisfies AgentEvent<string>[]);
    expect(project(lateOk, { ...base, refusedCalls: ["c1"] })).toEqual([]);
  });

  it("the router-settled arm is guarded identically", () => {
    const navigate = tool(
      "navigate",
      {
        description: "goes",
        input: z.object({}),
        ok: z.object({ at: z.string() }),
        err: [],
      },
      async (_a, _c, { ok }) => ok({ at: "home" }),
    );
    const router = toolRouter([navigate]);
    const project = agentEvents<
      Stage,
      Purpose,
      Outputs,
      { readonly at: string },
      typeof navigate
    >({ tools: router });
    const base = makeAgent([]).init() as never as Parameters<typeof project>[1];
    const okMsg = {
      type: navigate.okType,
      cmd: { callId: "c1", args: {} },
      value: { at: "home" },
    } as never as Parameters<typeof project>[0];

    // Same Msg, two states: the only difference is whether the call's public
    // outcome is already a failure.
    expect(project(okMsg, { ...base, refusedCalls: [] })).toEqual([
      { type: "ToolSettled", callId: "c1", result: { at: "home" } },
    ] satisfies AgentEvent<{ readonly at: string }>[]);
    expect(project(okMsg, { ...base, refusedCalls: ["c1"] })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The lid half: the `late.ts` shape the report describes, end to end through
// `defineAgent`. A handler outlives its `timeoutMs`, the ladder settles
// `timeout`, and the handler then succeeds.
// ---------------------------------------------------------------------------

const slow = tool(
  "slow",
  {
    description: "resolves long after its budget",
    input: z.object({}),
    ok: z.object({ late: z.boolean() }),
    err: [],
    timeoutMs: 10,
  },
  async (_a, _c, { ok }) => {
    await new Promise((r) => setTimeout(r, 40));
    return ok({ late: true });
  },
);

const keepalive = tool(
  "keepalive",
  {
    description: "holds the run open past the late settle",
    input: z.object({}),
    ok: z.object({ held: z.boolean() }),
    err: [],
  },
  async (_a, _c, { ok }) => {
    await new Promise((r) => setTimeout(r, 200));
    return ok({ held: true });
  },
);

/** A turn calling `name` once under `callId`. */
const asks = (name: string, callId: string): AgentTurn => ({
  content: "working",
  toolCalls: [{ callId, name, args: {} }],
});

describe("#145 — onToolError and onEvent never disagree for one callId", () => {
  it("a handler that succeeds after its timeout emits no ToolSettled", async () => {
    const turns = [asks("slow", "c1"), asks("keepalive", "c2")];
    let i = 0;
    const model = async () =>
      turns[i++] ?? { content: "done", toolCalls: [] as ToolCall[] };

    const failed: string[] = [];
    const succeeded: string[] = [];
    const agent = defineAgent({
      model,
      tools: [slow, keepalive],
      instructions: "i",
      onToolError: (_f, { callId }) => {
        failed.push(callId);
      },
    });
    await agent.run("go", {
      store: memoryStore(),
      onEvent: (e) => {
        if (e.type === "ToolSettled") succeeded.push(e.callId);
      },
    });

    // The `keepalive` call is the only success the seam reports: `c1`'s late
    // `ok` arrives while the run is still live (that is what `keepalive` holds
    // it open for) and is refused.
    expect(failed).toEqual(["c1"]);
    expect(succeeded).toEqual(["c2"]);
    // The property the report is actually about: no callId carries both a
    // failure and a success across the two channels.
    expect(failed.filter((id) => succeeded.includes(id))).toEqual([]);
  });
});
