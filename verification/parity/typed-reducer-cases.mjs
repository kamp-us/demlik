const pureScenarios = [
  "empty",
  "ordered",
  "reject-first",
  "reject-middle",
  "missing-first",
  "missing-middle",
  "nested-no-cell",
  "panic",
];
export const typedReducerCases = [
  ...["updates", "updates-shared", "msgs", "msgs-shared"].flatMap((verb) =>
    pureScenarios.map((scenario) => ({
      id: `typed-reducer.pure.${verb}.${scenario}`,
      input: { suite: "pure", verb, scenario },
    })),
  ),
  ...["promise", "effect"].flatMap((profile) =>
    ["stop", "escalate", "restart"].flatMap((policy) => [
      ...["declared", "nested-no-cell", "lookup"].flatMap((scenario) =>
        ["dispatch", "once"].map((verb) => ({
          id: `typed-reducer.actor.${profile}.${policy}.${scenario}.${verb}`,
          input: { suite: "actor", profile, policy, scenario, verb },
        })),
      ),
      ...["panic", "identity-drop", "identity-panic", "success"].map(
        (scenario) => ({
          id: `typed-reducer.actor.${profile}.${policy}.${scenario}.dispatch`,
          input: {
            suite: "actor",
            profile,
            policy,
            scenario,
            verb: "dispatch",
          },
        }),
      ),
    ]),
  ),
  ...["promise", "effect"].map((profile) => ({
    id: `typed-reducer.actor.${profile}.restart.rehydrate-panic.dispatch`,
    input: {
      suite: "actor",
      profile,
      policy: "restart",
      scenario: "rehydrate-panic",
      verb: "dispatch",
    },
  })),
];

export const invalidTypedReducerRequests = [
  "not json",
  JSON.stringify({ id: "invalid-suite", input: { suite: "other" } }),
  JSON.stringify({
    id: "invalid-verb",
    input: { suite: "pure", verb: "other", scenario: "empty" },
  }),
  JSON.stringify({
    id: "invalid-scenario",
    input: { suite: "pure", verb: "msgs", scenario: "other" },
  }),
];
