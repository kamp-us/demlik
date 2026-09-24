# Trace an agent run in Langfuse

This page gets an agent run into Langfuse as one trace. The trace holds a span
for the run, a generation for each brain call and a tool span for each tool
call. `traceAgent` from `@demlik/tea/otel` writes the spans from the agent's
events, and Langfuse's own span processor exports them over OpenTelemetry.

Install the OpenTelemetry API, an SDK tracer provider and Langfuse's processor
beside tea:

```sh
pnpm add @opentelemetry/api @opentelemetry/sdk-trace-base @langfuse/otel
```

`@opentelemetry/api` is the optional peer `@demlik/tea/otel` imports. The other
two are *your* dependencies: tea names no Langfuse package. What ties the spans
to Langfuse is the attributes tea writes on them.

Set `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and `LANGFUSE_BASE_URL` in the
environment the agent runs in.

## 1. Point a tracer at Langfuse

```ts
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { maskBase64DataUris } from "@demlik/tea/otel";

/**
 * A tracer whose spans go to Langfuse. The processor reads
 * `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and `LANGFUSE_BASE_URL` from
 * the environment. Build it once per process and share it.
 */
export function langfuseTracing(name: string) {
  const processor = new LangfuseSpanProcessor({ mask: maskBase64DataUris });
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  return {
    tracer: provider.getTracer(name),
    flush: () => processor.forceFlush(),
  };
}
```

`traceAgent` already strips base64 `data:` URIs from the inputs and outputs it
writes, so a screenshot a tool returned is not exported as megabytes of base64.
Handing the same `maskBase64DataUris` to the processor applies that to every
other span it exports too, such as a model SDK's own telemetry. On Node,
`NodeTracerProvider` from `@opentelemetry/sdk-trace-node` takes the same
`spanProcessors`.

## 2. Trace a runtime

When you drive the agent with `run(machine, …)`, or through `createAgentHost` in
a Durable Object, you hold its runtime. Build it with `events: agentEvents()`
and hand it to `traceAgent` before you dispatch the first Msg:

```ts
import { type AgentEventSource, traceAgent } from "@demlik/tea/otel";

/**
 * Trace every run a runtime drives. `runtime` is one built with
 * `events: agentEvents()`. Returns the cleanup that detaches the tracer.
 */
export function traced<R>(
  runtime: AgentEventSource<R>,
  langfuse: ReturnType<typeof langfuseTracing>,
): () => void {
  return traceAgent(runtime, { tracer: langfuse.tracer, name: "audit-agent" });
}
```

A machine wired with `toMachine({ tools })` settles its tools through the
router, so pass the same router: `agentEvents({ tools })`. Without it, a tool
that succeeds never reports `ToolSettled`, and its span stays open until the run
ends, with no result on it.

## 3. Or trace a `defineAgent` run

`defineAgent` keeps its runtime to itself and hands its events to `onEvent`
instead. Put `agentSpans`, the span writer `traceAgent` uses, on that listener:

```ts
import { agentSpans } from "@demlik/tea/otel";

const langfuse = langfuseTracing("notebook-agent");

export async function runTraced(input: string) {
  const spans = agentSpans({ tracer: langfuse.tracer, name: "notebook-agent" });
  try {
    return await agent.run(input, { onEvent: spans.onEvent });
  } finally {
    // A run that threw leaves its spans open; end them so they export.
    spans.end();
    // The processor batches. Flush before a serverless handler returns.
    await langfuse.flush();
  }
}
```

`agent` is the tutorial's `defineAgent` agent, from
[Build a durable agent](../tutorial/build-a-durable-agent.md).

## What lands in Langfuse

| Span | Langfuse type | Opens on | Closes on | Input → output |
| --- | --- | --- | --- | --- |
| `invoke_agent <name>` | agent | the run's first event | `RunDone` | the terminal turn |
| `chat <model>` | generation | `BrainStarted` | `TurnSettled` | the brain call's `payload` → the turn |
| `execute_tool <tool>` | tool | `ToolStarted` | `ToolSettled` or `ToolFailed` | the call's `args` → its result or failure |

The generation and tool spans are children of the run span. Each span carries
the OpenTelemetry GenAI attributes, such as `gen_ai.operation.name`,
`gen_ai.request.model`, `gen_ai.tool.name` and `gen_ai.tool.call.id`, beside
Langfuse's `langfuse.observation.*` ones. A span's start and end times are the
`at` of the transitions that opened and closed it.

- **A failed tool call** is an error span, with the failure's `reason` as the
  status message and its `_tag` as `error.type`. The run goes on, so its span is
  not an error.
- **A run that fails** ends its span as an error, and every span it still held
  open with it.
- **A cancelled run** ends its span, and any it held open, at level `WARNING`
  rather than as errors. Nothing went wrong; the caller stopped it.

When the model reported a turn's token usage, its generation carries it as
`gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens`, plus the cached
and reasoning counts when the provider gave them. Langfuse reads those as the
generation's usage and prices it from the model name.

## A resumed run stays one trace

The trace id is the run's `runId` hashed: `runTraceId(runId)`, which equals
Langfuse's `createTraceId(runId)` from `@langfuse/tracing`. So you can look a
run's trace up by its id. The `runId` lives on the durable Model. A process that
resumes the run from its `Store` writes into the same trace as the process that
was killed.

What a killed process started and never ended is not in the trace, because
OpenTelemetry exports a span only when it ends. What it did end is there, beside
the resumed process's spans. The resumed process reports each brain call and
tool call it re-issues as started again, so its spans open and close normally.

## Any OpenTelemetry backend

Any OpenTelemetry backend reads the same spans. Swap `LangfuseSpanProcessor` for
your backend's processor, such as `BatchSpanProcessor` over an OTLP exporter,
and nothing else changes. The `gen_ai.*` attributes are the standard GenAI
conventions, and a backend that does not know the `langfuse.*` ones ignores
them.
