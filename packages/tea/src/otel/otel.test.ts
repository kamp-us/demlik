import { createHash } from "node:crypto";
import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type AgentEvent,
  type AgentMachineMsg,
  type AgentMessage,
  type AgentTurn,
  agentEvents,
  createAgent,
  defineAgent,
  type Schema,
  type ToolCall,
  tool,
} from "../agent/index";
import type { Interpret } from "../index";
import { run } from "../promise";
import {
  type AgentEventSource,
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
const nanos = ([seconds, ns]: readonly [number, number]) => seconds * 1e9 + ns;

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
    expect(root.parentSpanContext).toMatchObject({
      traceId: runTraceId("run-1"),
      spanId: sha256Hex("run-1").slice(32, 48),
      isRemote: true,
    });
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

  // #373 — a detach ends on the run's clock, not the SDK's wall clock. On a
  // clock starting at START a wall-clock end would still land after the start,
  // so the ends are pinned to the exact HrTime, not just ordered.
  it("end() ends each run's open spans at the `at` of the last event it folded", () => {
    const { exporter, tracer } = exporterAndTracer();
    const spans = agentSpans<string>({ tracer });
    for (const e of events) spans.onEvent(e);
    spans.onEvent({
      ...head(4.25),
      type: "ToolStarted",
      callId: "c2",
      name: "fetch",
      args: {},
    });
    spans.onEvent({
      runId: "run-7",
      at: 9,
      type: "BrainStarted",
      turn: 0,
      purpose: "act",
      model: null,
      payload: null,
    });

    spans.end();
    const detached = exporter
      .getFinishedSpans()
      .filter((s) => s.attributes["tea.run.detached"] === true);
    expect(detached.map((s) => s.name).sort()).toEqual([
      "chat",
      "execute_tool fetch",
      "execute_tool screenshot",
      "invoke_agent agent",
      "invoke_agent agent",
    ]);
    for (const span of detached) {
      // Each run on its own last `at`: run-9 last folded 4.25, run-7 9.
      const lastAt =
        span.spanContext().traceId === runTraceId("run-7")
          ? [0, 9_000_000]
          : [0, 4_250_000];
      expect(span.endTime).toEqual(lastAt);
      expect(nanos(span.endTime)).toBeGreaterThanOrEqual(nanos(span.startTime));
    }
  });

  it("end(at) ends every still-open span at exactly that `at`", () => {
    const { exporter, tracer } = exporterAndTracer();
    const spans = agentSpans<string>({ tracer });
    for (const e of events) spans.onEvent(e);

    spans.end(1_790_000_000_123.5);
    const detached = exporter
      .getFinishedSpans()
      .filter((s) => s.attributes["tea.run.detached"] === true);
    expect(detached.map((s) => s.name).sort()).toEqual([
      "execute_tool screenshot",
      "invoke_agent agent",
    ]);
    for (const span of detached) {
      expect(span.endTime).toEqual([1_790_000_000, 123_500_000]);
    }
  });

  it("traceAgent's cleanup ends what is open at the run's last `at`", () => {
    const { exporter, tracer } = exporterAndTracer();
    const handlers = new Map<string, (event: AgentEvent<string>) => void>();
    const source = {
      on: (type: string, handler: (event: AgentEvent<string>) => void) => {
        handlers.set(type, handler);
        return () => handlers.delete(type);
      },
    } as AgentEventSource<string>;
    const stop = traceAgent(source, { tracer });
    for (const e of events) handlers.get(e.type)?.(e);

    stop();
    expect(handlers.size).toBe(0);
    const detached = exporter
      .getFinishedSpans()
      .filter((s) => s.attributes["tea.run.detached"] === true);
    expect(detached).toHaveLength(2);
    for (const span of detached) {
      expect(span.endTime).toEqual([0, 3_000_000]);
    }
  });
});

// ---------------------------------------------------------------------------
// #690 — a host's `parent`: every run starts under the span the host gives,
// in the host's trace, instead of under a detached parent of tea's own.
// ---------------------------------------------------------------------------

