---
"@demlik/tea": minor
---

Trace an agent run as OpenTelemetry spans (#331).

The new `@demlik/tea/otel` subpath (experimental) has `traceAgent(runtime, { tracer, mask? })`.
It writes one span tree per run from the agent's events: a run span, a
generation per brain call and a tool span per tool call. The spans carry the
OpenTelemetry GenAI attributes (`gen_ai.*`), including a turn's reported token
usage, and Langfuse's observation attributes, so Langfuse renders them
natively. The trace id is derived from the
`runId`, so a run resumed from its `Store` stays one trace. `agentSpans` is the
same writer as an `onEvent` listener, for `defineAgent`. `@opentelemetry/api` is
a new optional peer that only `@demlik/tea/otel` imports. No Langfuse package is
a dependency.

The agent's event stream (`./agent`, experimental) changes shape:

- **New events.** `BrainStarted` (turn, purpose, model, payload) and
  `ToolStarted` (callId, name, args) fire when the call is issued. `ToolFailed`
  (callId, name, failure) fires when a call ends on a failure the model reads.
- **`runId` and `at` on every event.** The `runId` is the durable one, so it is
  the same before and after a resume.
- **`RunDone` fires on every ending, once.** It carries `status`, which is `done`
  with `output`, `failed` with `failure`, or `cancelled`. `RunDone.output` is
  gone: read `status.output` when `status.kind === "done"`. A failed or
  cancelled run now reports `RunDone` too. Before this change it reported
  nothing.
- **`transcript().read().outcome`** is now `running`, or the ending `RunDone`
  carried.
- **`AGENT_EVENT_TYPES`** lists every event type. `sseFromAgentEvents` and
  `defineAgent`'s `onEvent` subscribe to all of them.
- **`AgentState` gains `lifecycle`.** This is the per-transition outbox the
  projector reads. A Model persisted before this change reads it as empty.
