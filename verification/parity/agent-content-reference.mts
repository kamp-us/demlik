import { createInterface } from "node:readline";
import { z } from "zod";
import {
  contentParts,
  omitMedia,
} from "../../packages/tea/src/agent/content.ts";
import { AGENT_EVENT_TYPES } from "../../packages/tea/src/agent/machine.ts";
import {
  type TranscriptSeed,
  transcript,
} from "../../packages/tea/src/agent/transcript.ts";
import {
  agentTurnSchema,
  type ToolRecord,
} from "../../packages/tea/src/agent/types.ts";

const byte = z.number().int().min(0).max(255),
  index = z.number().int().nonnegative();
const write = z.strictObject({ index, value: byte });
const media = z
  .strictObject({
    bytes: z.array(byte),
    range: z.tuple([index, index]),
    backingWrite: write.nullable().optional(),
    viewWrite: write.nullable().optional(),
    copyWrite: write.nullable().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.range[0] > v.range[1] || v.range[1] > v.bytes.length)
      ctx.addIssue({ code: "custom", message: "view outside buffer" });
    for (const [length, w] of [
      [v.bytes.length, v.backingWrite],
      [v.range[1] - v.range[0], v.viewWrite],
      [v.range[1] - v.range[0], v.copyWrite],
    ] as const)
      if (w && w.index >= length)
        ctx.addIssue({ code: "custom", message: "write outside view" });
  });
const source = z.union([
  z.strictObject({ Base64: z.strictObject({ data: z.string() }) }),
  z.literal("Bytes"),
  z.strictObject({ Url: z.strictObject({ url: z.string() }) }),
]);
const part = z.union([
  z.strictObject({ Text: z.strictObject({ text: z.string() }) }),
  z.strictObject({ Image: z.strictObject({ mediaType: z.string(), source }) }),
  z.strictObject({ File: z.strictObject({ mediaType: z.string(), source }) }),
  z.strictObject({ Reuse: z.strictObject({ index }) }),
]);
const contentInput = z.strictObject({
  text: z.string(),
  parts: z.array(part),
  media,
  appendText: z.string(),
});
const encoded = z
  .strictObject({
    kind: z.enum([
      "json",
      "undefined",
      "nan",
      "infinity",
      "negative-infinity",
      "negative-zero",
    ]),
    value: z.unknown().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "json" && !Object.hasOwn(v, "value"))
      ctx.addIssue({ code: "custom", message: "json value missing" });
  });
