# @demlik/tea/otel

> an agent run as OpenTelemetry spans.

Tier: `experimental`

```ts
import { … } from "@demlik/tea/otel";
```

## Start here

The exports below are alphabetical, which says nothing about where to begin.
These are the ones to read first:

| Symbol | Reach for it when |
| --- | --- |
| [`traceAgent`](#traceAgent) | You hold an agent runtime and want each run in Langfuse, or any OpenTelemetry backend, as one span tree. |
| [`agentSpans`](#agentSpans) | The same span writer as an `onEvent` listener, for a `defineAgent` run. |

## Exports (8)

| Symbol | Kind | Tier | Summary |
| --- | --- | --- | --- |
| [`AgentEventSource`](#AgentEventSource) | Interface | experimental | Anything that delivers an agent's events by type — a runtime built with `events: agentEvents()`. |
| [`agentSpans`](#agentSpans) | Function | experimental | The span writer behind traceAgent, as a listener. |
| [`AgentSpans`](#AgentSpans) | Interface | experimental | The span writer traceAgent subscribes, for wiring to an `onEvent` listener. |
| [`maskBase64DataUris`](#maskBase64DataUris) | Variable | experimental | The default SpanMask: every base64 `data:` URI in a string becomes `[base64 data URI stripped before export]`. |
| [`runTraceId`](#runTraceId) | Function | experimental | The trace id a run's spans are written into: the SHA-256 of `runId` as lowercase hex, cut to 32 characters. |
| [`SpanMask`](#SpanMask) | Type | experimental | A mask over one exported input or output — the same shape as `LangfuseSpanProcessor`'s `mask`, so one function serves both. |
| [`traceAgent`](#traceAgent) | Function | experimental | Trace an agent runtime into OpenTelemetry. |
| [`TraceAgentOptions`](#TraceAgentOptions) | Interface | experimental | How traceAgent writes spans. |

## Declarations

<a id="AgentEventSource"></a>

### `AgentEventSource`

```ts
interface AgentEventSource<R> {
  on<
    K extends "BrainStarted" | "TurnSettled" | "ToolStarted" | "ToolSettled" | "ToolFailed" | "RunDone",
  >(
    type: K,
    handler: (
      event: Extract<AgentEventHead & {
        readonly model: string | null;
        readonly payload: unknown;
        readonly purpose: string;
        readonly turn: number;
        readonly type: "BrainStarted";
      }, { type: K }> | Extract<AgentEventHead & {
        readonly turn: AgentTurn;
        readonly type: "TurnSettled";
        readonly usage?: TurnUsage;
      }, { type: K }> | Extract<AgentEventHead & {
        readonly args: Readonly<Record<string, unknown>>;
        readonly callId: string;
        readonly name: string;
        readonly type: "ToolStarted";
      }, { type: K }> | Extract<AgentEventHead & {
        readonly callId: string;
        readonly failure: ToolFailure;
        readonly name: string;
        readonly type: "ToolFailed";
      }, { type: K }> | Extract<AgentEventHead & {
        readonly status: AgentEndedStatus;
        readonly type: "RunDone";
      }, { type: K }> | Extract<AgentEventHead & {
        readonly callId: string;
        readonly result: R;
        readonly type: "ToolSettled";
      }, { type: K }>,
    ) => void,
  ): () => void;
}
```

<a id="agentSpans"></a>

### `agentSpans`

```ts
function agentSpans<R>(opts: TraceAgentOptions): AgentSpans<R>
```

<a id="AgentSpans"></a>

### `AgentSpans`

```ts
interface AgentSpans<R> {
  readonly end: (at?: number) => void;
  readonly onEvent: (event: AgentEvent<R>) => void;
}
```

<a id="maskBase64DataUris"></a>

### `maskBase64DataUris`

```ts
const maskBase64DataUris: SpanMask
```

<a id="runTraceId"></a>

### `runTraceId`

```ts
function runTraceId(runId: string): string
```

<a id="SpanMask"></a>

### `SpanMask`

```ts
type SpanMask = (params: { readonly data: unknown }) => unknown
```

<a id="traceAgent"></a>

### `traceAgent`

```ts
function traceAgent<R>(
  runtime: AgentEventSource<R>,
  opts: TraceAgentOptions,
): () => void
```

<a id="TraceAgentOptions"></a>

### `TraceAgentOptions`

```ts
interface TraceAgentOptions {
  readonly mask?: SpanMask;
  readonly name?: string;
  readonly traceIdOf?: (runId: string) => string;
  readonly tracer: Tracer;
}
```
