import readline from "node:readline";
import { z } from "zod";
import {
  COMPACTION_PURPOSE,
  compactionSummarySchema,
  isCompactionSummary,
} from "../../packages/tea/src/agent/compaction.ts";
import {
  addUsage,
  dedupeByCallId,
  foldSummary,
  freshConversation,
  NO_USAGE,
} from "../../packages/tea/src/agent/internal.ts";
import {
  type AgentTurn,
  agentTurnSchema,
  type Conversation,
  isAgentTurn,
  isTurnUsage,
  type ToolFailure,
  type ToolOutcome,
} from "../../packages/tea/src/agent/types.ts";

const json = (value: unknown) => JSON.stringify(value) ?? null;
function describe(value: unknown): unknown {
  if (value === undefined) return { $value: "undefined" };
  if (
    typeof value === "number" &&
    (!Number.isFinite(value) || Object.is(value, -0))
  )
    return { $value: Object.is(value, -0) ? "-0" : String(value) };
  if (Array.isArray(value)) return value.map(describe);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, value]) => [key, describe(value)]),
    );
  return value;
}
function inflate(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(inflate);
  if (value !== null && typeof value === "object") {
    const fields = Object.entries(value);
    if (fields.length === 1 && fields[0][0] === "$value") {
      const name = fields[0][1];
      switch (name) {
        case "undefined":
          return undefined;
        case "NaN":
          return Number.NaN;
        case "Infinity":
          return Infinity;
        case "-Infinity":
          return -Infinity;
        case "-0":
          return -0;
        default:
          throw new Error("unknown value descriptor");
      }
    }
    return Object.fromEntries(
      fields.map(([key, value]) => [key, inflate(value)]),
    );
  }
  return value;
}
const observation = (value: unknown) => ({
  value: describe(value),
  json: json(value),
});
const raw = z.custom<unknown>(() => true);
const numeric = z.custom<number>((value) => typeof value === "number");
const requiredValue = z
  .object({ value: raw })
  .strict()
  .refine((input) => Object.hasOwn(input, "value"));
const usage = z
  .object({
    inputTokens: numeric,
    outputTokens: numeric,
    reasoningTokens: numeric.optional(),
    cachedInputTokens: numeric.optional(),
  })
  .strict();
const call = z
  .object({
    callId: z.string(),
    name: z.string(),
    args: z.custom<Readonly<Record<string, unknown>>>(
      (value) => value !== null && typeof value === "object",
    ),
  })
  .strict();
const mutation = z
  .object({
    target: z.string(),
    index: z.number().int().nonnegative(),
    key: z.string(),
    value: raw,
  })
  .strict();
const request = z
  .object({
    id: z.string(),
    operation: z.enum([
      "guards",
      "add",
      "dedupe",
      "fold",
      "fresh",
      "vocabulary",
    ]),
    input: raw,
  })
  .strict();
