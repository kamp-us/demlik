const stage = (name) => ({ name });
const done = (text = "done", usage) => ({
  content: text,
  toolCalls: [],
  ...(usage ? { usage } : {}),
});
const ask = (...ids) => ({
  content: "working",
  toolCalls: ids.map((callId) => ({ callId, name: "scan", args: { callId } })),
});
export function baseCases() {
  const out = [],
    add = (id, actions, config = {}, qualification) =>
      out.push({
        id: `agent-base.${id}`,
        script: { config, actions },
        ...(qualification ? { qualification } : {}),
      });
  add(
    "three-stage-audit",
    [
      { op: "start", at: 0 },
      { op: "succeed", at: 1, turn: ask("a", "a", "b") },
      { op: "toolOk", at: 2, id: "a", result: { document: "retained" } },
      {
        op: "toolErr",
        at: 3,
        id: "b",
        error: {
          kind: "error",
          reason: "offline",
          _tag: "network",
          detail: { "\ud800": 4 },
        },
      },
      {
        op: "succeed",
        at: 4,
        turn: done("collected", { inputTokens: 5, outputTokens: 2 }),
      },
      {
        op: "succeed",
        at: 5,
        turn: done("checked", { inputTokens: 3, outputTokens: 1 }),
      },
      { op: "roundtrip" },
      { op: "boot", at: 100 },
      {
        op: "succeed",
        at: 101,
        turn: done("report", { inputTokens: 7, outputTokens: 2 }),
      },
      { op: "start", at: 200, runId: "restart" },
    ],
    { deadlineMs: 10, instructions: "audit\ud800" },
  );
  for (const stages of [
    [],
    [stage("collect")],
    [stage("collect"), stage("check"), stage("summarize")],
  ])
    add(
      `empty-turns-${stages.length}`,
      [
        { op: "start", at: 0 },
        ...Array.from({ length: Math.max(1, stages.length) }, (_, i) => ({
          op: "succeed",
          turn: done(String(i)),
          at: i + 1,
        })),
      ],
      { stages, maxTurns: 0, maxElapsedMs: 0, stopAfter: 0 },
    );
  for (const concurrency of [-2, 0, 1, 1.5, 2, 10, "nan", "infinity"])
    add(
      `fanout-${concurrency}`,
      [
        { op: "start", at: 0 },
        { op: "succeed", at: 1, turn: ask("a", "b", "c") },
        { op: "toolOk", at: 2, id: "unknown", result: null },
        { op: "roundtrip" },
        { op: "boot", at: 3 },
        { op: "toolOk", at: 4, id: "a", result: { a: 1 } },
        { op: "toolErr", at: 5, id: "b", reason: "bad\ud800" },
        { op: "toolOk", at: 6, id: "c", result: null },
        { op: "succeed", at: 7, turn: done() },
      ],
      { toolConcurrency: concurrency, stages: [stage("collect")] },
    );
  for (const ending of ["succeed", "fail", "retry"])
    add(
      `cancel-late-${ending}`,
      [
        { op: "start", at: 0 },
        ...(ending === "retry"
          ? [{ op: "fail", at: 1, error: { why: "before" } }]
          : []),
        { op: "cancel", at: 2 },
        ending === "succeed"
          ? { op: "succeed", at: 3, turn: done("late") }
          : ending === "fail"
            ? { op: "fail", at: 3, error: { why: "late" } }
            : { op: "timer", id: "resilient:retry:collect", at: 21 },
        { op: "cancel", at: 30 },
        { op: "boot", at: 40 },
      ],
      ending === "retry" ? { retry: 2 } : {},
    );
  for (const ending of ["success", "failure"])
    add(`cancel-tools-${ending}`, [
      { op: "start", at: 0 },
      { op: "succeed", at: 1, turn: ask("a", "b") },
      { op: "cancel", at: 2 },
      ending === "success"
        ? { op: "toolOk", at: 3, id: "a", result: { ignored: 1 } }
        : { op: "toolErr", at: 3, id: "a", reason: "ignored" },
      { op: "turn", at: 4, turn: done("ignored") },
      { op: "roundtrip" },
      { op: "boot", at: 5 },
    ]);
  for (const retry of [0, 1, 2, 3])
    add(
      `retry-${retry}`,
      [
        { op: "start", at: 0 },
        { op: "fail", at: 1, error: { code: "first" } },
        { op: "roundtrip" },
        { op: "boot", at: 5 },
        { op: "timer", id: "resilient:retry:collect", at: 21 },
        { op: "fail", at: 22, error: { code: "second", "\ud800": 2 } },
        { op: "timer", id: "resilient:retry:collect", at: 62 },
        { op: "succeed", at: 63, turn: done("recovered") },
      ],
      { retry, deadlineMs: 1000 },
    );
  for (const config of [
    { maxTurns: 0 },
    { maxTurns: 1 },
    { maxTurns: 2 },
    { maxElapsedMs: 2 },
    { maxElapsedMs: 3 },
    { stopAfter: 1 },
    { maxTurns: 1, maxElapsedMs: 1, stopAfter: 0 },
  ])
    add(
      `guard-${JSON.stringify(config)}`,
      [
        { op: "start", at: 0 },
        { op: "succeed", at: 1, turn: ask("a") },
        { op: "toolOk", at: 2, id: "a", result: "r" },
        { op: "succeed", at: 3, turn: ask("b") },
        { op: "toolOk", at: 4, id: "b", result: "r2" },
      ],
      config,
    );
  add(
    "watchdog-stale-boot",
    [
      { op: "start", at: 0 },
      { op: "succeed", at: 1, turn: ask("a") },
      { op: "timer", id: "monitored:safety:r:0", at: 10 },
      { op: "roundtrip" },
      { op: "boot", at: 100 },
      { op: "timer", id: "monitored:safety:r:1", at: 11 },
      { op: "timer", id: "monitored:safety:r:2", at: 110 },
      { op: "boot", at: 200 },
    ],
    { deadlineMs: 10 },
  );
  for (const when of ["before", "tools", "done", "failed"])
    add(
      `restart-${when}`,
      [
        { op: "start", at: 0 },
        ...(when === "tools"
          ? [{ op: "succeed", at: 1, turn: ask("a") }]
          : when === "done"
            ? [{ op: "succeed", at: 1, turn: done() }]
            : when === "failed"
              ? [{ op: "fail", at: 1, error: { failed: true } }]
              : []),
        { op: "start", at: 20, runId: "new" },
        { op: "succeed", at: 21, turn: done("new result") },
      ],
      { stages: [stage("collect")] },
    );
  for (const legacy of ["absent", "undefined", "null", "value"])
    add(
      `legacy-${legacy}`,
      [
        { op: "start", at: 0 },
        {
          op: "legacy",
          usage: "absent",
          legacy,
          context: "undefined",
          instructions: "absent",
          turnCount: "null",
        },
        { op: "succeed", at: 1, turn: ask("a") },
        { op: "roundtrip" },
        { op: "toolOk", at: 2, id: "a", result: null },
        { op: "succeed", at: 3, turn: done("final") },
      ],
      { stages: [stage("collect")], instructions: "configured" },
    );
  add(
    "restored-null-numbers",
    [
      { op: "start", at: 0 },
      {
        op: "legacy",
        usage: "value",
        legacy: "absent",
        context: "null",
        turnCount: "nan",
      },
      { op: "roundtrip" },
      {
        op: "succeed",
        at: 1,
        turn: {
          ...ask("a"),
          usage: {
            inputTokens: null,
            outputTokens: 3,
            cachedInputTokens: null,
          },
        },
      },
      { op: "toolOk", at: 2, id: "a", result: { "\udfff": null } },
      { op: "roundtrip" },
      { op: "succeed", at: 3, turn: done() },
    ],
    { stages: [stage("collect")] },
  );
  add("stale-and-note-clearing", [
    { op: "boot", at: 0 },
    { op: "cancel", at: 1 },
    { op: "cancel", at: 2 },
    { op: "start", at: 3 },
    { op: "turn", at: 4, turn: ask("a") },
    { op: "turn", at: 5, turn: done("stale") },
    { op: "toolOk", at: 6, id: "a", result: 1 },
    { op: "toolOk", at: 7, id: "a", result: 2 },
    { op: "timer", id: "foreign", at: 8 },
  ]);
  for (const stopAfter of [1, 2])
    add(
      `note-retention-${stopAfter}`,
      [
        { op: "start", at: 0 },
        { op: "succeed", at: 1, turn: ask("a") },
        {
          op: "toolErr",
          at: 2,
          id: "a",
          error: {
            kind: "error",
            reason: "retained",
            _tag: "opaque",
            payload: { same: true },
          },
        },
        { op: "roundtrip" },
        { op: "boot", at: 10 },
      ],
      { stages: [stage("collect")], stopAfter },
    );
  for (const name of ["__proto__", "\ud800"])
    add(
      `purpose-${name === "__proto__" ? "prototype" : "raw-unit"}`,
      [
        { op: "start", at: 0 },
        { op: "fail", at: 1, error: { cause: "original" } },
        { op: "timer", id: `resilient:retry:${name}`, at: 21 },
        { op: "succeed", at: 22, turn: done("result\udfff") },
      ],
      { stages: [stage(name)], retry: 2 },
    );
  for (const profile of ["compacting", "tool-ladder"])
    add(
      `unsupported-${profile}`,
      [
        { op: "start", at: 0 },
        { op: "optional", profile },
        { op: "boot", at: 10 },
      ],
      {},
      profile === "compacting"
        ? `OPEN unsupported restored ${profile} profile; Source resumes it, native must return an observable refusal. Excluded from strict/nativeEvidence.`
        : undefined,
    );
  return out;
}
