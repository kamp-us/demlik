const call = (callId) => ({
  callId,
  name: "invoice",
  args: { invoice: callId },
});
const turn = {
  content: "check invoices",
  toolCalls: [call("c1"), call("c2"), call("c3")],
};
const start = { op: "start", at: 10 };
const cfg = (failAt, concurrency = 2, policy = false) => ({
  failAt,
  concurrency,
  policy,
});
const agent = (id, config, actions) => ({
  id,
  kind: "agent",
  config,
  actions: [start, ...actions],
});
export const cases = [
  {
    id: "fan.scatter-first",
    kind: "fan",
    config: cfg(1, 3),
    actions: [{ op: "scatter", ids: ["c1", "c2", "c3"] }],
  },
  {
    id: "fan.scatter-prefix",
    kind: "fan",
    config: cfg(2, 3),
    actions: [{ op: "scatter", ids: ["c1", "c2", "c3"] }],
  },
  {
    id: "fan.backfill-prefix",
    kind: "fan",
    config: cfg(3, 2),
    actions: [
      { op: "scatter", ids: ["c1", "c2", "c3"] },
      { op: "ok", id: "c1" },
    ],
  },
  agent("agent.turn-discarded", cfg(2), [{ op: "turn", at: 11, turn }]),
  agent("agent.succeed-second-sweep", cfg(4), [
    { op: "succeed", at: 11, turn },
  ]),
  agent("agent.backfill-ok-discarded", cfg(3, 1), [
    { op: "turn", at: 11, turn },
    { op: "toolOk", at: 12, id: "c1" },
  ]),
  agent("agent.backfill-err-second-sweep", cfg(4, 1), [
    { op: "turn", at: 11, turn },
    { op: "toolErr", at: 12, id: "c1" },
  ]),
  agent("agent.boot-running", cfg(6), [
    { op: "turn", at: 11, turn },
    { op: "boot", at: 20 },
  ]),
  agent("agent.boot-waiting-skip", cfg(3, 1, true), [
    { op: "turn", at: 11, turn: { content: "one", toolCalls: [call("c1")] } },
    { op: "toolErr", at: 12, id: "c1" },
    { op: "boot", at: 13 },
  ]),
  agent("agent.timer-retry", cfg(3, 1, true), [
    { op: "turn", at: 11, turn: { content: "one", toolCalls: [call("c1")] } },
    { op: "toolErr", at: 12, id: "c1" },
    { op: "timer", at: 17, id: "resilient:retry:$tool:invoice#c1" },
  ]),
  {
    id: "runtime.promise",
    kind: "runtime",
    profile: "promise",
    config: cfg(2),
    actions: [{ op: "turn", at: 11, turn }],
  },
  {
    id: "runtime.effect",
    kind: "runtime",
    profile: "effect",
    config: cfg(2),
    actions: [{ op: "turn", at: 11, turn }],
  },
];
