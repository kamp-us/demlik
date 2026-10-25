export function agentGuardsCases() {
  const cases = [],
    add = (id, operation, input) =>
      cases.push({ id: `agent-guards.${id}`, operation, input });
  const special = ($value) => ({ $value }),
    U = special("undefined"),
    N = special("NaN"),
    I = special("Infinity"),
    NI = special("-Infinity"),
    Z = special("-0");
  const guard = (id, value) => add(id, "guards", { value });
  for (const [id, value] of Object.entries({
    undefined: U,
    null: null,
    false: false,
    true: true,
    zero: 0,
    text: "x",
    array: [],
    object: {},
    nan: N,
    infinity: I,
    "negative-infinity": NI,
    "negative-zero": Z,
  }))
    guard(`primitive-${id}`, value);
  const counts = [
    ["undefined", U],
    ["null", null],
    ["false", false],
    ["text", "1"],
    ["zero", 0],
    ["negative-zero", Z],
    ["one", 1],
    ["fraction", 0.5],
    ["negative", -1],
    ["max-safe", 9007199254740991],
    ["unsafe", 9007199254740992],
    ["nan", N],
    ["infinity", I],
    ["negative-infinity", NI],
  ];
  for (const field of [
    "inputTokens",
    "outputTokens",
    "reasoningTokens",
    "cachedInputTokens",
  ])
    for (const [id, value] of counts)
      guard(`count-${field}-${id}`, {
        inputTokens: 1,
        outputTokens: 2,
        [field]: value,
      });
  guard("usage-missing-input", { outputTokens: 1 });
  guard("usage-missing-output", { inputTokens: 1 });
  guard("usage-cached-exceeds-input", {
    inputTokens: 1,
    outputTokens: 0,
    cachedInputTokens: 99,
  });
  guard("usage-extra-retained", {
    inputTokens: 1,
    outputTokens: 2,
    extra: { opaque: true },
  });
  const tool = (callId, args = {}) => ({ callId, name: "tool", args });
  const turn = (content, toolCalls = []) => ({ content, toolCalls });
  guard("turn-bare", turn(""));
  guard("turn-lone-content", turn("\ud800"));
  guard("turn-missing-content", { toolCalls: [] });
  guard("turn-missing-tools", { content: "x" });
  guard("turn-content-null", { content: null, toolCalls: [] });
  guard("turn-tools-null", { content: "x", toolCalls: null });
  guard("turn-tools-object", { content: "x", toolCalls: {} });
  for (const [id, value] of Object.entries({
    null: null,
    number: 1,
    text: "x",
    array: [],
    missing: {},
    "id-number": { callId: 1, name: "tool", args: {} },
    "name-null": { callId: "x", name: null, args: {} },
    "args-null": tool("x", null),
    "args-number": tool("x", 2),
    "args-missing": { callId: "x", name: "tool" },
  }))
    guard(`turn-tool-${id}`, turn("x", [value]));
  guard("turn-tool-array-args", turn("x", [tool("", [])]));
  guard(
    "turn-tool-object-args",
    turn("x", [
      tool(
        "\udfff",
        JSON.parse('{"__proto__":null,"x":{"$value":"undefined"}}'),
      ),
    ]),
  );
  guard("turn-late-tool-invalid", turn("x", [tool("good"), 1]));
  guard("turn-duplicate-tools-valid", turn("x", [tool("same"), tool("same")]));
  for (const [id, value] of Object.entries({
    undefined: U,
    null: null,
    false: false,
    text: "opaque",
    nan: N,
    array: [1],
    object: { "\ud800": 2 },
  }))
    guard(`turn-provider-${id}`, { ...turn("x"), provider: value });
  for (const [id, value] of Object.entries({
    undefined: U,
    null: null,
    false: false,
    empty: {},
    valid: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 9 },
    invalid: { inputTokens: 1, outputTokens: N },
  }))
    guard(`turn-usage-${id}`, { ...turn("x"), usage: value });
  guard("turn-extra-retained", {
    ...turn("x", [tool("c", { payload: { keep: 1 } })]),
    extra: { nested: [1, U, "\ud800"] },
    provider: { signature: "same" },
    usage: { inputTokens: 2, outputTokens: 3, extra: "count" },
  });
  for (const [id, value] of Object.entries({
    empty: "",
    normal: "summary",
    lone: "\ud800",
    astral: "😀",
    number: 1,
    null: null,
    undefined: U,
    object: {},
    array: [],
  }))
    guard(`summary-${id}`, { summary: value, extra: { retained: 1 } });
  guard("all-three-guards", {
    ...turn("x"),
    summary: "S",
    inputTokens: 1,
    outputTokens: 2,
    extra: { kept: true },
  });

  const usage = (inputTokens, outputTokens, optional = {}) => ({
    inputTokens,
    outputTokens,
    ...optional,
  });
  const sums = [
    ["absent", usage(1, 2), usage(3, 4)],
    [
      "explicit-undefined",
      usage(1, 2, { reasoningTokens: U }),
      usage(3, 4, { cachedInputTokens: U }),
    ],
    [
      "both-undefined",
      usage(1, 2, { reasoningTokens: U, cachedInputTokens: U }),
      usage(3, 4, { reasoningTokens: U, cachedInputTokens: U }),
    ],
    ["zero-reported", usage(1, 2, { reasoningTokens: 0 }), usage(3, 4)],
    ["right-zero-reported", usage(1, 2), usage(3, 4, { cachedInputTokens: 0 })],
    [
      "all-counts",
      usage(100, 10, { reasoningTokens: 1, cachedInputTokens: 90 }),
      usage(200, 20, { reasoningTokens: 2, cachedInputTokens: 150 }),
    ],
    ["safe-overflow", usage(9007199254740991, 9007199254740991), usage(1, 2)],
    [
      "infinite-overflow",
      usage(Number.MAX_VALUE, Number.MAX_VALUE),
      usage(Number.MAX_VALUE, Number.MAX_VALUE),
    ],
    [
      "nan-infinity",
      usage(N, I, { reasoningTokens: N }),
      usage(1, NI, { cachedInputTokens: I }),
    ],
    [
      "negative-zero",
      usage(Z, Z, { reasoningTokens: Z }),
      usage(Z, 0, { reasoningTokens: Z }),
    ],
    [
      "one-negative-zero",
      usage(Z, Z, { reasoningTokens: Z, cachedInputTokens: Z }),
      usage(0, 0),
    ],
    [
      "negative-fraction",
      usage(-1.5, 0.25, { reasoningTokens: -2 }),
      usage(0.5, 0.75, { reasoningTokens: 0.5 }),
    ],
  ];
  for (const [id, left, right] of sums)
    add(`sum-${id}`, "add", { left, right });
  add("fresh", "fresh", {});
  for (const [id, summary] of [
    ["empty", ""],
    ["normal", "summary"],
    ["lone", "\ud800"],
    ["astral", "😀"],
  ])
    add(`vocabulary-${id}`, "vocabulary", { summary });
  add("dedupe-empty", "dedupe", { calls: [] });
  add("dedupe-unique", "dedupe", { calls: [tool("1"), tool("01"), tool("2")] });
  add("dedupe-first-and-references", "dedupe", {
    calls: [
      tool("same", { x: 1 }),
      tool("same", { x: 2 }),
      tool("tail", { x: 3 }),
    ],
    mutations: [
      { target: "args", index: 0, key: "x", value: 42 },
      { target: "args", index: 1, key: "ignored", value: true },
    ],
  });
  add("dedupe-units-and-prototype-names", "dedupe", {
    calls: [
      tool("__proto__"),
      tool("constructor"),
      tool("\ud800"),
      tool("__proto__"),
      tool("\udfff"),
      tool("\ud800"),
      tool("😀"),
      tool("😀"),
      tool(""),
    ],
  });

  const fixture = () => ({
    turns: [
      turn("0"),
      { ...turn("1"), provider: { opaque: 1 } },
      { ...turn("2"), usage: { inputTokens: 1, outputTokens: 2 } },
    ],
    calls: [tool("a", { x: 0 }), tool("b", { x: 1 }), tool("c", { x: 2 })],
    outcomes: [
      { Ok: { count: 1 } },
      {
        Error: {
          kind: "error",
          reason: "bad",
          _tag: "denied",
          detail: { code: 4 },
        },
      },
    ],
    records: [
      { call: 0, outcome: 0, turn: 0 },
      { call: 1, outcome: 1, turn: 1 },
      { call: 2, outcome: 0, turn: 2 },
      { call: 2, outcome: 1, turn: 2 },
    ],
    summary: turn("S"),
    folding: 2,
    turnCount: 9,
    awaiting: { Tools: 2 },
    contextTokens: 33,
  });
  add("fold-valid-identities", "fold", {
    ...fixture(),
    mutations: [
      { target: "turn", index: 2, key: "content", value: "changed" },
      { target: "args", index: 2, key: "x", value: 42 },
      { target: "outcome", index: 0, key: "count", value: 7 },
      { target: "outcome", index: 1, key: "detail", value: { code: 8 } },
      { target: "summary", index: 0, key: "content", value: "summary changed" },
    ],
  });
  for (const [id, folding] of [
    ["zero", 0],
    ["one", 1],
    ["two", 2],
    ["all", 3],
    ["past-end", 4],
    ["negative", -1],
    ["fraction", 1.5],
    ["negative-fraction", -1.5],
    ["negative-near-zero", -0.5],
    ["nan", N],
    ["infinity", I],
    ["negative-infinity", NI],
    ["negative-zero", Z],
  ])
    add(`fold-${id}`, "fold", { ...fixture(), folding });
  add("fold-empty", "fold", {
    turns: [],
    calls: [],
    outcomes: [],
    records: [],
    summary: turn("S"),
    folding: 2,
    turnCount: 0,
    awaiting: "Llm",
    contextTokens: null,
  });
  add(
    "fold-missing-context",
    "fold",
    Object.fromEntries(
      Object.entries(fixture()).filter(([key]) => key !== "contextTokens"),
    ),
  );
  add("fold-undefined-context", "fold", { ...fixture(), contextTokens: U });
  add("fold-nonfinite-count-and-context", "fold", {
    ...fixture(),
    turnCount: N,
    contextTokens: I,
    awaiting: { Compacting: 2 },
  });
  add("fold-nonfinite-record-turns", "fold", {
    ...fixture(),
    records: [
      { call: 0, outcome: 0, turn: N },
      { call: 1, outcome: 1, turn: I },
      { call: 2, outcome: 0, turn: NI },
      { call: 2, outcome: 1, turn: 2.5 },
    ],
  });
  add("fold-undefined-outcome-result", "fold", {
    ...fixture(),
    outcomes: [
      { Ok: U },
      { Error: { kind: "error", reason: "failed", raw: U } },
    ],
  });
  return cases;
}
