import { z } from "zod";
import { absurd } from "../index";
import {
  type AgentDomainEvent,
  type DefinedAgentState,
  defineAgent,
  type ToolResult,
  tool,
} from "./index";

const tick = tool(
  "tick",
  {
    description: "Settle one tick",
    input: z.object({}),
    ok: z.object({ ticked: z.literal(true) }),
    err: [],
  },
  async (_input, _ctx, { ok }) => ok({ ticked: true }),
);

interface Tally {
  readonly turns: number;
  readonly stage: "working" | "done";
}

const counted = defineAgent({
  model: async () => ({ content: "done", toolCalls: [] }),
  tools: [tick],
  instructions: "Tick.",
  domain: {
    init: (): Tally => ({ turns: 0, stage: "working" }),
    step: (slice, event) =>
      event._tag === "turn" ? { ...slice, turns: slice.turns + 1 } : slice,
  },
  stopWhen: (state) => {
    const tally: Tally = state.domain;
    return tally.stage === "done";
  },
  continueWhen: (state) => {
    const turns: number = state.domain.turns;
    return turns < 2 ? "again" : null;
  },
});

const [seeded] = counted.machine("go").machine.init(null, {});
const fromInit: Tally = seeded.domain;
void fromInit;

declare const plain: DefinedAgentState<typeof tick>;
// @ts-expect-error
void plain.domain;

const withSlice: DefinedAgentState<typeof tick, Tally> = {
  ...plain,
  domain: { turns: 1, stage: "working" },
};
void withSlice;

defineAgent({
  model: async () => ({ content: "done", toolCalls: [] }),
  tools: [tick],
  instructions: "Tick.",
  // @ts-expect-error
  stopWhen: (state) => state.domain === undefined,
});

defineAgent<typeof tick, Tally>(
  // @ts-expect-error
  {
    model: async () => ({ content: "done", toolCalls: [] }),
    tools: [tick],
    instructions: "Tick.",
  },
);

defineAgent(
  // @ts-expect-error
  {
    model: async () => ({ content: "done", toolCalls: [] }),
    tools: [tick],
    instructions: "Tick.",
    stopWhen: (state: DefinedAgentState<typeof tick, Tally>) =>
      state.domain.stage === "done",
  },
);

declare const event: AgentDomainEvent<ToolResult<typeof tick>>;
switch (event._tag) {
  case "turn":
    void event.turn.content;
    break;
  case "tool":
    void event.call.callId;
    void event.outcome.kind;
    break;
  case "nudge":
    void event.nudge.text;
    break;
  case "compaction":
    void event.folded;
    void event.summary.content;
    break;
  default:
    absurd(event);
}

switch (event._tag) {
  case "turn":
  case "tool":
  case "nudge":
    break;
  default:
    // @ts-expect-error
    absurd(event);
}
