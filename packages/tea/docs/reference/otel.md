# @demlik/tea/otel

> an agent run as OpenTelemetry spans.

```ts
import { … } from "@demlik/tea/otel";
```

## Start here

The exports below are alphabetical, which says nothing about where to begin.
These are the ones to read first:

| Symbol | Reach for it when |
| --- | --- |
| `traceAgent` | You hold an agent runtime and want each run in Langfuse, or any OpenTelemetry backend, as one span tree. |
| `agentSpans` | The same span writer as an `onEvent` listener, for a `defineAgent` run. |

## Exports (8)

| Symbol | Kind | Summary |
| --- | --- | --- |
| `AgentEventSource` | Interface | Anything that delivers an agent's events by type — a runtime built with `events: agentEvents()`. |
| `agentSpans` | Function | The span writer behind traceAgent, as a listener. |
| `AgentSpans` | Interface | The span writer traceAgent subscribes, for wiring to an `onEvent` listener. |
| `maskBase64DataUris` | Variable | The default SpanMask: every base64 `data:` URI in a string becomes `[base64 data URI stripped before export]`. |
| `runTraceId` | Function | The trace id a run's spans are written into: the SHA-256 of `runId` as lowercase hex, cut to 32 characters. |
| `SpanMask` | Type | A mask over one exported input or output — the same shape as `LangfuseSpanProcessor`'s `mask`, so one function serves both. |
| `traceAgent` | Function | Trace an agent runtime into OpenTelemetry. |
| `TraceAgentOptions` | Interface | How traceAgent writes spans. |
