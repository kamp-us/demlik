---
"@demlik/tea": minor
---

`agentSpans` and `traceAgent` (`@demlik/tea/otel`) take an optional `parent` context. Give it a span the host already has open, as `trace.setSpan(context.active(), span)`, and every run starts under that span, in the host's trace, with its brain and tool spans below it. A host that traces its own work no longer has to wrap the `Tracer` to get an agent run into its trace.

`parent` wins over `traceIdOf`: when both are given, `traceIdOf` is never called. With a `parent`, keeping one trace across a kill is the host's job. Without one, nothing changes: same trace ids, same detached parent, same spans.
