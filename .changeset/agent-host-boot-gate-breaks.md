---
"@demlik/tea": minor
---

**Breaking:** `createAgentHost().runtime()` now resolves once `agent_boot` is queued, not when the work it re-fired has finished, so a run parked on a tool nobody has answered no longer holds up a `/step` engine. A caller that read a finished run right after `await host.runtime()` now waits with `subscribe` or `status()`.

**Breaking:** A host that dispatched `agent_boot` by hand beside `createAgentHost` to cover a `running` run now boots it twice. Delete that dispatch.