const valueDef = z.strictObject({
  value: encoded,
  media: z.boolean().default(false),
});
const seedTool = z.union([
  z.strictObject({ Ok: z.strictObject({ callId: z.string(), result: index }) }),
  z.strictObject({ Error: z.strictObject({ callId: z.string() }) }),
  z.strictObject({ Reuse: z.strictObject({ index }) }),
]);
const usage = z.strictObject({
  inputTokens: z.number(),
  outputTokens: z.number(),
  reasoningTokens: z.number().nullable().optional(),
  cachedInputTokens: z.number().nullable().optional(),
});
const status = z.union([
  z.strictObject({
    Done: z.strictObject({ output: index.nullable().optional(), usage }),
  }),
  z.strictObject({ Failed: z.strictObject({ failure: index }) }),
  z.strictObject({ Cancelled: z.strictObject({ at: z.number() }) }),
]);
const event = z.union([
  z.strictObject({ BrainStarted: z.strictObject({ payload: index }) }),
  z.strictObject({ TurnSettled: z.strictObject({ turn: index }) }),
  z.strictObject({
    ToolStarted: z.strictObject({ args: index, callId: z.string() }),
  }),
  z.strictObject({
    ToolSettled: z.strictObject({ result: index, callId: z.string() }),
  }),
  z.strictObject({
    ToolFailed: z.strictObject({ failure: index, callId: z.string() }),
  }),
  z.strictObject({ RunDone: z.strictObject({ status: index }) }),
]);
const transcriptInput = z.strictObject({
  values: z.array(valueDef),
  seed: z
    .strictObject({ turns: z.array(index), tools: z.array(seedTool) })
    .nullable()
    .optional(),
  statuses: z.array(status),
  events: z.array(event),
  changes: z.array(z.strictObject({ index, key: z.string(), value: encoded })),
  clearFirst: z.boolean().default(false),
  media,
});
const canonicalInput = z.strictObject({
  content: z.string(),
  toolCalls: z.array(
    z.strictObject({
      callId: z.string(),
      name: z.string(),
      args: z.custom<Record<string, unknown>>(
        (value: unknown): value is Record<string, unknown> =>
          value !== null && typeof value === "object" && !Array.isArray(value),
      ),
    }),
  ),
  provider: encoded.nullable().optional(),
  usage: usage.nullable().optional(),
  head: z.strictObject({ runId: z.string(), at: z.number() }),
});
const request = z.discriminatedUnion("operation", [
  z.strictObject({
    id: z.string(),
    operation: z.literal("content"),
    input: contentInput,
  }),
  z.strictObject({
    id: z.string(),
    operation: z.literal("transcript"),
    input: transcriptInput,
  }),
  z.strictObject({
    id: z.string(),
    operation: z.literal("canonical-turn"),
    input: canonicalInput,
  }),
  z
    .strictObject({
      id: z.string(),
      operation: z.literal("raw-seed"),
      input: z.unknown(),
    })
    .refine((v) => Object.hasOwn(v, "input"), "input required"),
]);
function raw<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
function mediaOf(input: z.infer<typeof media>) {
  const backing = new Uint8Array(input.bytes),
    view = backing.subarray(input.range[0], input.range[1]),
    copy = view.slice();
  return { backing, view, copy };
}
function mediaData(m: ReturnType<typeof mediaOf>) {
  return {
    backing: Array.from(m.backing),
    view: Array.from(m.view),
    copy: Array.from(m.copy),
    offset: m.view.byteOffset,
    len: m.view.length,
    sameView: m.view === m.backing,
    sameBuffer: m.view.buffer === m.backing.buffer,
    copySameView: m.copy === m.view,
    copySameBuffer: m.copy.buffer === m.view.buffer,
  };
}
function mutateMedia(
  m: ReturnType<typeof mediaOf>,
  input: z.infer<typeof media>,
) {
  if (input.backingWrite)
    m.backing[input.backingWrite.index] = input.backingWrite.value;
  if (input.viewWrite) m.view[input.viewWrite.index] = input.viewWrite.value;
  if (input.copyWrite) m.copy[input.copyWrite.index] = input.copyWrite.value;
}
function content(input: z.infer<typeof contentInput>) {
  const m = mediaOf(input.media),
    parts: ReturnType<typeof contentParts>[number][] = [];
  const sourceOf = (s: z.infer<typeof source>) =>
    typeof s === "string"
      ? { type: "bytes" as const, data: m.view }
      : "Base64" in s
        ? { type: "base64" as const, data: s.Base64.data }
        : { type: "url" as const, url: s.Url.url };
  for (const p of input.parts)
    parts.push(
      "Text" in p
        ? { type: "text", text: p.Text.text }
        : "Image" in p
          ? {
              type: "image",
              mediaType: p.Image.mediaType,
              source: sourceOf(p.Image.source),
            }
          : "File" in p
            ? {
                type: "file",
                mediaType: p.File.mediaType,
                source: sourceOf(p.File.source),
              }
            : parts[p.Reuse.index],
    );
  const first = contentParts(input.text),
    second = contentParts(input.text),
    passed = contentParts(parts),
    repeated = contentParts(parts),
    omitted = omitMedia(parts),
    another = omitMedia(parts);
  const initial = raw(parts),
    omittedRetained = omitted.map((p, i) => p === parts[i]),
    omittedRepeatSame = omitted.map((p, i) => p === another[i]),
    omittedSame = omitted.map((a) => omitted.map((b) => a === b)),
    before = mediaData(m);
  parts.push({ type: "text", text: input.appendText });
  mutateMedia(m, input.media);
  return {
    stringParts: first,
    stringFreshArray: first !== second,
    stringFreshPart: first[0] !== second[0],
    passedSameArray: passed === parts,
    repeatedSameArray: repeated === parts,
    initial,
    omitted,
    omitFreshArray: omitted !== parts,
    omitRepeatFreshArray: omitted !== another,
    omittedRetained,
    omittedRepeatSame,
    omittedSame,
    afterMutation: passed,
    mediaBefore: before,
    mediaAfter: mediaData(m),
    byteSourceViews: parts.flatMap((p) =>
      p.type !== "text" && p.source.type === "bytes"
        ? [p.source.data === m.view]
        : [],
    ),
  };
}
function decode(value: z.infer<typeof encoded>): unknown {
  switch (value.kind) {
    case "json":
      return value.value;
    case "undefined":
      return undefined;
    case "nan":
      return Number.NaN;
    case "infinity":
      return Infinity;
    case "negative-infinity":
      return -Infinity;
    case "negative-zero":
      return -0;
  }
}
function own(value: unknown, key: string, data: unknown) {
  if (
    value === null ||
    Array.isArray(value) ||
    (typeof value !== "object" && typeof value !== "function")
  )
    throw new Error("changed value must be an object");
  Object.defineProperty(value, key, {
    value: data,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}
function usageOf(value: z.infer<typeof usage>) {
  return {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    ...(value.reasoningTokens == null
      ? {}
      : { reasoningTokens: value.reasoningTokens }),
    ...(value.cachedInputTokens == null
      ? {}
      : { cachedInputTokens: value.cachedInputTokens }),
  };
}
function runTranscript(input: z.infer<typeof transcriptInput>) {
  const m = mediaOf(input.media),
    before = mediaData(m),
    values = input.values.map((def) => {
      const value = decode(def.value);
      if (def.media) own(value, "media", m.view);
      return value;
    });
  const statuses = input.statuses.map((s) =>
    "Done" in s
      ? {
          kind: "done",
          output: s.Done.output == null ? null : values[s.Done.output],
          usage: usageOf(s.Done.usage),
        }
      : "Failed" in s
        ? { kind: "failed", failure: values[s.Failed.failure] }
        : { kind: "cancelled", at: s.Cancelled.at },
  );
  const turns =
      input.seed?.turns.map((i) => agentTurnSchema.parse(values[i])) ?? [],
    records: ToolRecord<unknown>[] = [];
  for (const record of input.seed?.tools ?? [])
    records.push(
      "Reuse" in record
        ? records[record.Reuse.index]
        : {
            call: {
              callId: "Ok" in record ? record.Ok.callId : record.Error.callId,
              name: "tool",
              args: {},
            },
            outcome:
              "Ok" in record
                ? { kind: "ok", result: values[record.Ok.result] }
                : { kind: "error", reason: "failed" },
            turn: 1,
          },
    );
  const seed: TranscriptSeed<unknown> | undefined = input.seed
    ? {
        conversation: {
          turns,
          toolRecords: records,
          turnCount: 1,
          awaiting: { kind: "llm" },
          contextTokens: null,
        },
      }
    : undefined;
  // The runtime boundary intentionally accepts unknown raw values. These calls
  // exercise the frozen collector itself, rather than reimplement its fold.
  const t = transcript<unknown>(seed),
    onEvent = t.onEvent;
  const emittedTypes: string[] = [];
  const snapshots = [t.read()];
  turns.length = 0;
  records.length = 0;
  for (const e of input.events) {
    const head = { runId: "r", at: 1 };
    const value =
      "BrainStarted" in e
        ? {
            ...head,
            type: "BrainStarted",
            turn: 2,
            purpose: "p",
            model: null,
            payload: values[e.BrainStarted.payload],
          }
        : "TurnSettled" in e
          ? { ...head, type: "TurnSettled", turn: values[e.TurnSettled.turn] }
          : "ToolStarted" in e
            ? {
                ...head,
                type: "ToolStarted",
                callId: e.ToolStarted.callId,
                name: "tool",
                args: values[e.ToolStarted.args],
              }
            : "ToolSettled" in e
              ? {
                  ...head,
                  type: "ToolSettled",
                  callId: e.ToolSettled.callId,
                  result: values[e.ToolSettled.result],
                }
              : "ToolFailed" in e
                ? {
                    ...head,
                    type: "ToolFailed",
                    callId: e.ToolFailed.callId,
                    name: "tool",
                    failure: values[e.ToolFailed.failure],
                  }
                : {
                    ...head,
                    type: "RunDone",
                    status: statuses[e.RunDone.status],
                  };
    emittedTypes.push(value.type);
    Reflect.apply(onEvent, undefined, [value]);
    snapshots.push(t.read());
  }
  for (const c of input.changes) own(values[c.index], c.key, decode(c.value));
  mutateMedia(m, input.media);
  if (input.clearFirst) {
    Reflect.set(snapshots[0].turns, "length", 0);
    Reflect.set(snapshots[0].tools, "length", 0);
  }
  const current = t.read(),
    all = [...snapshots, current],
    allTurns = all.flatMap((s) => s.turns),
    allTools = all.flatMap((s) => s.tools);
  return {
    snapshots,
    current,
    turnSame: allTurns.map((a) => allTurns.map((b) => a === b)),
    toolSame: allTools.map((a) => allTools.map((b) => a === b)),
    resultSame: allTools.map((a) =>
      allTools.map((b) =>
        a.result !== null &&
        typeof a.result === "object" &&
        b.result !== null &&
        typeof b.result === "object"
          ? a.result === b.result
          : null,
      ),
    ),
    outcomeSame: all.map((a) => all.map((b) => a.outcome === b.outcome)),
    outcomeInput: all.map((s) =>
      statuses.map((status) => s.outcome === status),
    ),
    resultMediaViews: allTools.map((tool) =>
      tool.result !== null &&
      typeof tool.result === "object" &&
      "media" in tool.result &&
      tool.result.media instanceof Uint8Array
        ? tool.result.media === m.view
        : null,
    ),
    mediaBefore: before,
    mediaAfter: mediaData(m),
    eventTypes: AGENT_EVENT_TYPES,
    emittedTypes,
  };
}
function canonical(input: z.infer<typeof canonicalInput>) {
  const turn = {
    content: input.content,
    toolCalls: input.toolCalls,
    ...(input.provider ? { provider: decode(input.provider) } : {}),
    ...(input.usage
      ? {
          usage: usageOf(input.usage),
        }
      : {}),
  };
  const t = transcript<unknown>();
  t.onEvent({ type: "TurnSettled", ...input.head, turn });
  const snapshot = t.read();
  return {
    head: input.head,
    snapshot,
    turnRetained: snapshot.turns[0] === turn,
    providerPresent: Object.hasOwn(turn, "provider"),
    usagePresent: Object.hasOwn(turn, "usage"),
  };
}
function rawSeed(seed: unknown) {
  try {
    return { value: Reflect.apply(transcript, undefined, [seed]).read() };
  } catch (error) {
    if (error instanceof Error)
      return { error: { name: error.name, message: error.message } };
    throw error;
  }
}
for await (const line of createInterface({ input: process.stdin })) {
  let id: string | null = null;
  try {
    const input: unknown = JSON.parse(line);
    if (
      input &&
      typeof input === "object" &&
      "id" in input &&
      typeof input.id === "string"
    )
      id = input.id;
    const v = request.parse(input);
    const output =
      v.operation === "content"
        ? content(v.input)
        : v.operation === "transcript"
          ? runTranscript(v.input)
          : v.operation === "canonical-turn"
            ? canonical(v.input)
            : rawSeed(v.input);
    console.log(JSON.stringify({ id, ok: true, output }));
  } catch (error) {
    console.log(JSON.stringify({ id, ok: false, error: String(error) }));
  }
}
