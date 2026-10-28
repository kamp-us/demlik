const count = (maxAttempts = 3, extra = {}) => ({
  baseMs: 10,
  factor: 1,
  capMs: 100,
  jitter: "none",
  maxAttempts,
  ...extra,
});
const duration = (maxElapsedMs, extra = {}) => ({
  baseMs: 10,
  factor: 1,
  capMs: 100,
  jitter: "none",
  maxElapsedMs,
  ...extra,
});
const unbounded = {
  baseMs: 10,
  factor: 1,
  capMs: 100,
  jitter: "none",
  unbounded: true,
};
const start = { op: "start", at: 0 };
const call = (id, name = "lookup") => ({
  callId: id,
  name,
  args: { invoice: "inv-17", retained: [id, null] },
});
const turn = (...calls) => ({
  op: "turn",
  at: 1,
  turn: {
    content: "collect invoice",
    toolCalls: calls,
    extra: { retained: true },
  },
});
const ok = (id, at = 3) => ({
  op: "toolOk",
  id,
  at,
  result: { invoice: "inv-17", total: 15 },
});
const err = (
  id,
  at = 2,
  error = {
    _tag: "offline",
    reason: "local outage",
    kind: "error",
    code: 503,
    context: { retained: true },
  },
) => ({ op: "toolErr", id, at, error });
const timer = (id, at) => ({ op: "timer", id, at });
const rule = (policy, name = "lookup", callId) => ({
  name,
  ...(callId === undefined ? {} : { callId }),
  policy,
});
const row = (id, policies, actions, extra = {}, anchor = {}) => ({
  id: `agent-tool-policy.pure.${id}`,
  input: {
    mode: "pure",
    config: { policies, ...extra },
    actions: [start, ...actions],
  },
  anchor,
});
export const toolPolicyCases = [
  row("omitted", [], [turn(call("a")), ok("a")], { omitSelector: true }),
  row("none", [], [turn(call("a")), ok("a")]),
  row("empty", [rule({})], [turn(call("a")), ok("a")]),
  row("timeout-ok", [rule({ timeoutMs: 20 })], [turn(call("a")), ok("a")]),
  row(
    "timeout-original-failure",
    [rule({ timeoutMs: 20 })],
    [turn(call("a")), err("a")],
  ),
  row(
    "hidden-retry",
    [rule({ retry: count() })],
    [turn(call("a")), err("a")],
    {},
    { records: 0, running: 1 },
  ),
  row(
    "retry-recover",
    [rule({ retry: count() })],
    [
      turn(call("a")),
      err("a"),
      timer("resilient:retry:$tool:lookup#a", 12),
      ok("a", 13),
    ],
  ),
  row(
    "retry-exhaust",
    [rule({ retry: count(2) })],
    [
      turn(call("a")),
      err("a"),
      timer("resilient:retry:$tool:lookup#a", 12),
      err("a", 13),
    ],
    {},
    { refused: ["a"] },
  ),
  row("zero-count", [rule({ retry: count(0) })], [turn(call("a")), err("a")]),
  row(
    "duration-zero",
    [rule({ retry: duration(0) })],
    [turn(call("a")), err("a")],
  ),
  row(
    "duration-exhaust",
    [rule({ retry: duration(10) })],
    [
      turn(call("a")),
      err("a"),
      timer("resilient:retry:$tool:lookup#a", 12),
      err("a", 13),
    ],
  ),
  row(
    "unbounded",
    [rule({ retry: unbounded })],
    [
      turn(call("a")),
      err("a"),
      timer("resilient:retry:$tool:lookup#a", 12),
      err("a", 13),
      timer("resilient:retry:$tool:lookup#a", 23),
      err("a", 24),
    ],
  ),
  row(
    "independent-same-name",
    [rule({ retry: count(), timeoutMs: 50 })],
    [
      turn(call("a"), call("b")),
      err("a"),
      ok("b"),
      timer("resilient:retry:$tool:lookup#a", 12),
      ok("a", 13),
    ],
    { concurrency: 2 },
  ),
  row(
    "queued-backfill",
    [rule({ timeoutMs: 10 })],
    [
      turn(call("a"), call("b"), call("c")),
      timer("resilient:deadline:$tool:lookup#a", 11),
      ok("b", 12),
      ok("c", 13),
    ],
    { concurrency: 1 },
  ),
  row(
    "timeout-late-success",
    [rule({ timeoutMs: 10 })],
    [
      turn(call("a")),
      timer("resilient:deadline:$tool:lookup#a", 11),
      ok("a", 12),
    ],
    {},
    { refused: ["a"] },
  ),
  row(
    "cancel-waiting-late",
    [rule({ retry: count(), timeoutMs: 30 })],
    [
      turn(call("a")),
      err("a"),
      { op: "cancel", at: 3 },
      ok("a", 4),
      timer("resilient:retry:$tool:lookup#a", 12),
    ],
  ),
  row(
    "cancel-running-late-error",
    [rule({ retry: count(), timeoutMs: 30 })],
    [
      turn(call("a")),
      { op: "cancel", at: 2 },
      err("a", 3),
      timer("resilient:retry:$tool:lookup#a", 13),
    ],
  ),
  row(
    "stale-tool-timers",
    [rule({ timeoutMs: 10 })],
    [
      turn(call("a")),
      timer("resilient:retry:$tool:missing#z", 2),
      timer("resilient:deadline:$tool:lookup#z", 3),
      ok("a", 4),
    ],
  ),
  row(
    "empty-name-key",
    [rule({ timeoutMs: 10 }, "")],
    [
      turn(call("a", "")),
      timer("resilient:deadline:$tool:#a", 11),
      ok("a", 12),
    ],
  ),
  row(
    "name-hash-key",
    [rule({ timeoutMs: 10 }, "x#y")],
    [
      turn(call("a", "x#y")),
      timer("resilient:deadline:$tool:x#y#a", 11),
      ok("a", 12),
    ],
  ),
  row(
    "call-hash-key",
    [rule({ timeoutMs: 10 })],
    [
      turn(call("a#b")),
      timer("resilient:deadline:$tool:lookup#a#b", 11),
      ok("a#b", 12),
    ],
  ),
  row(
    "raw-utf16-key",
    [rule({ timeoutMs: 10 }, "raw\ud800")],
    [
      turn(call("id\udfff", "raw\ud800")),
      timer("resilient:deadline:$tool:raw\ud800#id\udfff", 11),
    ],
  ),
  row(
    "numeric-name-enumeration",
    [
      rule({ timeoutMs: 20 }, "10"),
      rule({ timeoutMs: 30 }, "2"),
      rule({ timeoutMs: 40 }, "a"),
    ],
    [turn(call("x", "10"), call("y", "a"), call("z", "2"))],
    { concurrency: 3 },
  ),
  row(
    "boot-running-resume",
    [rule({ timeoutMs: 20 })],
    [turn(call("a")), { op: "roundTrip" }, { op: "boot", at: 500 }],
    {},
    { running: 1 },
  ),
  row(
    "boot-waiting-no-extra",
    [rule({ retry: count(), timeoutMs: 20 })],
    [
      turn(call("a")),
      err("a"),
      { op: "roundTrip" },
      { op: "boot", at: 500 },
      timer("resilient:retry:$tool:lookup#a", 501),
    ],
  ),
  row(
    "boot-spent-no-io",
    [rule({ timeoutMs: 20 })],
    [
      turn(call("a")),
      { op: "remaining", name: "lookup", id: "a", value: 0 },
      { op: "roundTrip" },
      { op: "boot", at: 500 },
    ],
  ),
  row(
    "cold-policy-removed",
    [rule({ timeoutMs: 20, retry: count() })],
    [
      turn(call("a")),
      err("a"),
      { op: "cold", config: { omitSelector: true, policies: [] } },
      { op: "boot", at: 500 },
      ok("a", 501),
    ],
  ),
  row(
    "cold-policy-none",
    [rule({ timeoutMs: 20, retry: count() })],
    [
      turn(call("a")),
      err("a"),
      { op: "cold", config: { policies: [] } },
      { op: "boot", at: 500 },
      err("a", 501),
    ],
  ),
  row(
    "cold-policy-changed",
    [rule({ timeoutMs: 20 })],
    [
      turn(call("a")),
      {
        op: "cold",
        config: { policies: [rule({ timeoutMs: 100, retry: count(1) })] },
      },
      { op: "boot", at: 500 },
      err("a", 501),
    ],
  ),
  row(
    "cached-name-none-other-call",
    [rule({ timeoutMs: 20 }, "lookup", "a"), rule(null, "lookup", "b")],
    [turn(call("a"), call("b")), ok("a", 2), ok("b", 3)],
    { concurrency: 2 },
  ),
  row(
    "cached-name-different-policy",
    [
      rule({ timeoutMs: 20 }, "lookup", "a"),
      rule({ timeoutMs: 100 }, "lookup", "b"),
    ],
    [turn(call("a"), call("b"))],
    { concurrency: 2 },
  ),
  row(
    "cache-survives-forget",
    [
      rule({ timeoutMs: 20 }, "lookup", "a"),
      rule({ timeoutMs: 100 }, "lookup", "b"),
    ],
    [turn(call("a")), ok("a", 2), { ...turn(call("b")), at: 3 }],
  ),
  row(
    "timeout-zero",
    [rule({ timeoutMs: 0 })],
    [turn(call("a")), { op: "boot", at: 2 }],
  ),
  row(
    "timeout-negative",
    [rule({ timeoutMs: -1 })],
    [turn(call("a")), { op: "boot", at: 2 }],
  ),
  row(
    "timeout-infinite",
    [rule({ timeoutMs: "Infinity" })],
    [turn(call("a")), ok("a")],
  ),
  row(
    "timeout-nan-cold-null",
    [rule({ timeoutMs: "NaN" })],
    [turn(call("a")), { op: "roundTrip" }, { op: "boot", at: 500 }],
  ),
  row(
    "rng-only-on-failure",
    [rule({ retry: count(3, { jitter: "full" }), timeoutMs: 50 })],
    [
      turn(call("a")),
      { op: "readSubs" },
      { op: "readSubs" },
      err("a"),
      { op: "readSubs" },
      timer("resilient:retry:$tool:lookup#a", 4.5),
      err("a", 5),
      timer("resilient:retry:$tool:lookup#a", 12.5),
      ok("a", 13),
    ],
  ),
  row(
    "inherited-name-refusal",
    [rule({ timeoutMs: 10 }, "constructor")],
    [turn(call("a", "constructor"))],
  ),
  row(
    "original-null-reason-field",
    [rule({ retry: count(1) })],
    [
      turn(call("a")),
      err("a", 2, { _tag: "declined", kind: "error", reason: null, code: 7 }),
    ],
  ),
  row(
    "three-stage-workflow",
    [rule({ retry: count(), timeoutMs: 50 })],
    [
      turn(call("a")),
      err("a"),
      timer("resilient:retry:$tool:lookup#a", 12),
      ok("a", 13),
      { op: "turn", at: 14, turn: { content: "collected", toolCalls: [] } },
      { ...turn(call("b")), at: 15 },
      ok("b", 16),
      { op: "turn", at: 17, turn: { content: "checked", toolCalls: [] } },
      {
        op: "turn",
        at: 18,
        turn: { content: "invoice summarized", toolCalls: [] },
      },
    ],
    {},
    { phase: "done" },
  ),
];
export const toolPolicyRuntimeCases = ["promise", "effect"].flatMap((profile) =>
  [
    "retry-recover",
    "retry-exhaust",
    "timeout-late",
    "cancel-waiting",
    "none",
    "empty",
  ].map((scenario) => ({
    id: `agent-tool-policy.runtime.${profile}.${scenario}`,
    input: { mode: "runtime", profile, scenario },
  })),
);
export const toolPolicyColdCases = ["promise", "effect"].map((profile) => ({
  id: `agent-tool-policy.cold.${profile}`,
  input: { mode: "cold", profile, scenario: "waiting-retry" },
}));

// Raw JS observation, outside ToolFailure.reason:string. Keep its original trace, no strict evidence.
toolPolicyCases.find((c) =>
  c.id.endsWith("original-null-reason-field"),
).qualifications = ["raw-null-reason"];
