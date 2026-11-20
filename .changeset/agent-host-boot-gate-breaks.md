---
"@demlik/tea": minor
---

**Breaking:** `createAgentHost().runtime()` now resolves once `agent_boot` is queued, not when the work it re-fired has finished, so a run parked on a tool nobody has answered no longer holds up a `/step` engine. A caller that read a finished run right after `await host.runtime()` now waits with `subscribe` or `status()`.

**Breaking:** A host that dispatched `agent_boot` by hand beside `createAgentHost` to cover a `running` run now boots it twice. Delete that dispatch.

**Breaking:** A `createAgentHost().runtime()` call still waiting when `reset()` arrives now rejects with a `DispatchDiscardedError` instead of resolving a stopped handle, and the build resumes nothing into the stopped runtime. A boot failure that races `reset()` is still reported to `onError` under `"boot"`; only the engine's own teardown refusal is not.

**Breaking:** `createAgentHost()` runs one teardown at a time. A `reset()` that overlaps another returns the same promise instead of resolving at once, and a `runtime()` called while a teardown is still saving waits for it, then builds. Before, a second `reset()` returned immediately and the next `runtime()` could build a run whose finished state the old run's last save then overwrote. A `runtime()` waiting on a teardown that a later `reset()` overlaps rejects with a `DispatchDiscardedError`.