describe("agentSpans — under a host's parent", () => {
  const lookup = tool(
    "lookup",
    {
      description: "Look a word up.",
      input: z.object({ q: z.string() }),
      ok: z.object({ hit: z.string() }),
      err: [],
    },
    async ({ q }, _ctx, { ok }) => ok({ hit: `about ${q}` }),
  );

  /** First turn asks for two lookups at once; the next one answers. */
  const twoLookupsThenAnswer = async (
    messages: readonly AgentMessage[],
  ): Promise<AgentTurn> =>
    messages.some((m) => m.role === "assistant")
      ? ANSWER
      : {
          content: "looking",
          toolCalls: [
            { callId: "l1", name: "lookup", args: { q: "tea" } },
            { callId: "l2", name: "lookup", args: { q: "elm" } },
          ],
        };

  /** A host span `S` open on the exporter's tracer, as the `parent` context. */
  function hostSpan() {
    const { exporter, tracer } = exporterAndTracer();
    const host = tracer.startSpan("host line");
    return {
      exporter,
      tracer,
      host,
      parent: trace.setSpan(context.active(), host),
    };
  }

  it("three defineAgent runs land in the host's trace, each run span a child of S", async () => {
    const { exporter, tracer, host, parent } = hostSpan();
    const agent = defineAgent({
      model: twoLookupsThenAnswer,
      tools: [lookup],
      instructions: "Look both words up, then answer.",
    });
    const spans = agentSpans({ tracer, parent });
    for (const runId of ["run-a", "run-b", "run-c"]) {
      await agent.run("tea and elm", { runId, onEvent: spans.onEvent });
    }
    spans.end();
    host.end();

    const done = exporter.getFinishedSpans();
    const hostId = host.spanContext();
    const agentSpansOnly = done.filter((s) => s !== one(done, "host line"));
    const runs = byName(done, "invoke_agent agent");
    expect(runs).toHaveLength(3);
    expect(runs.map((s) => s.attributes["tea.run.id"]).sort()).toEqual([
      "run-a",
      "run-b",
      "run-c",
    ]);
    expect(byName(done, "execute_tool lookup")).toHaveLength(6);
    expect(byName(done, "chat")).toHaveLength(6);
    for (const span of agentSpansOnly) {
      expect(span.spanContext().traceId).toBe(hostId.traceId);
    }
    for (const run of runs) {
      expect(parentOf(run)).toBe(hostId.spanId);
      expect(run.parentSpanContext?.isRemote).toBeFalsy();
    }
    // No dangling parent: every parent named is a span in the export.
    const exportedIds = new Set(done.map((s) => s.spanContext().spanId));
    for (const span of done) {
      const parentId = parentOf(span);
      if (parentId !== undefined) expect(exportedIds).toContain(parentId);
    }
  });

  it("parent wins over traceIdOf, which is never called", () => {
    const { exporter, tracer, host, parent } = hostSpan();
    let calls = 0;
    const spans = agentSpans<string>({
      tracer,
      parent,
      traceIdOf: () => {
        calls += 1;
        return "0123456789abcdef0123456789abcdef";
      },
    });
    spans.onEvent({
      runId: "run-p",
      at: 1,
      type: "BrainStarted",
      turn: 0,
      purpose: "act",
      model: null,
      payload: null,
    });
    spans.onEvent({ runId: "run-p", at: 2, type: "TurnSettled", turn: ANSWER });
    spans.onEvent({
      runId: "run-p",
      at: 3,
      type: "RunDone",
      status: { kind: "cancelled", at: 3 },
    });

    expect(calls).toBe(0);
    const done = exporter.getFinishedSpans();
    expect(done).toHaveLength(2);
    for (const span of done) {
      expect(span.spanContext().traceId).toBe(host.spanContext().traceId);
    }
    expect(parentOf(one(done, "invoke_agent agent"))).toBe(
      host.spanContext().spanId,
    );
  });

  it("end() still detaches every open span, the run span still under S", () => {
    const { exporter, tracer, host, parent } = hostSpan();
    const spans = agentSpans<string>({ tracer, parent });
    spans.onEvent({
      runId: "run-d",
      at: 1,
      type: "BrainStarted",
      turn: 0,
      purpose: "act",
      model: null,
      payload: null,
    });
    spans.onEvent({
      runId: "run-d",
      at: 2,
      type: "ToolStarted",
      callId: "c1",
      name: "lookup",
      args: {},
    });

    spans.end();
    const done = exporter.getFinishedSpans();
    expect(done.map((s) => s.name).sort()).toEqual([
      "chat",
      "execute_tool lookup",
      "invoke_agent agent",
    ]);
    for (const span of done) {
      expect(span.attributes["tea.run.detached"]).toBe(true);
      expect(span.spanContext().traceId).toBe(host.spanContext().traceId);
    }
    expect(parentOf(one(done, "invoke_agent agent"))).toBe(
      host.spanContext().spanId,
    );
  });

  it("traceAgent passes parent through to the span writer", () => {
    const { exporter, tracer, host, parent } = hostSpan();
    const handlers = new Map<string, (event: AgentEvent<string>) => void>();
    const source = {
      on: (type: string, handler: (event: AgentEvent<string>) => void) => {
        handlers.set(type, handler);
        return () => handlers.delete(type);
      },
    } as AgentEventSource<string>;
    const stop = traceAgent(source, { tracer, parent });
    handlers.get("ToolStarted")?.({
      runId: "run-t",
      at: 1,
      type: "ToolStarted",
      callId: "c1",
      name: "lookup",
      args: {},
    });

    stop();
    const done = exporter.getFinishedSpans();
    const run = one(done, "invoke_agent agent");
    expect(parentOf(run)).toBe(host.spanContext().spanId);
    for (const span of done) {
      expect(span.spanContext().traceId).toBe(host.spanContext().traceId);
    }
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
