import readline from "node:readline";
import { z } from "zod";
import {
  currentStage,
  freshConversation,
  isSettled,
  NO_USAGE,
  requireAwaiting,
  withUsageDefaults,
} from "../../packages/tea/src/agent/internal.ts";
import { initFanOut } from "../../packages/tea/src/internal/flow/fan-out/index.ts";
import { createMonitoredRun } from "../../packages/tea/src/internal/flow/monitored-run/index.ts";
import { createLlmCall } from "../../packages/tea/src/internal/llm-call/index.ts";
export const scriptSchema = z
  .object({
    operation: z.enum(["usage", "inspect", "cold"]),
    usage: z.enum(["absent", "undefined", "null", "current", "zero", "wire"]),
    legacy: z.enum(["absent", "undefined", "null", "value"]),
    context: z.enum(["absent", "undefined", "null", "number"]),
    failure: z.enum(["absent", "undefined", "null", "wire"]),
    phase: z.enum(["idle", "running", "stale", "done", "failed", "cancelled"]),
    conversation: z.boolean(),
    awaiting: z.enum(["llm", "tools", "compacting"]),
    stages: z.enum(["two", "undefined-first", "empty"]),
    annotation: z.enum(["none", "turn_limit", "elapsed_limit", "llm"]),
  })
  .strict();
export type Script = z.infer<typeof scriptSchema>;
export function encoded(script: Script) {
  const stages =
    script.stages === "empty"
      ? []
      : script.stages === "undefined-first"
        ? [undefined, { name: "later" }]
        : [{ name: "original" }, { name: "later" }];
  const run = createMonitoredRun({ stages }),
    live = run.start(run.init(), "r", 0)[0];
  let runState: Record<string, unknown> = { ...live, phase: script.phase };
  if (script.stages === "undefined-first")
    runState.stepStates = live.stepStates.map((v, i) =>
      i === 1 ? { ...v, status: "running" } : v,
    );
  if (script.phase === "idle") {
    const { runId: _ignored, ...rest } = runState;
    runState = rest;
  }
  if (script.phase === "failed")
    runState.failure = { reason: "deadline", at: null };
  if (script.phase === "cancelled") runState.at = null;
  const llm = createLlmCall({ schemas: { turn: { parse: (v) => v } } }),
    compact = createLlmCall({ schemas: { $compact: { parse: (v) => v } } });
  const conv = script.conversation
    ? {
        ...freshConversation(),
        turns: [
          {
            content: "original\ud800",
            toolCalls: [],
            provider: { "\udfff": 1 },
          },
        ],
        toolRecords: [],
        turnCount: null,
        awaiting:
          script.awaiting === "llm"
            ? { kind: "llm" }
            : script.awaiting === "tools"
              ? { kind: "tools", batchTurn: null }
              : { kind: "compacting", folding: null },
      }
    : null;
  const state = {
    run: runState,
    resilience: llm.init(),
    tools: initFanOut(),
    conversation: conv,
    usage: { inputTokens: null, outputTokens: 4 },
    compaction: compact.init(),
    toolResilience: {},
    refusedCalls: ["original"],
    lifecycle: [
      {
        kind: "brain_started",
        turn: null,
        purpose: "turn\ud800",
        model: null,
        at: null,
      },
      {
        kind: "tool_started",
        call: { callId: "c", name: "t", args: { "\ud800": 1 } },
        at: null,
      },
      {
        kind: "tool_failed",
        call: { callId: "c", name: "t", args: {} },
        failure: { kind: "error", reason: "bad", "\udfff": 1 },
        at: null,
      },
      { kind: "run_ended", at: null },
    ],
    failure:
      script.annotation === "none"
        ? null
        : script.annotation === "llm"
          ? {
              reason: "llm",
              error: { message: "original\ud800", "\udfff": 1 },
              at: null,
            }
          : { reason: script.annotation, at: null },
    output: null,
    instructions: "prompt\ud800",
  };
  return JSON.stringify(state);
}
export function input(script: Script) {
  return {
    encoded: encoded(script),
    operation: script.operation,
    usage: script.usage,
    legacy: script.legacy,
    context: script.context,
    failure: script.failure,
  };
}
const kinds = ["llm", "tools", "compacting"] as const;
function field(value: object, name: string) {
  return !Object.hasOwn(value, name)
    ? "absent"
    : Reflect.get(value, name) === undefined
      ? "undefined"
      : Reflect.get(value, name) === null
        ? "null"
        : "value";
}
export function execute(x: ReturnType<typeof input>) {
  let state = JSON.parse(x.encoded);
  const current = { inputTokens: 3, outputTokens: 4 },
    legacy = { inputTokens: 5, outputTokens: 6 },
    zero = NO_USAGE;
  const set = (
    v: Record<string, unknown>,
    name: string,
    form: string,
    extra: unknown,
  ) => {
    if (form === "absent") delete v[name];
    else if (form === "undefined") v[name] = undefined;
    else if (form === "null") v[name] = null;
    else if (form !== "wire") v[name] = extra;
  };
  set(state, "usage", x.usage, x.usage === "zero" ? zero : current);
  set(state, "failure", x.failure, null);
  if (state.conversation !== null) {
    set(state.conversation, "usage", x.legacy, legacy);
    set(state.conversation, "contextTokens", x.context, 17);
  }
  if (x.operation === "cold") state = JSON.parse(JSON.stringify(state));
  if (x.operation === "inspect") {
    const stage = currentStage(state);
    return {
      stage: stage === undefined ? { $undefined: true } : stage,
      settled: isSettled(state),
      matches: kinds.map(
        (kind) =>
          requireAwaiting(state, kind) === state.conversation &&
          state.conversation !== null,
      ),
      failureKind: field(state, "failure"),
    };
  }
  const after = withUsageDefaults(state);
  const usageOrigin =
    after.usage === undefined
      ? field(after, "usage")
      : after.usage === null
        ? "null"
        : after.usage === current
          ? "current"
          : after.usage === legacy
            ? "legacy"
            : after.usage === zero
              ? "zero"
              : "other";
  return {
    before: JSON.parse(JSON.stringify(state)),
    after: JSON.parse(JSON.stringify(after)),
    stateSame: after === state,
    conversationSame: after.conversation === state.conversation,
    arraysSame:
      (after.conversation === null && state.conversation === null) ||
      (after.conversation !== null &&
        state.conversation !== null &&
        after.conversation.turns === state.conversation.turns &&
        after.conversation.toolRecords === state.conversation.toolRecords),
    usageOrigin,
    usageKind: field(after, "usage"),
    legacyKind:
      after.conversation === null ? "none" : field(after.conversation, "usage"),
    failureKind: field(after, "failure"),
    composedSame: (
      [
        "run",
        "resilience",
        "tools",
        "compaction",
        "toolResilience",
        "refusedCalls",
        "lifecycle",
      ] as const
    ).every((k) => after[k] === state[k]),
    wire: JSON.stringify(after),
  };
}
if (process.argv[1]?.endsWith("agent-state-reference.mts"))
  for await (const line of readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  })) {
    const r = z
      .object({
        id: z.string(),
        input: scriptSchema
          .pick({
            operation: true,
            usage: true,
            legacy: true,
            context: true,
            failure: true,
          })
          .extend({ encoded: z.string() })
          .strict(),
      })
      .strict()
      .parse(JSON.parse(line));
    try {
      console.log(
        JSON.stringify({ id: r.id, ok: true, output: execute(r.input) }),
      );
    } catch (error) {
      console.log(
        JSON.stringify({ id: r.id, ok: false, error: String(error) }),
      );
    }
  }
