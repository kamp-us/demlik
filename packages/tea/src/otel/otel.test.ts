import { createHash } from "node:crypto";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import {
  type AgentEvent,
  type AgentMachineMsg,
  type AgentTurn,
  agentEvents,
  createAgent,
  type Schema,
  type ToolCall,
} from "../agent/index";
import type { Interpret } from "../index";
import { run } from "../promise";
import {
  agentSpans,
  maskBase64DataUris,
  runTraceId,
  type TraceAgentOptions,
  traceAgent,
} from "./index";
import { sha256Hex } from "./sha256";

// ---------------------------------------------------------------------------
// #331 — `traceAgent` against an in-memory OTel exporter: the span tree, the
// GenAI + Langfuse attributes, the error status and the masking.
// ---------------------------------------------------------------------------

type Purpose = "act";
interface Outputs extends Record<Purpose, AgentTurn> {
  readonly act: AgentTurn;
}
type ToolCmd = { readonly type: "run_tool" } & ToolCall;
type M = AgentMachineMsg<Purpose, Outputs, string>;

const SCREENSHOT = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
const STRIPPED = "[base64 data URI stripped before export]";

const ASK: AgentTurn = {
  content: "let me look",
  toolCalls: [
    { callId: "c1", name: "screenshot", args: { url: "https://tea.run" } },
    { callId: "c2", name: "fetch", args: { url: "https://gone.run" } },
  ],
  usage: { inputTokens: 1200, outputTokens: 40, cachedInputTokens: 1000 },
};
const ANSWER: AgentTurn = { content: "the page is fine", toolCalls: [] };

function scripted(turns: readonly (AgentTurn | Error)[]) {
  let i = 0;
  return () => ({
    withStructuredOutput<T>(_s: Schema<T>) {
      return {
        invoke: async (): Promise<T> => {
          const next = turns[i++] ?? ANSWER;
          if (next instanceof Error) throw next;
          return next as T;
        },
      };
    },
  });
}

/** `screenshot` returns an image as a data URI; `fetch` fails. */
const toolInterpret: Interpret<M, ToolCmd, object> = {
  run_tool: async (cmd) =>
    cmd.name === "fetch"
      ? { type: "agent_tool_err", callId: cmd.callId, reason: "404", at: 0 }
      : {
          type: "agent_tool_ok",
          callId: cmd.callId,
          result: `captured ${SCREENSHOT}`,
          at: 0,
        },
};

function exporterAndTracer() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  return { exporter, tracer: provider.getTracer("tea-test") };
}

// The run clock's first reading, in epoch ms. It is below `performance.now()`
// however young the worker is, which is the range the SDK misreads a bare
// number as process-relative (#367) — so the timing tests fail on that bug
// every time rather than only once the worker has been up past it.
const START = 1;

/** Run one agent to its end with `traceAgent` wired; return the finished spans. */
async function traced(
  turns: readonly (AgentTurn | Error)[],
  opts: Omit<TraceAgentOptions, "tracer"> = {},
) {
  const { exporter, tracer } = exporterAndTracer();
  const agent = createAgent<string, Purpose, Outputs, string, ToolCmd>({
    stages: ["only"],
    model: scripted(turns),
    schemas: { act: { parse: (v) => v as AgentTurn } },
    turnOf: () => "act",
    toolOf: (c) => ({ type: "run_tool", ...c }),
    modelId: "claude-test",
    payloadOf: () => ({ prompt: `look at ${SCREENSHOT}` }),
    rng: () => 0,
  });
  const { machine, interpret, subscribe } = agent.toMachine<object>({
    toolInterpret,
  });
  let clock = START;
  const runtime = await run(machine, {
    ctx: {},
    interpret,
    subscribe,
    clock: () => {
      clock += 10;
      return clock;
    },
    terminal: (s) => agent.isSettled(s),
    events: agentEvents<string, Purpose, Outputs, string>(),
  }).ready;
  const stop = traceAgent(runtime, { tracer, ...opts });
  await runtime.dispatch({ type: "agent_start", runId: "run-1", at: START });
  await runtime.done();
  await runtime.stop();
  stop();
  return exporter.getFinishedSpans();
}

const byName = (spans: readonly ReadableSpan[], name: string) => {
  const found = spans.filter((s) => s.name === name);
  if (found.length === 0) throw new Error(`no span named ${name}`);
  return found;
};
const one = (spans: readonly ReadableSpan[], name: string): ReadableSpan => {
  const [span] = byName(spans, name);
  if (span === undefined) throw new Error(`no span named ${name}`);
  return span;
};
const parentOf = (span: ReadableSpan) => span.parentSpanContext?.spanId;

