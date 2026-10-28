export const toolRouterEmptyCases = [
  { id: "tool-router.empty.edge", input: { mode: "empty", scenario: "edge" } },
  ...["promise", "effect"].map((profile) => ({
    id: `tool-router.empty.runtime.${profile}`,
    input: { mode: "empty", scenario: "runtime", profile },
  })),
];
