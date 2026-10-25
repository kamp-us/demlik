import assert from "node:assert/strict";
import {
  contentParts,
  omitMedia,
} from "../../packages/tea/src/agent/content.ts";
import { transcript } from "../../packages/tea/src/agent/transcript.ts";

const backing = new Uint8Array([10, 20, 30, 40]);
const view = backing.subarray(1, 3),
  copy = view.slice();
const text = { type: "text", text: "keep\ud800" };
const image = {
  type: "image",
  mediaType: "image/png",
  source: { type: "bytes", data: view },
};
const file = {
  type: "file",
  mediaType: "application/pdf",
  source: { type: "url", url: "https://example.test/a" },
};
const parts = [text, image, file];
const pass = contentParts(parts),
  plain1 = contentParts("hello"),
  plain2 = contentParts("hello");
const omitted1 = omitMedia(parts),
  omitted2 = omitMedia(parts);
parts.push({ type: "text", text: "added" });
backing[1] = 21;
view[1] = 32;
copy[0] = 99;
const content = {
  sameArray: pass === parts,
  sameRepeatedArray: contentParts(parts) === pass,
  plainFreshArray: plain1 !== plain2,
  plainFreshPart: plain1[0] !== plain2[0],
  omittedFreshArrays: omitted1 !== parts && omitted1 !== omitted2,
  textRetained: omitted1[0] === text,
  placeholderFresh: omitted1[1] !== omitted2[1],
  omitted: omitted1,
  passLengthAfterPush: pass.length,
  media: {
    sameView: pass[1].source.data === view,
    differentView: view !== backing,
    sameBuffer: view.buffer === backing.buffer,
    offset: view.byteOffset - backing.byteOffset,
    length: view.length,
    backing: Array.from(backing),
    view: Array.from(view),
    copy: Array.from(copy),
  },
};
const turn = { content: "seed", toolCalls: [], provider: { n: 1 } },
  result = { n: 1 };
const ok = {
  call: { callId: "2", name: "tool", args: {} },
  outcome: { kind: "ok", result },
  turn: 1,
};
const error = {
  call: { callId: "0", name: "tool", args: {} },
  outcome: { kind: "error", reason: "failed", _tag: "X" },
  turn: 1,
};
const turns = [turn],
  toolRecords = [error, ok];
Object.assign(toolRecords, {
  "01": { ...ok, call: { ...ok.call, callId: "named" } },
});
const t = transcript({
  conversation: {
    turns,
    toolRecords,
    turnCount: 1,
    awaiting: { kind: "llm" },
    contextTokens: null,
  },
});
const first = t.read(),
  again = t.read();
turns.push({ content: "seed later", toolCalls: [] });
toolRecords.push(ok);
result.n = 2;
const head = { runId: "r", at: 1 };
t.onEvent({
  ...head,
  type: "BrainStarted",
  turn: 2,
  purpose: "p",
  model: null,
  payload: {},
});
t.onEvent({
  ...head,
  type: "ToolStarted",
  callId: "x",
  name: "tool",
  args: {},
});
t.onEvent({
  ...head,
  type: "ToolFailed",
  callId: "x",
  name: "tool",
  failure: { kind: "error", reason: "bad" },
});
const live = { content: "live", toolCalls: [] };
t.onEvent({ ...head, type: "TurnSettled", turn: live });
t.onEvent({ ...head, type: "ToolSettled", callId: "again", result });
const status = {
  kind: "done",
  output: null,
  usage: { inputTokens: 0, outputTokens: 0 },
};
t.onEvent({ ...head, type: "RunDone", status });
const done = t.read();
t.onEvent({ ...head, type: "TurnSettled", turn: live });
t.onEvent({ ...head, type: "RunDone", status });
const repeated = t.read();
first.turns.push({ content: "snapshot only", toolCalls: [] });
const transcriptFacts = {
  freshSnapshots: first !== again,
  freshTurns: first.turns !== again.turns,
  freshTools: first.tools !== again.tools,
  turnRetained: first.turns[0] === turn,
  resultRetained: first.tools[0].result === result,
  toolWrapperRetained: first.tools[0] === again.tools[0],
  runningOutcomeRetained: first.outcome === again.outcome,
  seedOwnKeys: Object.keys(toolRecords),
  seedTools: first.tools.map((x) => x.callId),
  seedOuterMutationIgnored:
    again.turns.length === 1 && again.tools.length === 1,
  opaqueMutationVisible: first.tools[0].result.n === 2,
  statusRetained: done.outcome === status,
  repeatStatusRetained: repeated.outcome === status,
  doneNull: done.outcome.output === null,
  firstStaysRunning: first.outcome.kind === "running",
  lateEventKept: repeated.turns.length === 3,
  snapshotMutationIsolated: t.read().turns.length === 3,
  liveTurnRetained: done.turns[1] === live,
  tools: done.tools.map((x) => x.callId),
};
const sparse = [];
sparse.length = 3;
sparse[2] = ok;
Object.setPrototypeOf(
  sparse,
  Object.assign(Object.create(Array.prototype), { 1: ok }),
);
const sparseTools = transcript({
  conversation: { turns: [], toolRecords: sparse },
})
  .read()
  .tools.map((x) => x.callId);
const holes = [];
holes.length = 2;
holes[1] = turn;
const holeTurns = transcript({
  conversation: { turns: holes, toolRecords: [] },
}).read().turns;
const malformed = {};
for (const [name, seed] of Object.entries({
  objectTurns: {
    conversation: { turns: { 0: turn, length: 1 }, toolRecords: [] },
  },
  objectTools: {
    conversation: { turns: [], toolRecords: { 0: ok, length: 1 } },
  },
  nullConversation: { conversation: null },
  missingConversation: {},
  nullFields: { conversation: { turns: null, toolRecords: null } },
}))
  try {
    const r = transcript(seed).read();
    malformed[name] = {
      turns: r.turns.length,
      tools: r.tools.length,
      outcome: r.outcome.kind,
    };
  } catch (e) {
    malformed[name] = { name: e.name, message: e.message };
  }
const custom = [turn, live];
custom[Symbol.iterator] = function* () {
  yield live;
  yield turn;
};
const customTurnOrder = transcript({
  conversation: { turns: custom, toolRecords: [] },
})
  .read()
  .turns.map((x) => x.content);
const report = {
  manualProfileOnly: true,
  nativeQualification:
    "Dense native sequences do not model sparse/prototype/custom-iterator JavaScript arrays",
  customTurnOrder,
  node: process.version,
  v8: process.versions.v8,
  content,
  transcript: transcriptFacts,
  seedEnumeration: {
    sparseTools,
    spreadHoleBecomesOwnUndefined:
      Object.hasOwn(holeTurns, 0) && holeTurns[0] === undefined,
    malformed,
  },
};
assert.deepEqual(content.media.backing, [10, 21, 32, 40]);
assert.equal(transcriptFacts.statusRetained, true);
assert.equal(transcriptFacts.seedTools.join(), "2");
console.log(JSON.stringify(report, null, 2));
