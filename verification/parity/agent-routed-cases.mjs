export const scenarios = [
  "invoice",
  "declared",
  "thrown",
  "rejected",
  "malformed-args",
  "bad-result",
  "selected-B",
  "cold-pending",
  "cancel-late",
  "map-refusal",
];
export const agentRoutedCases = ["promise", "effect"].flatMap((profile) =>
  scenarios.map((scenario) => ({
    id: `agent-routed.${profile}.${scenario}`,
    profile,
    scenario,
  })),
);
