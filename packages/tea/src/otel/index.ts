/**
 * @packageDocumentation
 * @demlik/tea/otel — an agent run as OpenTelemetry spans.
 *
 * `traceAgent(runtime, { tracer })` listens to an agent runtime's semantic
 * events and writes one span tree per run: a run span, a brain-call span per
 * turn and a tool span per tool call, the brain and tool spans children of the
 * run. Nothing here touches the reducer: the spans are a projection of the
 * `AgentEvent` stream, the way `transcript` is.
 *
 * The attributes follow the OpenTelemetry GenAI semantic conventions
 * (`gen_ai.*`), plus Langfuse's observation attributes (`langfuse.*`), so
 * Langfuse renders the run as an agent with generations and tool calls without
 * tea depending on any Langfuse package. Any OTel backend reads the same spans.
 *
 * `@opentelemetry/api` is an optional peer. Only this entry imports it.
 *
 * ## One trace across a kill
 *
 * The trace id is derived from the run's `runId` — the SHA-256 of it, cut to
 * 32 hex characters, which is exactly Langfuse's `createTraceId(runId)` — and
 * the run span is parented to a detached span context carrying it. The id
 * lives on the durable Model, so a process that resumes the run from its
 * `Store` writes into the same trace as the one that was killed. Spans the
 * killed process never ended are never exported; OpenTelemetry exports a span
 * when it ends. What it did end is in the trace beside the resumed leg.
 *
 * ## Time
 *
 * Every span starts and ends at the `at` of the event that opened or closed
 * it, and `at` is read as **epoch milliseconds** — the runtime's `clock`
 * contract. It reaches OpenTelemetry as an exact `HrTime`, never a bare
 * number, so a small clock value (a logical or test clock) stays the instant
 * it names instead of being rebased onto process start.
 */

import {
  type Attributes,
  type Context,
  type HrTime,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  type SpanOptions,
  SpanStatusCode,
  TraceFlags,
  type Tracer,
  trace,
} from "@opentelemetry/api";
import {
  AGENT_EVENT_TYPES,
  type AgentEndedStatus,
  type AgentEvent,
  type ToolFailure,
  type TurnUsage,
} from "../agent/index";
import { sha256Hex } from "./sha256";

/**
 * A mask over one exported input or output — the same shape as
 * `LangfuseSpanProcessor`'s `mask`, so one function serves both. `data` is the
 * value already serialized to JSON; return what should be exported instead.
 */
export type SpanMask = (params: { readonly data: unknown }) => unknown;

/** How {@link traceAgent} writes spans. */
export interface TraceAgentOptions {
  /** The tracer the spans are started on — `provider.getTracer("…")`. */
  readonly tracer: Tracer;
  /**
   * Applied to every exported input and output. Omit → {@link maskBase64DataUris},
   * which keeps a screenshot a tool returned from being exported as megabytes
   * of base64.
   */
  readonly mask?: SpanMask;
  /**
   * The agent's name, on `gen_ai.agent.name`, the run span's name and
   * Langfuse's trace name. Omit → `"agent"`.
   */
  readonly name?: string;
  /**
   * The trace id a run writes into, from its `runId`. Omit → {@link runTraceId}.
   * Must return 32 lowercase hex characters, not all zero.
   */
  readonly traceIdOf?: (runId: string) => string;
}

/** Anything that delivers an agent's events by type — a runtime built with `events: agentEvents()`. */
export interface AgentEventSource<R> {
  on<K extends AgentEvent<R>["type"]>(
    type: K,
    handler: (event: Extract<AgentEvent<R>, { type: K }>) => void,
  ): () => void;
}

/**
 * Trace an agent runtime into OpenTelemetry. Subscribes to every
 * `AgentEvent` type on `runtime` and returns a cleanup that detaches the
 * subscriptions and ends any span still open.
 *
 * The runtime must project events — built with
 * `run(machine, { events: agentEvents() })`. For `defineAgent`, which takes an
 * `onEvent` listener instead of handing out its runtime, wire
 * {@link agentSpans}'s `onEvent` there.
 *
 * Each span is timed by its events' `at`, read as epoch milliseconds.
 *
 * @example
 *   const runtime = await run(machine, { ...wired, ctx, events: agentEvents() }).ready;
 *   const stop = traceAgent(runtime, { tracer: provider.getTracer("audit") });
 */
export function traceAgent<R>(
  runtime: AgentEventSource<R>,
  opts: TraceAgentOptions,
): () => void {
  const spans = agentSpans<R>(opts);
  const offs = AGENT_EVENT_TYPES.map((type) => runtime.on(type, spans.onEvent));
  return () => {
    for (const off of offs) off();
    spans.end();
  };
}

/** The span writer {@link traceAgent} subscribes, for wiring to an `onEvent` listener. */
export interface AgentSpans<R> {
  /** Fold one event into the span tree. */
  readonly onEvent: (event: AgentEvent<R>) => void;
  /**
   * End every span still open — the leg this process ran, when it stops
   * before its run does. Each carries `tea.run.detached: true`.
   */
  readonly end: () => void;
}

