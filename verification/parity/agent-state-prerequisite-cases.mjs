export function prerequisiteCases() {
  const result = [],
    add = (name, operation, input) =>
      result.push({ id: `agent-state-prerequisite.${name}`, operation, input });
  const conv = (count = null, usage = "absent") => {
    const value = {
      turns: [
        { content: "a\ud800", toolCalls: [] },
        { content: "b", toolCalls: [] },
      ],
      toolRecords: [
        {
          call: { callId: "a", name: "t", args: { "\udfff": 1 } },
          outcome: { kind: "ok", result: { v: 1 } },
          turn: null,
        },
        {
          call: { callId: "b", name: "t", args: {} },
          outcome: {
            kind: "error",
            reason: "bad",
            _tag: "failure",
            detail: "\ud800",
          },
          turn: 2,
        },
      ],
      turnCount: count,
      awaiting: { kind: "tools", batchTurn: null },
      contextTokens: null,
    };
    if (usage !== "absent")
      value.usage =
        usage === "null" ? null : { inputTokens: null, outputTokens: 4 };
    return JSON.stringify(value);
  };
  add("shared-no-usage", "defaults", {});
  for (const usage of ["absent", "null", "value"])
    for (const legacy of [undefined, "absent", "undefined", "null"])
      add(`copy-${usage}-${legacy ?? "wire"}`, "copy", {
        encoded: conv(null, usage),
        ...(legacy ? { legacy } : {}),
      });
  const sumRows = [
    [
      "null-required",
      '{"inputTokens":null,"outputTokens":null}',
      '{"inputTokens":2,"outputTokens":3}',
    ],
    [
      "null-optional",
      '{"inputTokens":null,"outputTokens":2,"reasoningTokens":null}',
      '{"inputTokens":0,"outputTokens":null}',
    ],
    [
      "null-both-optional",
      '{"inputTokens":1,"outputTokens":2,"cachedInputTokens":null}',
      '{"inputTokens":3,"outputTokens":4,"reasoningTokens":null}',
    ],
    [
      "absent-optional",
      '{"inputTokens":1,"outputTokens":2}',
      '{"inputTokens":3,"outputTokens":4}',
    ],
    [
      "negative-zero",
      '{"inputTokens":-0,"outputTokens":-0}',
      '{"inputTokens":-0,"outputTokens":0}',
    ],
    [
      "overflow-before-save",
      '{"inputTokens":1e400,"outputTokens":-1e400}',
      '{"inputTokens":-1e400,"outputTokens":1e400}',
    ],
    [
      "overflow-cold",
      '{"inputTokens":null,"outputTokens":null,"reasoningTokens":null}',
      '{"inputTokens":null,"outputTokens":null,"cachedInputTokens":null}',
    ],
  ];
  for (const [name, left, right] of sumRows)
    add(`sum-${name}`, "sum", { left, right });
  for (const folding of [
    "0",
    "-0",
    "-0.5",
    "1",
    "2",
    "NaN",
    "Infinity",
    "-Infinity",
    "50",
  ])
    for (const usage of ["absent", "null", "value"])
      add(`fold-${folding}-${usage}`, "fold", {
        encoded: conv(null, usage),
        folding,
        summary: { content: "summary\ud800", toolCalls: [] },
      });
  add("fold-legacy-undefined", "fold", {
    encoded: conv(3, "value"),
    folding: "0",
    summary: { content: "summary", toolCalls: [] },
    legacy: "undefined",
  });
  const absentResult = JSON.parse(conv(null, "null"));
  delete absentResult.toolRecords[0].outcome.result;
  add("copy-undefined-tool-result-wire", "copy", {
    encoded: JSON.stringify(absentResult),
  });
  result.at(-1).scope = "wire-identity";
  return result;
}

export function prerequisiteQualifiedCases() {
  const row = prerequisiteCases().at(-1);
  return [
    {
      id: "agent-state-prerequisite.copy-undefined-tool-result",
      operation: row.operation,
      input: row.input,
    },
  ];
}