describe("traceAgent — one run as one span tree", () => {
  it("run → a generation per turn and a tool span per call, in the run's trace", async () => {
    const spans = await traced([ASK, ANSWER]);

    expect(spans.map((s) => s.name).sort()).toEqual([
      "chat claude-test",
      "chat claude-test",
      "execute_tool fetch",
      "execute_tool screenshot",
      "invoke_agent agent",
    ]);
    const root = one(spans, "invoke_agent agent");
    // The trace is the run's: its id is derived from `runId`, and the run span
    // hangs off a detached parent in it, so a resumed process lands here too.
    expect(root.spanContext().traceId).toBe(runTraceId("run-1"));
    expect(root.parentSpanContext?.traceId).toBe(runTraceId("run-1"));
    for (const span of spans) {
      expect(span.spanContext().traceId).toBe(runTraceId("run-1"));
      if (span !== root) expect(parentOf(span)).toBe(root.spanContext().spanId);
    }
  });

  it("carries the GenAI conventions and Langfuse's observation attributes", async () => {
    const spans = await traced([ASK, ANSWER]);

    expect(one(spans, "invoke_agent agent").attributes).toMatchObject({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": "agent",
      "gen_ai.conversation.id": "run-1",
      "langfuse.observation.type": "agent",
      "langfuse.trace.name": "agent",
      "langfuse.observation.output": JSON.stringify(ANSWER),
    });

    const [first, second] = byName(spans, "chat claude-test").sort(
      (a, b) =>
        Number(a.attributes["tea.agent.turn"]) -
        Number(b.attributes["tea.agent.turn"]),
    );
    expect(first?.attributes).toMatchObject({
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": "claude-test",
      "langfuse.observation.type": "generation",
      "langfuse.observation.model.name": "claude-test",
      "langfuse.observation.output": JSON.stringify(ASK),
      "tea.agent.turn": 0,
      "tea.agent.purpose": "act",
      // The usage the provider reported for that turn (#332).
      "gen_ai.usage.input_tokens": 1200,
      "gen_ai.usage.output_tokens": 40,
      "gen_ai.usage.cache_read.input_tokens": 1000,
    });
    expect(second?.attributes["tea.agent.turn"]).toBe(1);
    // A turn that reported no usage carries none, rather than a zero.
    expect(second?.attributes["gen_ai.usage.input_tokens"]).toBeUndefined();

    expect(one(spans, "execute_tool screenshot").attributes).toMatchObject({
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "screenshot",
      "gen_ai.tool.call.id": "c1",
      "langfuse.observation.type": "tool",
      "langfuse.observation.input": JSON.stringify({ url: "https://tea.run" }),
    });
  });

  it("times each span by the transitions that opened and closed it", async () => {
    const spans = await traced([ASK, ANSWER]);
    const root = one(spans, "invoke_agent agent");
    // `agent_start` was dispatched at START — 1 ms past the epoch.
    expect(root.startTime).toEqual([0, 1_000_000]);
    for (const span of spans) {
      const start = span.startTime[0] * 1e9 + span.startTime[1];
      const end = span.endTime[0] * 1e9 + span.endTime[1];
      expect(end).toBeGreaterThanOrEqual(start);
    }
  });

  it("a failed tool is an error span; the run that recovered from it is not", async () => {
    const spans = await traced([ASK, ANSWER]);

    const fetch = one(spans, "execute_tool fetch");
    expect(fetch.status).toEqual({
      code: SpanStatusCode.ERROR,
      message: "404",
    });
    expect(fetch.attributes).toMatchObject({
      "error.type": "tool_error",
      "langfuse.observation.level": "ERROR",
      "langfuse.observation.status_message": "404",
    });
    expect(one(spans, "execute_tool screenshot").status.code).toBe(
      SpanStatusCode.UNSET,
    );
    expect(one(spans, "invoke_agent agent").status.code).toBe(
      SpanStatusCode.UNSET,
    );
  });

  it("a run that fails closes every span it holds, as errors", async () => {
    const spans = await traced([new Error("model down")]);

    expect(spans.map((s) => s.name).sort()).toEqual([
      "chat claude-test",
      "invoke_agent agent",
    ]);
    for (const span of spans) {
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
    }
    expect(one(spans, "invoke_agent agent").attributes["error.type"]).toBe(
      "llm",
    );
  });

  it("strips base64 data URIs from every exported input and output by default", async () => {
    const spans = await traced([ASK, ANSWER]);

    const shot = one(spans, "execute_tool screenshot");
    expect(shot.attributes["langfuse.observation.output"]).toBe(
      JSON.stringify(`captured ${STRIPPED}`),
    );
    const [firstTurn] = byName(spans, "chat claude-test").filter(
      (s) => s.attributes["tea.agent.turn"] === 0,
    );
    expect(firstTurn?.attributes["langfuse.observation.input"]).toBe(
      JSON.stringify({ prompt: `look at ${STRIPPED}` }),
    );
    for (const span of spans) {
      expect(JSON.stringify(span.attributes)).not.toContain("iVBORw0KGgo");
    }
  });

  it("takes a caller's mask instead", async () => {
    const spans = await traced([ASK, ANSWER], { mask: () => "[redacted]" });
    expect(
      one(spans, "execute_tool screenshot").attributes[
        "langfuse.observation.output"
      ],
    ).toBe("[redacted]");
  });
});

