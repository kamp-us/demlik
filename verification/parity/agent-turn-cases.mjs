const scenarios = [
  "normal",
  "duplicate",
  "stale-settlements",
  "fresh-boot",
  "terminal-boot",
  "bad-total",
  "tool-io-error",
  "model-error",
  "parse-error",
  "retry-once",
  "retry-exhaust",
  "restart-brain",
  "restart-tool",
  "restart-tool-io-error",
  "cancel",
  "late-tool-fail",
  "deadline",
];
const modes = [
  "array-args",
  "presence",
  "usage-missing",
  "usage-undefined",
  "usage-totals",
  "bare",
];
export const agentTurnCases = ["promise", "effect"].flatMap((profile) =>
  [
    ...scenarios.map((scenario) => ({ scenario, turnMode: "extras" })),
    ...modes.map((turnMode) => ({ scenario: "normal", turnMode })),
    ...[
      { scenario: "duplicate", turnMode: "array-args" },
      { scenario: "restart-tool", turnMode: "presence" },
      { scenario: "restart-tool", turnMode: "usage-missing" },
      { scenario: "cancel", turnMode: "usage-totals" },
    ],
  ].map((input) => ({
    id: `agent-turn.${profile}.${input.scenario}.${input.turnMode}`,
    input: { profile, ...input },
  })),
);
