const json = (value) => ({ kind: "json", value });
const media = {
  bytes: [10, 20, 30, 40],
  range: [1, 3],
  backingWrite: { index: 1, value: 21 },
  viewWrite: { index: 1, value: 32 },
  copyWrite: { index: 0, value: 99 },
};
const baseContent = {
  text: "hello",
  parts: [
    { Text: { text: "kept" } },
    { Image: { mediaType: "image/png", source: "Bytes" } },
    {
      File: {
        mediaType: "application/pdf",
        source: { Url: { url: "https://example.test/a" } },
      },
    },
    {
      Image: { mediaType: "image/jpeg", source: { Base64: { data: "AAAA" } } },
    },
    {
      File: {
        mediaType: "application/pdf",
        source: { Base64: { data: "JVBERg==" } },
      },
    },
    { Reuse: { index: 0 } },
    { Reuse: { index: 1 } },
  ],
  media,
  appendText: "later",
};
const baseTranscript = {
  values: [
    {
      value: json({
        content: "seed",
        toolCalls: [],
        provider: { signed: "x" },
      }),
    },
    { value: json({ content: "answer", toolCalls: [] }) },
    { value: json({ count: 1 }), media: true },
    { value: { kind: "undefined" } },
    {
      value: json({
        reason: "llm",
        error: { _tag: "E", raw: "cause\ud800" },
        at: 1,
      }),
    },
    { value: json({}) },
  ],
  seed: {
    turns: [0],
    tools: [
      { Error: { callId: "0" } },
      { Ok: { callId: "2", result: 2 } },
      { Reuse: { index: 1 } },
    ],
  },
  statuses: [
    { Done: { output: null, usage: { inputTokens: 0, outputTokens: 0 } } },
    {
      Done: {
        output: 1,
        usage: {
          inputTokens: 10,
          outputTokens: 3,
          reasoningTokens: 1,
          cachedInputTokens: 2,
        },
      },
    },
    { Failed: { failure: 4 } },
    { Cancelled: { at: 3.5 } },
  ],
  events: [
    { BrainStarted: { payload: 5 } },
    { ToolStarted: { args: 5, callId: "x" } },
    { ToolFailed: { failure: 4, callId: "x" } },
    { TurnSettled: { turn: 1 } },
    { ToolSettled: { callId: "10", result: 2 } },
    { ToolSettled: { callId: "u", result: 3 } },
    { RunDone: { status: 0 } },
    { TurnSettled: { turn: 1 } },
    { ToolSettled: { callId: "10", result: 2 } },
    { RunDone: { status: 0 } },
    { RunDone: { status: 2 } },
    { RunDone: { status: 3 } },
  ],
  changes: [
    { index: 0, key: "content", value: json("seed changed") },
    { index: 2, key: "count", value: json(42) },
    { index: 4, key: "error", value: json({ nested: "new\udfff" }) },
  ],
  clearFirst: false,
  media,
};
export function agentContentCases() {
  const cases = [];
  const add = (id, operation, input, qualification) =>
    cases.push({
      id,
      operation,
      input: structuredClone(input),
      ...(qualification ? { qualification } : {}),
    });
  add("agent-content.alias-and-media", "content", baseContent);
  for (const [i, text] of [
    "",
    "a\0b",
    "line\r\ntext",
    "😀",
    "\ud800",
    "\udfff",
    "a\ud800b\udfff",
    "\u2028\u2029",
    '<tag>&"\\',
  ].entries()) {
    const input = structuredClone(baseContent);
    input.text = text;
    input.parts[0].Text.text = text;
    input.appendText = text;
    add(`agent-content.text-${i}`, "content", input);
  }
  for (const [i, parts] of [
    [],
    [{ Text: { text: "only" } }],
    [{ Image: { mediaType: "", source: "Bytes" } }],
    [
      {
        File: { mediaType: "raw\ud800", source: { Url: { url: "url\udfff" } } },
      },
    ],
    [
      { Text: { text: "same" } },
      { Reuse: { index: 0 } },
      { Reuse: { index: 0 } },
    ],
    [{ File: { mediaType: "x", source: "Bytes" } }, { Reuse: { index: 0 } }],
    [
      {
        Image: {
          mediaType: "image/png",
          source: { Base64: { data: "base64\ud800" } },
        },
      },
    ],
  ].entries())
    add(`agent-content.parts-${i}`, "content", { ...baseContent, parts });
  for (const [i, bytes] of [
    [],
    [0],
    [255],
    [0, 255, 128],
    [1, 2, 3, 4, 5, 6],
  ].entries())
    for (const [name, start, end] of [
      ["whole", 0, bytes.length],
      ["empty", Math.floor(bytes.length / 2), Math.floor(bytes.length / 2)],
    ])
      add(`agent-content.bytes-${i}-${name}`, "content", {
        ...baseContent,
        media: { bytes, range: [start, end] },
      });
  const t = (id, patch) =>
    add(`agent-transcript.${id}`, "transcript", {
      ...baseTranscript,
      ...patch,
    });
  t("live-seeded", {});
  t("fresh", { seed: null, changes: [] });
  t("empty", { seed: null, events: [], changes: [] });
  t("seed-only", { events: [], changes: [] });
  t("snapshot-array-isolation", { clearFirst: true });
  for (let i = 0; i < 4; i++)
    t(`ending-${i}`, {
      seed: null,
      events: [{ RunDone: { status: i } }],
      changes: [],
    });
  t("repeated-status", {
    events: [
      { RunDone: { status: 0 } },
      { RunDone: { status: 0 } },
      { RunDone: { status: 1 } },
      { RunDone: { status: 1 } },
    ],
    changes: [],
  });
  t("late-events", {
    seed: null,
    events: [
      { RunDone: { status: 0 } },
      { TurnSettled: { turn: 1 } },
      { ToolSettled: { callId: "late", result: 2 } },
      { RunDone: { status: 2 } },
    ],
  });
  t("ignored-started-failed", {
    seed: null,
    events: baseTranscript.events.slice(0, 3),
    changes: [],
  });
  t("duplicate-tools", {
    seed: null,
    events: [
      { ToolSettled: { callId: "same", result: 2 } },
      { ToolSettled: { callId: "same", result: 2 } },
    ],
    changes: [],
  });
  t("seed-errors-only", {
    seed: { turns: [0], tools: [{ Error: { callId: "failed" } }] },
    events: [],
    changes: [],
  });
  t("seed-order-not-numeric-keys", {
    seed: {
      turns: [1, 0, 1],
      tools: [
        { Ok: { callId: "10", result: 2 } },
        { Ok: { callId: "2", result: 2 } },
        { Ok: { callId: "1", result: 2 } },
      ],
    },
    events: [],
    changes: [],
  });
  for (const [name, value] of [
    ["null", json(null)],
    ["string", json("raw\ud800")],
    ["undefined", { kind: "undefined" }],
    ["nan", { kind: "nan" }],
    ["infinity", { kind: "infinity" }],
    ["negative-infinity", { kind: "negative-infinity" }],
    ["negative-zero", { kind: "negative-zero" }],
    ["array", json([1, null, { a: "\udfff" }])],
  ]) {
    const input = structuredClone(baseTranscript);
    input.values[3] = { value };
    input.events = [
      { ToolSettled: { callId: "raw\ud800", result: 3 } },
      { ToolSettled: { callId: "same", result: 3 } },
    ];
    input.seed = null;
    input.changes = [];
    add(`agent-transcript.result-${name}`, "transcript", input);
  }
  t("result-own-fields", {
    changes: [
      { index: 2, key: "__proto__", value: json({ kept: 1 }) },
      { index: 2, key: "2", value: json(2) },
      { index: 2, key: "1", value: json(1) },
    ],
  });
  t("result-replaces-media", {
    changes: [{ index: 2, key: "media", value: json("replacement") }],
  });
  t("opaque-provider-change", {
    changes: [{ index: 0, key: "provider", value: { kind: "undefined" } }],
  });
  const canonical = {
    content: "typed\ud800",
    toolCalls: [
      {
        callId: "c1",
        name: "tool",
        args: JSON.parse('{"q":"tea","__proto__":{"kept":1},"raw":"\\udfff"}'),
      },
    ],
    head: { runId: "r\ud800", at: -0 },
  };
  add("agent-canonical.absent-optionals", "canonical-turn", canonical);
  for (const [name, provider] of [
    ["null", json(null)],
    ["undefined", { kind: "undefined" }],
    ["nan", { kind: "nan" }],
    ["opaque", json({ signed: "provider\ud800", nested: [1, null] })],
  ])
    add(`agent-canonical.provider-${name}`, "canonical-turn", {
      ...canonical,
      provider,
    });
  add("agent-canonical.usage", "canonical-turn", {
    ...canonical,
    usage: {
      inputTokens: 10,
      outputTokens: 3,
      reasoningTokens: 1,
      cachedInputTokens: 2,
    },
  });
  const raw = (id, input, qualification) =>
    add(`agent-seed.${id}`, "raw-seed", input, qualification);
  for (const [name, input] of [
    ["null", null],
    ["empty", {}],
    ["null-conversation", { conversation: null }],
    ["null-fields", { conversation: { turns: null, toolRecords: null } }],
    ["missing-fields", { conversation: {} }],
    [
      "done-model-is-running",
      {
        conversation: null,
        output: { content: "answer", toolCalls: [] },
        run: { phase: "done" },
      },
    ],
    ["string-turns", { conversation: { turns: "a😀\ud800", toolRecords: [] } }],
    ["empty-string", { conversation: { turns: "", toolRecords: [] } }],
    [
      "object-turns",
      { conversation: { turns: { 0: 1, length: 1 }, toolRecords: {} } },
    ],
    ["number-turns", { conversation: { turns: 2, toolRecords: [] } }],
    [
      "object-tools",
      { conversation: { turns: [], toolRecords: { 0: 1, length: 1 } } },
    ],
    ["string-tools", { conversation: { turns: [], toolRecords: "x" } }],
    ["null-record", { conversation: { turns: [], toolRecords: [null] } }],
    ["missing-outcome", { conversation: { turns: [], toolRecords: [{}] } }],
    [
      "null-outcome",
      { conversation: { turns: [], toolRecords: [{ outcome: null }] } },
    ],
    [
      "unknown-kind",
      {
        conversation: {
          turns: [],
          toolRecords: [{ outcome: { kind: "other" } }],
        },
      },
    ],
    [
      "error-with-no-call",
      {
        conversation: {
          turns: [],
          toolRecords: [{ outcome: { kind: "error", reason: "failed" } }],
        },
      },
    ],
    [
      "ok-missing-call",
      {
        conversation: {
          turns: [],
          toolRecords: [{ outcome: { kind: "ok", result: 1 } }],
        },
      },
    ],
    [
      "ok-null-call",
      {
        conversation: {
          turns: [],
          toolRecords: [{ call: null, outcome: { kind: "ok", result: 1 } }],
        },
      },
    ],
    [
      "ok-undefined-result",
      {
        conversation: {
          turns: [null, 3, "raw\ud800"],
          toolRecords: [{ call: { callId: "x" }, outcome: { kind: "ok" } }],
        },
      },
    ],
  ])
    raw(name, input);
  for (const [name, call] of [
    ["missing", {}],
    ["number", { callId: 42 }],
    ["null", { callId: null }],
    ["object", { callId: { raw: "id" } }],
  ])
    raw(
      `raw-call-id-${name}`,
      {
        conversation: {
          turns: [],
          toolRecords: [{ call, outcome: { kind: "ok", result: 1 } }],
        },
      },
      "typed-call-id-boundary",
    );
  return cases;
}
