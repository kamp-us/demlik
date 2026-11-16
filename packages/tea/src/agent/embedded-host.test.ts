import { describe, expect, it } from "vitest";
import {
  type AgentEvent,
  type AgentMachineMsg,
  type AgentState,
  type AgentTurn,
  agentEvents,
  createAgent,
  type Schema,
  type ToolCall,
} from "./index";

// ---------------------------------------------------------------------------
// #355 — a host that embeds the agent's verbs in a machine of its own. The
// agent's outbox is emptied only on the way into one of its verbs, so a Msg the
// host folds itself leaves the previous agent transition's notes standing.
// `agentEvents` must not project them a second time.
// ---------------------------------------------------------------------------

type Purpose = "act";
interface Outputs extends Record<Purpose, AgentTurn> {
  readonly act: AgentTurn;
}
type ToolCmd = { readonly _tag: "run_tool" } & ToolCall;
type AgentMsg = AgentMachineMsg<Purpose, Outputs, string>;
type Agent = AgentState<string, Purpose, Outputs, string>;

const turnSchema: Schema<AgentTurn> = { parse: (v) => v as AgentTurn };
const ASK: AgentTurn = {
  content: "let me look",
  toolCalls: [{ callId: "c1", name: "search", args: { q: "x" } }],
};

const agent = createAgent<string, Purpose, Outputs, string, ToolCmd>({
  stages: ["only"],
  model: () => ({
    withStructuredOutput<T>(_s: Schema<T>) {
      return { invoke: async (): Promise<T> => ASK as T };
    },
  }),
  schemas: { act: turnSchema },
  turnOf: () => "act",
  toolOf: (c) => ({ _tag: "run_tool", ...c }),
  rng: () => 0,
});

// The host's Model holds the agent as one slice beside its own state, and its
// Msg union adds one Msg the agent never sees.
type Parent = { readonly agent: Agent; readonly ticks: number };
type ParentMsg =
  | { readonly _tag: "begin"; readonly runId: string; readonly at: number }
  | {
      readonly _tag: "brain_said";
      readonly turn: AgentTurn;
      readonly at: number;
    }
  | { readonly _tag: "parent_tick" };

// The host's reducer, wired by hand: its own Msgs reach the agent's verbs, and
// `parent_tick` touches only the host's own field.
function update(s: Parent, msg: ParentMsg): Parent {
  switch (msg._tag) {
    case "begin":
      return { ...s, agent: agent.start(s.agent, msg.runId, msg.at)[0] };
    case "brain_said":
      return { ...s, agent: agent.turn(s.agent, msg.turn, msg.at)[0] };
    case "parent_tick":
      return { ...s, ticks: s.ticks + 1 };
  }
}

/** Fold `msgs` from a fresh host, projecting each transition as a runtime would. */
function fold(msgs: readonly ParentMsg[]) {
  const project = agentEvents<string, Purpose, Outputs, string>();
  let state: Parent = { agent: agent.init(), ticks: 0 };
  const perTransition: (readonly AgentEvent<string>["_tag"][])[] = [];
  for (const msg of msgs) {
    state = update(state, msg);
    // The host hands its own Msg to the projector: none of these is one of
    // the agent's Msgs, so every event below comes off the outbox.
    const events = project(msg as unknown as AgentMsg, state.agent);
    perTransition.push(events.map((e) => e._tag));
  }
  return perTransition;
}

describe("#355 — agentEvents under a host that embeds the agent's verbs", () => {
  it("a parent-only Msg after an agent transition projects zero events", () => {
    const [started, tick] = fold([
      { _tag: "begin", runId: "r1", at: 1 },
      { _tag: "parent_tick" },
    ]);
    expect(started).toEqual(["BrainStarted"]);
    expect(tick).toEqual([]);
  });

  it("every note is still projected exactly once, parent Msgs interleaved", () => {
    expect(
      fold([
        { _tag: "begin", runId: "r1", at: 1 },
        { _tag: "parent_tick" },
        { _tag: "parent_tick" },
        { _tag: "brain_said", turn: ASK, at: 2 },
        { _tag: "parent_tick" },
      ]),
    ).toEqual([["BrainStarted"], [], [], ["ToolStarted"], []]);
  });
});
