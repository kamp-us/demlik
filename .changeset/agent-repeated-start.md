---
"@demlik/tea": patch
---

An agent's start for the `runId` its State already holds is now a no-op, in every phase: `start` and `agent_start` return that State and no commands. A retried or concurrent start no longer fires the first model call again, resets the run's usage, or clears a finished run's output. A start for a different `runId`, or on a State with no run, begins a run as before. `@demlik/tea/agent` is experimental, so this is a behavior correction.