function parse(schema: { parse(value: unknown): unknown }, value: unknown) {
  try {
    const parsed = schema.parse(value);
    return {
      ok: true,
      sameOriginal: parsed === value,
      observation: observation(parsed),
    };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { ok: false, error: { name: error.name, message: error.message } };
  }
}
function mutate(value: unknown, key: string, changed: unknown) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("mutation fixture target must be an object");
  Object.defineProperty(value, key, {
    value: changed,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}
function at<T>(values: readonly T[], index: number): T {
  if (index >= values.length) throw new Error("fixture index out of range");
  return values[index];
}
const turn = z.custom<AgentTurn>(isAgentTurn);
const failed = z.custom<ToolFailure>(
  (value) =>
    value !== null &&
    typeof value === "object" &&
    Reflect.get(value, "kind") === "error" &&
    typeof Reflect.get(value, "reason") === "string",
);
const foldInput = z
  .object({
    turns: z.array(turn),
    calls: z.array(call),
    outcomes: z.array(
      z.union([
        z.object({ Ok: raw }).strict(),
        z.object({ Error: failed }).strict(),
      ]),
    ),
    records: z.array(
      z
        .object({
          call: z.number().int().nonnegative(),
          outcome: z.number().int().nonnegative(),
          turn: numeric,
        })
        .strict(),
    ),
    summary: turn,
    folding: numeric,
    turnCount: numeric,
    awaiting: z.union([
      z.literal("Llm"),
      z.object({ Tools: numeric }).strict(),
      z.object({ Compacting: numeric }).strict(),
    ]),
    contextTokens: numeric.nullable().optional(),
    mutations: z.array(mutation).default([]),
  })
  .strict();
function execute(rawRequest: unknown): unknown {
  const inputRequest = request.parse(rawRequest);
  switch (inputRequest.operation) {
    case "guards": {
      const input = requiredValue.parse(inputRequest.input);
      const value = inflate(input.value);
      return {
        usage: isTurnUsage(value),
        turn: isAgentTurn(value),
        summary: isCompactionSummary(value),
        turnParsed: parse(agentTurnSchema, value),
        summaryParsed: parse(compactionSummarySchema, value),
      };
    }
    case "add": {
      const input = z
        .object({ left: usage, right: usage })
        .strict()
        .parse(inflate(inputRequest.input));
      const sum = addUsage(input.left, input.right);
      return {
        sum: observation(sum),
        left: describe(input.left),
        right: describe(input.right),
        fresh: sum !== input.left && sum !== input.right,
      };
    }
    case "dedupe": {
      const input = z
        .object({
          calls: z.array(call),
          mutations: z.array(mutation).default([]),
        })
        .strict()
        .parse(inflate(inputRequest.input));
      for (const changed of input.mutations)
        if (changed.target !== "args" || changed.index >= input.calls.length)
          throw new Error("invalid dedupe mutation fixture");
      const unique = dedupeByCallId(input.calls);
      for (const changed of input.mutations)
        mutate(at(input.calls, changed.index).args, changed.key, changed.value);
      return {
        calls: observation(unique),
        indices: unique.map((value) => input.calls.indexOf(value)),
        fresh: unique !== input.calls,
      };
    }
    case "fold": {
      const input = foldInput.parse(inflate(inputRequest.input));
      const outcomes: ToolOutcome<unknown>[] = input.outcomes.map((value) =>
        "Ok" in value ? { kind: "ok", result: value.Ok } : value.Error,
      );
      const records = input.records.map((value) => ({
        call: at(input.calls, value.call),
        outcome: at(outcomes, value.outcome),
        turn: value.turn,
      }));
      const awaiting =
        input.awaiting === "Llm"
          ? { kind: "llm" as const }
          : "Tools" in input.awaiting
            ? { kind: "tools" as const, batchTurn: input.awaiting.Tools }
            : {
                kind: "compacting" as const,
                folding: input.awaiting.Compacting,
              };
      // A missing legacy context field remains missing on the input; fold fills null.
      const conversation = {
        turns: input.turns,
        toolRecords: records,
        turnCount: input.turnCount,
        awaiting,
        ...(Object.hasOwn(input, "contextTokens")
          ? { contextTokens: input.contextTokens }
          : {}),
      };
      for (const changed of input.mutations) {
        if (
          !(
            (changed.target === "turn" && changed.index < input.turns.length) ||
            (changed.target === "args" && changed.index < input.calls.length) ||
            (changed.target === "outcome" && changed.index < outcomes.length) ||
            (changed.target === "summary" && changed.index === 0)
          )
        )
          throw new Error("invalid fold mutation fixture");
      }
      // The source type marks contextTokens required but old durable data omits
      // it; this call is the actual pure helper at that measured raw boundary.
      const folded = Reflect.apply(foldSummary, undefined, [
        conversation,
        input.folding,
        input.summary,
      ]) as Conversation<unknown>;
      for (const changed of input.mutations) {
        const value =
          changed.target === "turn"
            ? at(input.turns, changed.index)
            : changed.target === "args"
              ? at(input.calls, changed.index).args
              : changed.target === "summary"
                ? input.summary
                : (() => {
                    const outcome = at(outcomes, changed.index);
                    return outcome.kind === "ok" ? outcome.result : outcome;
                  })();
        mutate(value, changed.key, changed.value);
      }
      return {
        folded: observation(folded),
        original: observation(conversation),
        turnIndices: folded.turns.map((value) => input.turns.indexOf(value)),
        summarySame: folded.turns[0] === input.summary,
        recordIndices: folded.toolRecords.map((value) =>
          records.indexOf(value),
        ),
        callIndices: folded.toolRecords.map((value) =>
          input.calls.indexOf(value.call),
        ),
        outcomeIndices: folded.toolRecords.map((value) =>
          outcomes.indexOf(value.outcome),
        ),
        fresh: folded !== conversation,
        freshTurns: folded.turns !== conversation.turns,
        freshRecords: folded.toolRecords !== conversation.toolRecords,
      };
    }
    case "fresh": {
      z.object({}).strict().parse(inputRequest.input);
      const first = freshConversation<unknown>(),
        second = freshConversation<unknown>();
      return {
        conversation: observation(first),
        noUsage: observation(NO_USAGE),
        fresh: first !== second,
        freshTurns: first.turns !== second.turns,
        freshRecords: first.toolRecords !== second.toolRecords,
        hasUsage: Object.hasOwn(first, "usage"),
      };
    }
    case "vocabulary": {
      const input = z
        .object({ summary: z.string() })
        .strict()
        .parse(inputRequest.input);
      return {
        purpose: COMPACTION_PURPOSE,
        purposeWire: COMPACTION_PURPOSE,
        summary: observation({ summary: input.summary }),
      };
    }
  }
}
for await (const line of readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})) {
  let input: unknown;
  try {
    input = JSON.parse(line);
  } catch (error) {
    console.log(JSON.stringify({ id: null, ok: false, error: String(error) }));
    continue;
  }
  const id =
    input !== null &&
    typeof input === "object" &&
    typeof Reflect.get(input, "id") === "string"
      ? Reflect.get(input, "id")
      : null;
  try {
    console.log(JSON.stringify({ id, ok: true, output: execute(input) }));
  } catch (error) {
    console.log(JSON.stringify({ id, ok: false, error: String(error) }));
  }
}
