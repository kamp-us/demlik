export const agentRuntimeCases = ["promise", "effect"].flatMap((profile) =>
  [
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
  ].map((scenario) => ({
    id: `agent-runtime.${profile}.${scenario}`,
    input: { profile, scenario },
  })),
);
