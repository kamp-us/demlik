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
 */

import {
  type Attributes,
  type Context,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
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
    const span = tracer.startSpan(
      `invoke_agent ${name}`,
      {
        kind: SpanKind.INTERNAL,
        startTime: at,
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
        run.brain = tracer.startSpan(
          model === null ? "chat" : `chat ${model}`,
          {
            kind: SpanKind.CLIENT,
            startTime: event.at,
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
          tracer.startSpan(
            "chat",
            { kind: SpanKind.CLIENT, startTime: event.at },
            run.context,
          );
        brain.setAttributes({
          "langfuse.observation.output": exported(event.turn),
          ...usageAttributes(event.usage),
        });
        brain.end(event.at);
        run.brain = null;
        return;
      }
      case "ToolStarted": {
        if (run.tools.has(event.callId)) return;
        run.tools.set(
          event.callId,
          tracer.startSpan(
            `execute_tool ${event.name}`,
            {
              kind: SpanKind.INTERNAL,
              startTime: event.at,
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
        span.end(event.at);
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
        span.end(event.at);
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
      for (const span of openChildren(run)) span.end(at);
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
        span.end(at);
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
        span.end(at);
      }
      cancelled(run.span);
      break;
  }
  run.span.end(at);
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
