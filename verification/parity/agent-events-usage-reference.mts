import assert from "node:assert/strict";
import {
  type AgentMachineMsg,
  type AgentTurn,
  agentEvents,
  agentTurnSchema,
  createAgent,
  type Schema,
  type ToolCall,
  type TurnUsage,
  transcript,
} from "../../packages/tea/src/agent/index.ts";

const usage: TurnUsage = {
  inputTokens: 17,
  outputTokens: 5,
  reasoningTokens: 2,
  cachedInputTokens: 3,
};
const turn: AgentTurn = { content: "invoice checked", toolCalls: [], usage };
type Outputs = { invoice: AgentTurn };
type Tool = { readonly type: "invoice_io"; readonly call: ToolCall };
const agent = createAgent<null, "invoice", Outputs, string, Tool, string>({
  stages: [null],
  turnOf: () => "invoice",
  toolOf: (call) => ({ type: "invoice_io", call }),
  schemas: { invoice: agentTurnSchema },
  model: () => ({
    withStructuredOutput<T>(schema: Schema<T>) {
      return { invoke: async () => schema.parse(turn) };
    },
  }),
  rng: () => 0,
});
const [started, commands] = agent.start(agent.init(), "invoice-usage", 11);
const command = commands.find((cmd) => cmd.type === "resilient_run");
assert.ok(command);
const message: AgentMachineMsg<"invoice", Outputs, string> = {
  type: "resilient_run_ok",
  cmd: command,
  value: {
    key: "invoice",
    purpose: "invoice",
    output: agentTurnSchema.parse(turn),
  },
  at: 17,
};
const [next] = agent.succeed(started, message, 17);
const project = agentEvents<null, "invoice", Outputs, string>();
const events = project(message, next);
assert.deepEqual(
  events.map((event) => event.type),
  ["TurnSettled", "RunDone"],
);
const settled = events.find((event) => event.type === "TurnSettled");
assert.ok(settled);
assert.equal(settled.turn, turn);
assert.equal(settled.usage, usage);
assert.equal(settled.usage, settled.turn.usage);
const collector = transcript<string>();
for (const event of events) collector.onEvent(event);
const snapshot = collector.read();
assert.equal(snapshot.turns[0], turn);
assert.equal(snapshot.turns[0].usage, usage);
console.log(
  JSON.stringify({
    input: {
      id: "present-usage-preserves-original-owner",
      runId: "invoice-usage",
      startAt: 11,
      settledAt: 17,
      turn,
    },
    output: {
      events,
      transcript: snapshot,
      checks: {
        usageChecks: 1,
        usageSame: true,
        turnChecks: 1,
        turnSame: true,
        transcriptUsageChecks: 1,
        transcriptUsageSame: true,
      },
    },
  }),
);