/**
 * The span writer behind {@link traceAgent}, as a listener. Use it where the
 * events arrive through a callback rather than a runtime:
 *
 * @example
 *   const spans = agentSpans({ tracer });
 *   await agent.run(input, { onEvent: spans.onEvent });
 */
export function agentSpans<R>(opts: TraceAgentOptions): AgentSpans<R> {
  const { tracer } = opts;
  const mask = opts.mask ?? maskBase64DataUris;
  const name = opts.name ?? "agent";
  const traceIdOf = opts.traceIdOf ?? runTraceId;
  const runs = new Map<string, OpenRun>();

  const exported = (value: unknown): string => {
    const masked = mask({ data: json(value) });
    return typeof masked === "string" ? masked : json(masked);
  };

  const openRun = (runId: string, at: number): OpenRun => {
    const known = runs.get(runId);
    if (known !== undefined) return known;
    const parent = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: traceIdOf(runId),
      spanId: detachedSpanId(runId),
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    });
    const span = startSpan(
      tracer,
      `invoke_agent ${name}`,
      at,
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.agent.name": name,
          "gen_ai.conversation.id": runId,
          "langfuse.observation.type": "agent",
          "langfuse.trace.name": name,
          "tea.run.id": runId,
        },
      },
      parent,
    );
    const opened: OpenRun = {
      span,
      context: trace.setSpan(parent, span),
      brain: null,
      tools: new Map(),
    };
    runs.set(runId, opened);
    return opened;
  };

  const onEvent = (event: AgentEvent<R>): void => {
    const run = openRun(event.runId, event.at);
    switch (event.type) {
      case "BrainStarted": {
        // A boot in the same process re-issues the call already open.
        if (run.brain !== null) return;
        const model = event.model;
        run.brain = startSpan(
          tracer,
          model === null ? "chat" : `chat ${model}`,
          event.at,
          {
            kind: SpanKind.CLIENT,
            attributes: {
              "gen_ai.operation.name": "chat",
              ...(model === null
                ? {}
                : {
                    "gen_ai.request.model": model,
                    "langfuse.observation.model.name": model,
                  }),
              "langfuse.observation.type": "generation",
              "langfuse.observation.input": exported(event.payload),
              "tea.agent.turn": event.turn,
              "tea.agent.purpose": event.purpose,
            },
          },
          run.context,
        );
        return;
      }
      case "TurnSettled": {
        const brain =
          run.brain ??
          startSpan(
            tracer,
            "chat",
            event.at,
            { kind: SpanKind.CLIENT },
            run.context,
          );
        brain.setAttributes({
          "langfuse.observation.output": exported(event.turn),
          ...usageAttributes(event.usage),
        });
        endSpan(brain, event.at);
        run.brain = null;
        return;
      }
      case "ToolStarted": {
        if (run.tools.has(event.callId)) return;
        run.tools.set(
          event.callId,
          startSpan(
            tracer,
            `execute_tool ${event.name}`,
            event.at,
            {
              kind: SpanKind.INTERNAL,
              attributes: {
                "gen_ai.operation.name": "execute_tool",
                "gen_ai.tool.name": event.name,
                "gen_ai.tool.call.id": event.callId,
                "langfuse.observation.type": "tool",
                "langfuse.observation.input": exported(event.args),
              },
            },
            run.context,
          ),
        );
        return;
      }
      case "ToolSettled": {
        const span = run.tools.get(event.callId);
        if (span === undefined) return;
        span.setAttribute(
          "langfuse.observation.output",
          exported(event.result),
        );
        endSpan(span, event.at);
        run.tools.delete(event.callId);
        return;
      }
      case "ToolFailed": {
        const span = run.tools.get(event.callId);
        if (span === undefined) return;
        span.setAttribute(
          "langfuse.observation.output",
          exported(event.failure),
        );
        failed(span, event.failure.reason, errorType(event.failure));
        endSpan(span, event.at);
        run.tools.delete(event.callId);
        return;
      }
      case "RunDone":
        closeRun(run, event.status, event.at, exported);
        runs.delete(event.runId);
        return;
    }
  };

  const end = (): void => {
    for (const run of runs.values()) {
      for (const span of openChildren(run)) {
        span.setAttribute("tea.run.detached", true);
        span.end();
      }
      run.span.setAttribute("tea.run.detached", true);
      run.span.end();
    }
    runs.clear();
  };

  return { onEvent, end };
}

/**
 * The default {@link SpanMask}: every base64 `data:` URI in a string becomes
 * `[base64 data URI stripped before export]`. Anything that is not a string
 * passes through untouched.
 */
export const maskBase64DataUris: SpanMask = ({ data }) =>
  typeof data === "string"
    ? data.replace(BASE64_DATA_URI, STRIPPED_DATA_URI)
    : data;

