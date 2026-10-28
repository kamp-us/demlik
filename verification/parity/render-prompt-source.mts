import assert from "node:assert/strict";
import fs from "node:fs";
import { z } from "zod";
import type {
  ContentPart,
  MediaSource,
} from "../../packages/tea/src/agent/content.ts";
import {
  type AgentMessage,
  type AgentPrompt,
  renderPrompt,
  type ToolPartsOf,
} from "../../packages/tea/src/agent/define-agent.ts";
import {
  brainHandler,
  type MessageLoader,
  type PlainModel,
  plainModel,
} from "../../packages/tea/src/agent/model.ts";
import {
  type AgentTurn,
  agentTurnSchema,
  type Conversation,
  type TaggedFailure,
  type ToolCall,
  type ToolOutcome,
  type ToolRecord,
} from "../../packages/tea/src/agent/types.ts";
import { createLlmCall } from "../../packages/tea/src/internal/llm-call/index.ts";

const ids = [
  "empty.fresh-array",
  "head.null-versus-empty",
  "head.instructions-only",
  "head.input-utf16",
  "history.plan-act-order",
  "records.duplicates-orphans",
  "provider.presence",
  "owners.original-handles",
  "parts.null-versus-empty",
  "parts.media-original",
  "parts.error-callback",
  "parts.failure-prefix",
  "indices.exact-number",
  "indices.raw-null",
  "history.turn-count-ignored",
  "render.repeat-no-cache",
  "parts.mutate-after-render",
  "port.invoice-native-and-raw",
] as const;
const packet = z
  .object({ id: z.enum(ids), response: z.string(), expected: z.unknown() })
  .strict()
  .parse(JSON.parse(fs.readFileSync(process.argv[2], "utf8")));
assert.deepEqual(
  {
    node: process.version,
    v8: process.versions.v8,
    icu: process.versions.icu,
    locale: Intl.Collator().resolvedOptions().locale,
  },
  { node: "v22.21.1", v8: "12.4.254.21-node.33", icu: "77.1", locale: "en-US" },
);

const opaque = { label: "original-opaque", read: () => 17 };
const originalFailure = new Error("parts-original");
const trace: string[] = [];
const receipts: Record<string, unknown> = {};
const argumentsBefore: unknown[] = [];
let after: unknown = null;
let profile = "published typed renderPrompt";
let messages: unknown = null;
let error: unknown = null;

