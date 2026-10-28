export const toolRouterSameNameCases = [
  ...["ok", "error"].map((scenario) => ({
    id: `tool-router.same-name.${scenario}`,
    input: { mode: "same-name", scenario },
  })),
];
