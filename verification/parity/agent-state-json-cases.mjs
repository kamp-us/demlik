export const agentStateJsonCases = ["promise", "effect"].flatMap((profile) =>
  ["brain", "tools", "tool-error", "done", "model-error", "guard-error"].map(
    (checkpoint) => ({
      id: `agent-state-json.${profile}.${checkpoint}`,
      input: { profile, checkpoint },
    }),
  ),
);
