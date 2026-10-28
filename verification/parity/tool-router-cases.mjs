const edge = (id, input) => ({
  id: `tool-router.edge.${id}`,
  input: { mode: "edge", ...input },
});
export const toolRouterCases = [
  edge("read-transform", {
    name: "read_invoice",
    args: { invoice: " inv-17 ", extra: 1 },
  }),
  edge("check", {
    name: "check_invoice",
    args: { lines: [4.5, 10.5], expected: 15 },
  }),
  edge("unknown", { name: "missing", args: {} }),
  edge("malformed-read", { name: "read_invoice", args: { invoice: 3 } }),
  edge("malformed-check", { name: "check_invoice", args: { lines: [3, "x"] } }),
  ...[
    "declared-return",
    "declared-raise",
    "error",
    "object",
    "string",
    "null",
    "undefined",
    "negative-output",
    "async-output",
    "content-error",
    "identity",
  ].map((scenario) =>
    edge(scenario, {
      name: "read_invoice",
      args: { invoice: "inv-17" },
      scenario,
    }),
  ),
  edge("async-input", {
    name: "read_invoice",
    args: { invoice: "inv-17" },
    scenario: "async-input",
  }),
  edge("no-content", {
    name: "check_invoice",
    args: { lines: [], expected: 0 },
  }),
  edge("forged-pure-name", {
    name: "read_invoice",
    args: { invoice: "inv-17" },
    scenario: "forged-pure",
  }),
  edge("foreign-name", {
    name: "read_invoice",
    args: { invoice: "inv-17" },
    scenario: "foreign-name",
  }),
  edge("duplicate", { declaration: "duplicate" }),
  ...[
    "agent_tool",
    "resilient",
    "resilient_run",
    "compact",
    "snapshot_write",
    "tool_rejected",
  ].map((name) => edge(`reserved-${name}`, { declaration: "reserved", name })),
  edge("resilience", {
    name: "read_invoice",
    args: { invoice: "inv-17" },
    resilience: true,
  }),
  ...["promise", "effect"].flatMap((profile) =>
    ["workflow", "declared-return", "error"].map((scenario) => ({
      id: `tool-router.runtime.${profile}.${scenario}`,
      input: { mode: "runtime", profile, scenario },
    })),
  ),
];