describe("agentSpans — the listener form", () => {
  const head = (at: number) => ({ runId: "run-9", at });
  const events: AgentEvent<string>[] = [
    {
      ...head(1),
      type: "BrainStarted",
      turn: 0,
      purpose: "act",
      model: null,
      payload: null,
    },
    { ...head(2), type: "TurnSettled", turn: ASK },
    {
      ...head(3),
      type: "ToolStarted",
      callId: "c1",
      name: "screenshot",
      args: {},
    },
  ];

  it("reads `at` as epoch milliseconds, however small, to the exact HrTime", () => {
    expect(performance.now()).toBeGreaterThanOrEqual(1);
    const { exporter, tracer } = exporterAndTracer();
    const spans = agentSpans<string>({ tracer });
    for (const e of events) spans.onEvent(e);
    spans.onEvent({
      ...head(1_790_000_000_123.5),
      type: "RunDone",
      status: { kind: "cancelled", at: 1_790_000_000_123.5 },
    });

    const done = exporter.getFinishedSpans();
    const root = one(done, "invoke_agent agent");
    expect(root.startTime).toEqual([0, 1_000_000]);
    expect(root.endTime).toEqual([1_790_000_000, 123_500_000]);
    const brain = one(done, "chat");
    expect(brain.startTime).toEqual([0, 1_000_000]);
    expect(brain.endTime).toEqual([0, 2_000_000]);
    expect(one(done, "execute_tool screenshot").startTime).toEqual([
      0, 3_000_000,
    ]);
  });

  it("a cancelled run closes its open spans as warnings, not errors", () => {
    const { exporter, tracer } = exporterAndTracer();
    const spans = agentSpans<string>({ tracer });
    for (const e of events) spans.onEvent(e);
    spans.onEvent({
      ...head(4),
      type: "RunDone",
      status: { kind: "cancelled", at: 4 },
    });

    const done = exporter.getFinishedSpans();
    expect(done.map((s) => s.name).sort()).toEqual([
      "chat",
      "execute_tool screenshot",
      "invoke_agent agent",
    ]);
    for (const span of done) {
      expect(span.status.code).toBe(SpanStatusCode.UNSET);
    }
    expect(one(done, "execute_tool screenshot").attributes).toMatchObject({
      "langfuse.observation.level": "WARNING",
      "langfuse.observation.status_message": "cancelled",
    });
  });

  it("end() closes a leg that stops before its run, marked detached", () => {
    const { exporter, tracer } = exporterAndTracer();
    const spans = agentSpans<string>({ tracer, name: "auditor" });
    for (const e of events) spans.onEvent(e);
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(["chat"]);

    spans.end();
    const done = exporter.getFinishedSpans();
    expect(
      one(done, "invoke_agent auditor").attributes["tea.run.detached"],
    ).toBe(true);
    expect(
      one(done, "execute_tool screenshot").attributes["tea.run.detached"],
    ).toBe(true);
  });
});

describe("runTraceId", () => {
  it("is SHA-256 of the run id, cut to 32 hex characters — Langfuse's createTraceId", () => {
    for (const runId of ["run-1", "", "ünïcødé 🍵", "x".repeat(200)]) {
      const expected = createHash("sha256").update(runId, "utf8").digest("hex");
      expect(sha256Hex(runId)).toBe(expected);
      expect(runTraceId(runId)).toBe(expected.slice(0, 32));
    }
  });
});

describe("maskBase64DataUris", () => {
  it("strips data URIs in strings and passes everything else through", () => {
    expect(maskBase64DataUris({ data: `a ${SCREENSHOT} b` })).toBe(
      `a ${STRIPPED} b`,
    );
    const value = { nested: SCREENSHOT };
    expect(maskBase64DataUris({ data: value })).toBe(value);
  });
});