/**
 * The trace id a run's spans are written into: the SHA-256 of `runId` as
 * lowercase hex, cut to 32 characters. It equals Langfuse's
 * `createTraceId(runId)`, so a trace can be looked up by the run it traced.
 */
export function runTraceId(runId: string): string {
  return sha256Hex(runId).slice(0, 32);
}

// ---------------------------------------------------------------------------

const BASE64_DATA_URI = /data:[^;]+;base64,[A-Za-z0-9+/=]+/g;
const STRIPPED_DATA_URI = "[base64 data URI stripped before export]";

interface OpenRun {
  readonly span: Span;
  readonly context: Context;
  brain: Span | null;
  readonly tools: Map<string, Span>;
}

// The one place a run's clock becomes OpenTelemetry time. `at` is epoch
// milliseconds. A bare number is ambiguous to the SDK: one no bigger than
// `performance.now()` is read as milliseconds since process start and rebased
// onto `performance.timeOrigin`, so a small clock value would silently move by
// however long the process has been up (#367). An `HrTime` is taken as-is.
function spanTime(at: number): HrTime {
  const seconds = Math.floor(at / 1_000);
  const nanos = Math.round((at - seconds * 1_000) * 1_000_000);
  return nanos === 1_000_000_000 ? [seconds + 1, 0] : [seconds, nanos];
}

// A span opened at `at`. The options carry no `startTime`, so no call site
// can hand OpenTelemetry a raw clock value.
function startSpan(
  tracer: Tracer,
  spanName: string,
  at: number,
  options: Omit<SpanOptions, "startTime">,
  context: Context,
): Span {
  return tracer.startSpan(
    spanName,
    { ...options, startTime: spanTime(at) },
    context,
  );
}

function endSpan(span: Span, at: number): void {
  span.end(spanTime(at));
}

// The detached parent every run span hangs off. Derived from the run rather
// than a constant so two runs never share a phantom parent; it is never
// exported itself, only named as a parent.
function detachedSpanId(runId: string): string {
  return sha256Hex(runId).slice(32, 48);
}

function openChildren(run: OpenRun): readonly Span[] {
  return [...(run.brain === null ? [] : [run.brain]), ...run.tools.values()];
}

// End the run span and whatever it still holds open, with the ending the run
// reached. A child still open when a run fails or is cancelled did not
// finish, and says so.
function closeRun(
  run: OpenRun,
  status: AgentEndedStatus,
  at: number,
  exported: (value: unknown) => string,
): void {
  switch (status.kind) {
    case "done":
      // Nothing is still open on a run that finished, unless a settle never
      // reached the events — end it rather than leave it unexported.
      for (const span of openChildren(run)) endSpan(span, at);
      run.span.setAttribute(
        "langfuse.observation.output",
        exported(status.output),
      );
      break;
    case "failed": {
      const reason = status.failure.reason;
      for (const span of openChildren(run)) {
        failed(
          span,
          `run failed (${reason}) before this settled`,
          "run_failed",
        );
        endSpan(span, at);
      }
      run.span.setAttribute(
        "langfuse.observation.output",
        exported(status.failure),
      );
      failed(run.span, `run failed: ${reason}`, reason);
      break;
    }
    case "cancelled":
      for (const span of openChildren(run)) {
        cancelled(span);
        endSpan(span, at);
      }
      cancelled(run.span);
      break;
  }
  endSpan(run.span, at);
}

function failed(span: Span, message: string, type: string): void {
  span.setStatus({ code: SpanStatusCode.ERROR, message });
  span.setAttributes({
    "error.type": type,
    "langfuse.observation.level": "ERROR",
    "langfuse.observation.status_message": message,
  });
}

// Cancelled is not an error — the caller asked — so the status stays unset
// and Langfuse reads it as a warning.
function cancelled(span: Span): void {
  span.setAttributes({
    "langfuse.observation.level": "WARNING",
    "langfuse.observation.status_message": "cancelled",
  });
}

function errorType(failure: ToolFailure): string {
  return failure._tag ?? "tool_error";
}

// The token usage the provider reported for the turn (#332), as the GenAI
// usage attributes Langfuse reads into the generation's usage. A turn with no
// reported usage contributes nothing, rather than a zero that reads as free.
function usageAttributes(usage: TurnUsage | undefined): Attributes {
  if (usage === undefined) return {};
  return {
    "gen_ai.usage.input_tokens": usage.inputTokens,
    "gen_ai.usage.output_tokens": usage.outputTokens,
    ...(usage.cachedInputTokens === undefined
      ? {}
      : { "gen_ai.usage.cache_read.input_tokens": usage.cachedInputTokens }),
    ...(usage.reasoningTokens === undefined
      ? {}
      : { "gen_ai.usage.reasoning.output_tokens": usage.reasoningTokens }),
  };
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return JSON.stringify(String(value));
  }
}