// This fixture-specific observation retains undefined/nonfinite/UTF16 facts,
// byte views and the one actual opaque sentinel, without copying a Source call.
function snapshot(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key: string, item: unknown) => {
      if (item === undefined) return { $value: "undefined" };
      if (typeof item === "number") {
        if (Object.is(item, -0)) return { $number: "-0" };
        if (!Number.isFinite(item)) return { $number: String(item) };
      }
      if (item === opaque)
        return { $opaque: opaque.label, read: opaque.read() };
      if (item instanceof Uint8Array) return { $bytes: [...item] };
      return item;
    }),
  );
}
function conversation(
  turns: readonly AgentTurn[] = [],
  toolRecords: readonly ToolRecord<unknown>[] = [],
): Conversation<unknown> {
  return {
    turns,
    toolRecords,
    turnCount: turns.length,
    awaiting: { kind: "llm" },
    contextTokens: null,
  };
}
function prompt(
  turns: readonly AgentTurn[] = [],
  records: readonly ToolRecord<unknown>[] = [],
  instructions: string | null = null,
  input: string | null = null,
): AgentPrompt<unknown> {
  return { instructions, input, conversation: conversation(turns, records) };
}
function turn(content: string, toolCalls: readonly ToolCall[] = []): AgentTurn {
  return { content, toolCalls };
}
function record(
  callId: string,
  index: number,
  outcome: ToolOutcome<unknown> = { kind: "ok", result: { total: 120 } },
): ToolRecord<unknown> {
  return {
    call: { callId, name: "invoice", args: { invoice: "inv-17" } },
    outcome,
    turn: index,
  };
}
function invoke(
  input: AgentPrompt<unknown>,
  parts?: ToolPartsOf,
): AgentMessage[] {
  argumentsBefore.push(
    snapshot({ prompt: input, partsProvided: parts !== undefined }),
  );
  fs.writeFileSync(
    `${packet.response}.arguments.json`,
    `${JSON.stringify(argumentsBefore, null, 2)}\n`,
  );
  return parts === undefined ? renderPrompt(input) : renderPrompt(input, parts);
}
try {
  switch (packet.id) {
    case "empty.fresh-array": {
      const p = prompt(),
        first = invoke(p),
        second = invoke(p);
      messages = first;
      receipts.sameReturnedArray = Object.is(first, second);
      break;
    }
    case "head.null-versus-empty": {
      const absent = invoke(prompt()),
        empty = invoke(prompt([], [], "", ""));
      messages = { absent, empty };
      break;
    }
    case "head.instructions-only":
      messages = invoke(prompt([turn("ready")], [], "Follow invoice policy"));
      break;
    case "head.input-utf16": {
      const text = String.fromCharCode(0, 0xd800, 0x61, 0xdc00, 0xd83d, 0xde00);
      messages = invoke(prompt([], [], null, text));
      receipts.contentUnits = Array.from(
        { length: text.length },
        (_value, index) => text.charCodeAt(index),
      );
      break;
    }
    case "history.plan-act-order": {
      const rows = [
        record("check", 1),
        record("read-b", 0),
        record("read-a", 0),
      ];
      const p = prompt([turn("plan"), turn("act")], rows);
      messages = invoke(p, (call) => {
        trace.push(call.callId);
        return null;
      });
      break;
    }
    case "records.duplicates-orphans": {
      messages = invoke(
        prompt(
          [turn("no calls")],
          [record("repeat", 0), record("repeat", 0), record("orphan", 4)],
        ),
        (call) => {
          trace.push(call.callId);
          return null;
        },
      );
      break;
    }
    case "provider.presence": {
      const turns: AgentTurn[] = [
        turn("absent"),
        { ...turn("undefined"), provider: undefined },
        { ...turn("null"), provider: null },
        { ...turn("opaque"), provider: opaque },
      ];
      const result = invoke(prompt(turns));
      messages = result;
      receipts.providerOwn = result.map((m) => Object.hasOwn(m, "provider"));
      const last = result[3];
      assert.ok(last?.role === "assistant");
      receipts.opaqueProviderOriginal = Object.is(last.provider, opaque);
      break;
    }
    case "owners.original-handles": {
      const call = { callId: "read", name: "invoice", args: opaque };
      const ok: ToolOutcome<unknown> = { kind: "ok", result: opaque };
      const failure: TaggedFailure<{
        readonly _tag: "declined";
        readonly original: typeof opaque;
      }> = {
        kind: "error",
        _tag: "declined",
        reason: "declined",
        original: opaque,
      };
      const r1 = { call, outcome: ok, turn: 0 },
        r2 = { call: { ...call, callId: "check" }, outcome: failure, turn: 0 };
      const toolCalls = [call, r2.call];
      const originalTurn = turn("inspect", toolCalls);
      const result = invoke(
        prompt([originalTurn], [r1, r2]),
        (actualCall, actualOutcome) => {
          trace.push(actualCall.callId);
          receipts[`${actualCall.callId}CallbackCallOriginal`] = Object.is(
            actualCall,
            actualCall.callId === "read" ? r1.call : r2.call,
          );
          receipts[`${actualCall.callId}CallbackOutcomeOriginal`] = Object.is(
            actualOutcome,
            actualCall.callId === "read" ? ok : failure,
          );
          return null;
        },
      );
      messages = result;
      const [assistant, read, check] = result;
      assert.ok(
        assistant?.role === "assistant" &&
          read?.role === "tool" &&
          check?.role === "tool",
      );
      receipts.originalToolCallsArray = Object.is(
        assistant.toolCalls,
        toolCalls,
      );
      receipts.originalArgs = Object.is(assistant.toolCalls[0]?.args, opaque);
      receipts.originalOutcome =
        Object.is(read.outcome, ok) && Object.is(check.outcome, failure);
      receipts.originalResult =
        read.outcome.kind === "ok" && Object.is(read.outcome.result, opaque);
      receipts.originalError =
        Object.is(check.outcome, failure) &&
        Object.is(failure.original, opaque);
      break;
    }
    case "parts.null-versus-empty": {
      const empty: ContentPart[] = [];
      const result = invoke(
        prompt([turn("parts")], [record("none", 0), record("empty", 0)]),
        (call) => {
          trace.push(call.callId);
          return call.callId === "none" ? null : empty;
        },
      );
      messages = result;
      const items = result.filter((m) => m.role === "tool");
      receipts.partsOwn = items.map((m) => Object.hasOwn(m, "parts"));
      receipts.emptyOriginal = Object.is(items[1]?.parts, empty);
      break;
    }
    case "parts.media-original": {
      const bytes = new Uint8Array([1, 2, 3]),
        view = bytes.subarray(1);
      const text: ContentPart = { type: "text", text: "invoice" };
      const originalSource: MediaSource = { type: "bytes", data: view };
      const image: ContentPart = {
        type: "image",
        mediaType: "image/png",
        source: originalSource,
      };
      const file: ContentPart = {
        type: "file",
        mediaType: "application/pdf",
        source: { type: "url", url: "invoice.pdf" },
      };
      const parts = [text, image, file];
      const result = invoke(
        prompt([turn("media")], [record("media", 0)]),
        () => parts,
      );
      messages = result;
      const item = result[1];
      assert.ok(item?.role === "tool");
      receipts.partsOwnerOriginal = Object.is(item.parts, parts);
      receipts.partOwnersOriginal = item.parts?.every((p, i) =>
        Object.is(p, parts[i]),
      );
      const actualImage = item.parts?.[1];
      receipts.mediaSourceOriginal =
        actualImage?.type === "image" &&
        Object.is(actualImage.source, originalSource);
      bytes[1] = 9;
      after = snapshot(item.parts);
      receipts.mediaBufferShared = view[0] === 9;
      break;
    }
    case "parts.error-callback": {
      const outcome: ToolOutcome<unknown> = {
          kind: "error",
          _tag: "declined",
          reason: "no",
        },
        parts: ContentPart[] = [{ type: "text", text: "error explanation" }];
      const result = invoke(
        prompt([turn("failure")], [record("failed", 0, outcome)]),
        (_call, value) => {
          trace.push(value.kind);
          return parts;
        },
      );
      messages = result;
      const item = result[1];
      assert.ok(item?.role === "tool");
      receipts.outcomeOriginal = Object.is(item.outcome, outcome);
      receipts.partsOriginal = Object.is(item.parts, parts);
      break;
    }
    case "parts.failure-prefix": {
      messages = invoke(
        prompt(
          [turn("prefix")],
          [record("first", 0), record("second", 0), record("third", 0)],
        ),
        (call) => {
          trace.push(call.callId);
          if (call.callId === "second") throw originalFailure;
          return null;
        },
      );
      break;
    }
    case "indices.exact-number": {
      const rows = [
        record("zero", 0),
        record("negative-zero", -0),
        record("fraction", 0.5),
        record("negative", -1),
        record("nan", NaN),
        record("positive-infinity", Infinity),
        record("negative-infinity", -Infinity),
        record("future", 2),
      ];
      messages = invoke(prompt([turn("indices")], rows), (call) => {
        trace.push(call.callId);
        return null;
      });
      break;
    }
    case "indices.raw-null": {
      profile =
        "RAW-INPUT/runtime-qualified: null record.turn, no published restore claimed";
      const raw = {
        ...prompt([turn("raw null")], [record("real-zero", 0)]),
        conversation: {
          ...conversation([turn("raw null")]),
          toolRecords: [
            { ...record("null-record", 0), turn: null },
            record("real-zero", 0),
          ],
        },
      };
      argumentsBefore.push(snapshot({ prompt: raw, partsProvided: true }));
      fs.writeFileSync(
        `${packet.response}.arguments.json`,
        `${JSON.stringify(argumentsBefore, null, 2)}\n`,
      );
      const parts: ToolPartsOf = (call) => {
        trace.push(call.callId);
        return null;
      };
      const actual: unknown = Reflect.apply(renderPrompt, undefined, [
        raw,
        parts,
      ]);
      messages = actual;
      break;
    }
    case "history.turn-count-ignored": {
      const base = prompt([turn("counter")], [record("r", 0)]);
      const a = invoke(base),
        b = invoke({
          ...base,
          conversation: {
            ...base.conversation,
            turnCount: 99,
            awaiting: { kind: "compacting", folding: 7 },
            contextTokens: 500,
          },
        });
      messages = { first: a, second: b };
      receipts.sameMessages = JSON.stringify(a) === JSON.stringify(b);
      break;
    }
    case "render.repeat-no-cache": {
      const originalTurn = turn("repeat"),
        p = prompt([originalTurn], [record("r", 0)]);
      const parts: ToolPartsOf = (call) => {
        trace.push(call.callId);
        return null;
      };
      const a = invoke(p, parts),
        b = invoke(p, parts);
      messages = { first: a, second: b };
      receipts.sameReturnedArray = Object.is(a, b);
      receipts.sameAssistantWrapper = Object.is(a[0], b[0]);
      const one = a[0],
        two = b[0];
      assert.ok(one?.role === "assistant" && two?.role === "assistant");
      receipts.originalToolCallsBoth =
        Object.is(one.toolCalls, originalTurn.toolCalls) &&
        Object.is(two.toolCalls, originalTurn.toolCalls);
      break;
    }
    case "parts.mutate-after-render": {
      const original: ContentPart = { type: "text", text: "first" },
        shared: ContentPart[] = [original];
      const result = invoke(
        prompt([turn("mutable")], [record("one", 0), record("two", 0)]),
        (call) => {
          trace.push(call.callId);
          if (call.callId === "two")
            shared.push({ type: "text", text: "during callback" });
          return shared;
        },
      );
      messages = snapshot(result);
      const first = result[1];
      assert.ok(first?.role === "tool");
      receipts.partsOriginal = Object.is(first.parts, shared);
      receipts.secondCallbackMutationVisible = first.parts?.length === 2;
      shared.push({ type: "text", text: "after render" });
      after = snapshot(result);
      receipts.afterRenderMutationVisible = first.parts?.length === 3;
      receipts.originalPartOwner = Object.is(first.parts?.[0], original);
      break;
    }
    case "port.invoice-native-and-raw": {
      const read = record("invoice-read", 0),
        check = record("invoice-check", 1);
      const provider = { adapter: "original" };
      const p = prompt(
        [
          { ...turn("read", [read.call]), provider },
          turn("check", [check.call]),
          turn("done"),
        ],
        [read, check],
        "Invoice policy",
        "inv-17",
      );
      const seen: unknown[] = [];
      let parses = 0,
        invokes = 0;
      for (const mode of ["typed", "guarded-raw"] as const) {
        if (mode === "guarded-raw")
          receipts.guardedRawHistoryOriginal = p.conversation.turns.every(
            (prior) => Object.is(agentTurnSchema.parse(prior), prior),
          );
        const answer: AgentTurn =
          mode === "typed"
            ? turn("accepted")
            : agentTurnSchema.parse({ content: "accepted", toolCalls: [] });
        const llm = createLlmCall<"invoice", { invoice: AgentTurn }>({
          schemas: {
            invoice: {
              parse(value: unknown) {
                parses++;
                return agentTurnSchema.parse(value);
              },
            },
          },
        });
        const input = { purpose: "invoice" as const, model: null, payload: p };
        let batch: readonly AgentMessage[] | undefined;
        const loader: MessageLoader<"invoice", AgentMessage> = async (
          actual,
        ) => {
          trace.push(`${mode}:loader`);
          receipts[`${mode}RequestOriginal`] = Object.is(actual, input);
          receipts[`${mode}PayloadOriginal`] = Object.is(actual.payload, p);
          batch = invoke(p, (call) => {
            trace.push(`${mode}:parts:${call.callId}`);
            return null;
          });
          return batch;
        };
        const model: PlainModel<AgentMessage, AgentTurn> = async (actual) => {
          trace.push(`${mode}:model`);
          invokes++;
          receipts[`${mode}MessagesOriginal`] = Object.is(actual, batch);
          seen.push(snapshot(actual));
          const assistant = actual[2],
            tool = actual[3];
          assert.ok(assistant?.role === "assistant" && tool?.role === "tool");
          receipts[`${mode}ProviderOriginal`] = Object.is(
            assistant.provider,
            provider,
          );
          receipts[`${mode}ToolCallsOriginal`] = Object.is(
            assistant.toolCalls,
            p.conversation.turns[0]?.toolCalls,
          );
          receipts[`${mode}OutcomeOriginal`] = Object.is(
            tool.outcome,
            read.outcome,
          );
          return answer;
        };
        const [, commands] = llm.attempt(llm.init(), input, 0);
        const command = commands[0];
        assert.ok(command);
        const outcome = await brainHandler(llm, {
          loadMessages: loader,
          model: plainModel(model),
        })(command);
        assert.equal(outcome._tag, "Ok");
        if (outcome._tag === "Ok")
          receipts[`${mode}OutputOriginal`] = Object.is(
            outcome.value.output,
            answer,
          );
      }
      messages = seen;
      receipts.parses = parses;
      receipts.modelInvokes = invokes;
      break;
    }
  }
} catch (cause) {
  error = {
    originalCause: Object.is(cause, originalFailure),
    name: cause instanceof Error ? cause.name : typeof cause,
    message: cause instanceof Error ? cause.message : String(cause),
  };
}
const view = snapshot({ messages, receipts, trace, error, after });
const response = {
  id: packet.id,
  profile,
  engine: {
    node: process.version,
    v8: process.versions.v8,
    icu: process.versions.icu,
    locale: Intl.Collator().resolvedOptions().locale,
  },
  argumentsBefore,
  view,
};
fs.writeFileSync(packet.response, `${JSON.stringify(response, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(response)}\n`);
assert.deepEqual(view, packet.expected);
