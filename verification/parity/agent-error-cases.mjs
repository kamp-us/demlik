export const agentErrorCases = [
  { id: "guard-null", operation: "guard", json: "null" },
  {
    id: "guard-invalid-usage",
    operation: "guard",
    json: '{"content":"x","toolCalls":[],"usage":null}',
  },
  {
    id: "guard-valid-original",
    operation: "guard",
    json: '{"content":"hi","toolCalls":[],"unknown":{"kept":true},"provider":null}',
  },
  {
    id: "guard-call-extras",
    operation: "guard",
    json: '{"content":"hi","toolCalls":[{"callId":"i","name":"read","args":[],"unknown":3}]}',
  },
  { id: "summary-null", operation: "guard", summary: true, json: "null" },
  {
    id: "summary-valid",
    operation: "guard",
    summary: true,
    json: '{"summary":"\\ud800","extra":true}',
  },
  ...[
    ["empty", "{}"],
    ["null", "null"],
    ["string", '"invoice"'],
    ["utf16", '"\\ud800"'],
    ["true", "true"],
    ["number", "17.25"],
    ["overflow", "1e400"],
    ["array", '[1,null,{},"\\udfff"]'],
    [
      "message-shaped",
      '{"name":"Error","message":"not a real Error","value":{"kept":true},"expected":"an AgentTurn"}',
    ],
    ["own-prototype", '{"__proto__":{"kept":true},"unknown":[1,null]}'],
    ["coercion-fails", '{"toString":0,"message":"do not swallow"}'],
  ].map(([id, json]) => ({ id: `plain-${id}`, operation: "plain", json })),
];
export const defaultAgentJsonCases = ["promise", "effect"].flatMap((profile) =>
  ["brain", "tools", "guard-error"].map((checkpoint) => ({
    id: `agent-error-cold.${profile}.${checkpoint}`,
    input: { profile, checkpoint },
  })),
);
