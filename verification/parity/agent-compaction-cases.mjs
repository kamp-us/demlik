const turn = (id) => ({
  op: "turn",
  at: 1,
  turn: {
    content: `turn:${id}`,
    toolCalls: [
      {
        callId: id,
        name: "collect",
        args: { invoice: "inv-17", unknownArg: [1, null] },
        unknownCall: { kept: true },
      },
    ],
    usage: { inputTokens: 7, outputTokens: 2 },
    unknownTurn: { kept: true },
  },
});
const settle = (id, at) => ({
  op: "toolOk",
  id,
  result: { id, total: 15 },
  at,
});
const history = (n = 2) => [
  { op: "start", at: 0 },
  ...Array.from({ length: n }, (_, i) => [
    { ...turn(`c${i + 1}`), at: i * 2 + 1 },
    settle(`c${i + 1}`, i * 2 + 2),
  ]).flat(),
];
const ok = (at = 7) => ({
  op: "compactOk",
  output: { summary: "invoice summary", unknownSummary: { kept: true } },
  at,
});
const err = (at = 7) => ({
  op: "compactErr",
  cause: { provider: "local", extra: [1, null] },
  at,
});
const pure = (name, config, actions, expected) => ({
  id: `agent-compaction.pure.${name}`,
  input: { mode: "pure", config, actions },
  expected,
});
export const agentCompactionCases = [
  pure("skip-zero", { folding: 0 }, history(), {
    awaiting: "llm",
    lastTags: ["resilient_run"],
    turnCount: 2,
  }),
  pure("skip-one", { folding: 1 }, history(), {
    awaiting: "llm",
    lastTags: ["resilient_run"],
    turnCount: 2,
  }),
  pure("dedicated-two", {}, history(), {
    awaiting: "compacting",
    lastTags: ["compact_run"],
    turnCount: 2,
  }),
  pure("clamp", { folding: 999 }, history(), {
    awaiting: "compacting",
    folding: 2,
    lastTags: ["compact_run"],
  }),
  pure("infinite", { folding: "Infinity" }, [...history(), ok()], {
    turns: 1,
    records: 0,
    turnCount: 2,
    contextTokens: null,
  }),
  pure("negative-infinite", { folding: "-Infinity" }, history(), {
    awaiting: "llm",
    lastTags: ["resilient_run"],
  }),
  pure("fractional", { folding: 2.5, threshold: 3 }, [...history(3), ok()], {
    turns: 2,
    records: 0,
    turnCount: 3,
    contextTokens: null,
  }),
  pure("nan-live", { folding: "NaN" }, [...history(), ok()], {
    turns: 3,
    records: 0,
    turnCount: 2,
  }),
  pure(
    "nan-json-null",
    { folding: "NaN" },
    [...history(), { op: "roundTrip" }, { op: "boot", at: 50 }, ok(51)],
    { turns: 3, records: 2, turnCount: 2 },
  ),
  pure("stop-first", { maxTurns: 2 }, history(), {
    failure: "turn_limit",
    lastTags: [],
  }),
  pure("success-partial", { folding: 2, threshold: 3 }, [...history(3), ok()], {
    turns: 2,
    records: 1,
    turnCount: 3,
  }),
  pure("success-all", { folding: 3, threshold: 3 }, [...history(3), ok()], {
    turns: 1,
    records: 0,
    turnCount: 3,
  }),
  pure("failure-resumes", {}, [...history(), err()], {
    awaiting: "llm",
    turns: 2,
    lastTags: ["resilient_run"],
  }),
  pure(
    "retry-timer",
    { retry: 3 },
    [
      ...history(),
      err(),
      { op: "timer", id: "resilient:retry:$compact", at: 10 },
      ok(11),
    ],
    { turns: 1, lastTags: ["resilient_run"] },
  ),
  pure("boot-running", {}, [...history(), { op: "boot", at: 50 }], {
    awaiting: "compacting",
    lastTags: ["compact_run"],
  }),
  pure(
    "boot-waiting",
    { retry: 3 },
    [...history(), err(), { op: "boot", at: 50 }],
    { awaiting: "compacting", lastTags: ["compact_run"] },
  ),
  pure("late-success", {}, [...history(), { op: "cancel", at: 7 }, ok(8)], {
    phase: "cancelled",
    turns: 2,
    lastTags: [],
  }),
  pure(
    "late-error-arms-retry",
    { retry: 3 },
    [...history(), { op: "cancel", at: 7 }, err(8)],
    { phase: "cancelled", turns: 2, retry: true, lastTags: [] },
  ),
  pure(
    "shared-rng-independent-slices",
    { retry: 3 },
    [
      { op: "start", at: 0 },
      { op: "brainErr", cause: { brain: true }, at: 1 },
      { op: "timer", id: "resilient:retry:invoice", at: 5 },
      ...history().slice(1),
      err(),
    ],
    { brainRetry: 1, compactRetry: 1, rngDraws: 2 },
  ),
  ...["promise", "effect"].flatMap((profile) =>
    ["normal", "retry", "exhaust", "cancel-late-ok", "cancel-late-error"].map(
      (scenario) => ({
        id: `agent-compaction.${profile}.${scenario}`,
        input: {
          mode: "runtime",
          profile,
          scenario,
          config: { retry: scenario === "exhaust" ? 1 : 3 },
        },
        expected: {
          terminal: !scenario.startsWith("cancel"),
          cancelled: scenario.startsWith("cancel"),
        },
      }),
    ),
  ),
  ...["promise", "effect"].map((profile) => ({
    id: `agent-compaction.${profile}.cold`,
    cold: true,
    input: { profile, scenario: "normal", config: { retry: 3 } },
    expected: { writerCounts: [2, 2, 1], readerCounts: [1, 0, 1] },
  })),
];
export const compactionAuthoringGate = [
  {
    contract: "dedicated compact route after stop/drain",
    regression: "brain handler receives compact request",
    existingGap: "old runtime cannot emit compact_run",
    seam: "actual Agent::to_machine",
  },
  {
    contract: "fold retains right transcript/handles/count/usage",
    regression: "wrong fold index or compaction increments reasoning count",
    existingGap:
      "helper tests never trigger/fold through actual compact message",
    seam: "public compact_ok and real loader",
  },
  {
    contract: "independent retry state with one owned RNG and timer routing",
    regression: "reset/share brain retry or use fresh RNG",
    existingGap: "single ResilientCall tests cannot see two composed slices",
    seam: "Agent verbs/subs/runtime timers",
  },
  {
    contract: "commandless cold ready and explicit Boot",
    regression: "run compact in init or never resume retained work",
    existingGap: "old cold cases do not contain compacting state",
    seam: "actual fileStore and fresh processes",
  },
];
