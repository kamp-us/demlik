---
"@demlik/tea": patch
---

`@demlik/tea/otel`: a detached span now ends on the run's own clock. `agentSpans().end()` (and the cleanup `traceAgent` returns) used to close every still-open span with a bare `Span#end()`, so OpenTelemetry stamped it with wall-clock now while its start came from the event's `at` — a meaningless duration under a logical, test or replayed clock. Each run's open spans now end at the `at` of the last event that run folded, still marked `tea.run.detached: true`. `agentSpans().end` also takes an optional `at` (`end(at?: number)`); given one, every open span ends at exactly that instant.
