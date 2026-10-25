import assert from "node:assert/strict";
import { isCompactionSummary } from "../../packages/tea/src/agent/compaction.ts";
import {
  addUsage,
  foldSummary,
  freshConversation,
} from "../../packages/tea/src/agent/internal.ts";
import { schemaFromGuard } from "../../packages/tea/src/agent/schema.ts";
import {
  agentTurnSchema,
  isAgentTurn,
  isTurnUsage,
} from "../../packages/tea/src/agent/types.ts";

assert.equal(process.version, "v22.21.1");
const inherited = Object.create({ inputTokens: 1, outputTokens: 2 });
const arrayUsage = Object.assign([], { inputTokens: 1, outputTokens: 2 });
const sparse = new Array(2);
const arrayTurn = Object.assign([], { content: "array", toolCalls: sparse });
const arraySummary = Object.assign([], { summary: "array" });
const inheritedCall = Object.create({ callId: "c", name: "tool", args: {} });
const guarded = { content: "x", toolCalls: [inheritedCall] };
const error = new Error("original guard cause");
const guardedThrow = schemaFromGuard(() => {
  throw error;
}, "a custom value");
let originalGuardFailure = false;
try {
  guardedThrow.parse(1);
} catch (caught) {
  originalGuardFailure = caught === error;
}
const summary = { content: "S", toolCalls: [] },
  surviving = { content: "kept", toolCalls: [] };
const call = { callId: "c", name: "t", args: {} },
  outcome = { kind: "ok", result: {} };
const extra = { retained: true },
  usage = { legacy: 1 };
const record = { call, outcome, turn: 2, extra };
const conversation = {
  ...freshConversation(),
  turns: [
    { content: "a", toolCalls: [] },
    { content: "b", toolCalls: [] },
    surviving,
  ],
  toolRecords: [record],
  usage,
  extra,
  contextTokens: 33,
};
const folded = foldSummary(conversation, 2, summary);
const nullUsage = addUsage(
  { inputTokens: 1, outputTokens: 2, reasoningTokens: null },
  { inputTokens: 3, outputTokens: 4 },
);
const report = {
  node: process.version,
  v8: process.versions.v8,
  sourceOnly: true,
  strictNativeParity: false,
  nativeQualification:
    "Dense own-data records and canonical typed fields only. These JavaScript array/prototype/getter and undeclared legacy/extra-field behaviors are not native proof; later state/migration work remains open. Optional-null usage arithmetic is outside TurnUsage's typed count fields.",
  observations: {
    inheritedUsage: isTurnUsage(inherited),
    namedArrayUsage: isTurnUsage(arrayUsage),
    sparseTools: isAgentTurn({ content: "sparse", toolCalls: sparse }),
    namedArrayTurn: isAgentTurn(arrayTurn),
    namedArraySummary: isCompactionSummary(arraySummary),
    inheritedCall: isAgentTurn(guarded),
    schemaKeepsInheritedObject: agentTurnSchema.parse(guarded) === guarded,
    originalGuardFailure,
    legacyUsageKept: folded.usage === usage,
    conversationExtraKept: folded.extra === extra,
    recordExtraKept: folded.toolRecords[0].extra === extra,
    optionalNullSum: nullUsage,
    optionalNullStillGuardRejected: !isTurnUsage({
      inputTokens: 1,
      outputTokens: 2,
      reasoningTokens: null,
    }),
  },
};
for (const [key, value] of Object.entries(report.observations))
  if (key !== "optionalNullSum") assert.equal(value, true, key);
assert.deepEqual(nullUsage, {
  inputTokens: 4,
  outputTokens: 6,
  reasoningTokens: 0,
});
console.log(JSON.stringify(report, null, 2));
