export const toolParsedInputCases = [
  {
    id: "tool-parsed-input.edge.identity",
    input: { mode: "edge", scenario: "identity" },
  },
  {
    id: "tool-parsed-input.edge.error",
    input: { mode: "edge", scenario: "error" },
  },
  {
    id: "tool-parsed-input.edge.selected-ok",
    input: { mode: "edge", scenario: "selected-ok" },
  },
  {
    id: "tool-parsed-input.edge.selected-error",
    input: { mode: "edge", scenario: "selected-error" },
  },
  {
    id: "tool-parsed-input.runtime.promise",
    input: { mode: "runtime", scenario: "selected-ok", profile: "promise" },
  },
  {
    id: "tool-parsed-input.runtime.effect",
    input: { mode: "runtime", scenario: "selected-error", profile: "effect" },
  },
];
