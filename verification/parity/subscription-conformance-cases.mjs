export const subscriptionScenarios = [
  "fresh",
  "storeless",
  "stored",
  "recover",
  "two-failures",
  "boot-projection",
  "stored-projection",
  "load-failure",
  "migrate-refusal",
  "migrate-throw",
  "boot-save-failure",
  "step-save-failure",
  "mixed-runner",
  "mixed-cleanup",
  "mixed-all",
  "held-load",
  "held-load-dispatch",
  "held-save",
  "held-save-projection",
  "held-cleanup",
];
export const subscriptionCases = [];
for (const profile of ["promise", "effect"]) {
  for (const scenario of subscriptionScenarios) {
    subscriptionCases.push({
      id: `subscription.${profile}.${scenario}`,
      input: {
        profile,
        scenario,
        policy: "stop",
        origin: "caller",
        verb: "dispatch",
      },
    });
  }
  for (const policy of ["escalate", "restart"])
    for (const scenario of ["recover", "two-failures", "boot-projection"]) {
      subscriptionCases.push({
        id: `subscription.${profile}.${scenario}.${policy}`,
        input: {
          profile,
          scenario,
          policy,
          origin: "caller",
          verb: "dispatch",
        },
      });
    }
  for (const scenario of [
    "recover",
    "two-failures",
    "boot-projection",
    "mixed-runner",
    "mixed-cleanup",
  ]) {
    subscriptionCases.push({
      id: `subscription.${profile}.${scenario}.producer`,
      input: {
        profile,
        scenario,
        policy: "restart",
        origin: "producer",
        verb: "dispatch",
      },
    });
  }
  for (const scenario of ["recover", "two-failures", "step-save-failure"]) {
    subscriptionCases.push({
      id: `subscription.${profile}.${scenario}.once`,
      input: {
        profile,
        scenario,
        policy: "escalate",
        origin: "caller",
        verb: "once",
      },
    });
  }
}
export const invalidSubscriptionRequests = [
  {
    id: "invalid-profile",
    input: { ...subscriptionCases[0].input, profile: "other" },
  },
  {
    id: "invalid-origin",
    input: { ...subscriptionCases[0].input, origin: "drop-future" },
  },
  {
    id: "extra-field",
    input: { ...subscriptionCases[0].input, loaded: { n: 1 } },
  },
  {
    id: "invalid-verb",
    input: { ...subscriptionCases[0].input, verb: "ignore" },
  },
];
