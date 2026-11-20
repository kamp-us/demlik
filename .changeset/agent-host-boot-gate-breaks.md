---
"@demlik/tea": minor
---

**Breaking:** `createAgentHost().runtime()` now resolves once `agent_boot` is queued, not when the work it re-fired has finished, so a run parked on a tool nobody has answered no longer holds up a `/step` engine. A caller that read a finished run right after `await host.runtime()` now waits with `subscribe` or `status()`.

**Breaking:** A host that dispatched `agent_boot` by hand beside `createAgentHost` to cover a `running` run now boots it twice. Delete that dispatch.

**Breaking:** A `createAgentHost().runtime()` call still waiting when `reset()` arrives now rejects with a `DispatchDiscardedError` instead of resolving a stopped handle, and the build resumes nothing into the stopped runtime. A boot failure that races `reset()` is still reported to `onError` under `"boot"`; only the engine's own teardown refusal is not.

**Breaking:** `createAgentHost()` refuses a call that overlaps a `reset()`. A second `reset()` while one is stopping the run, a `reset()` from inside `run()`, and a `runtime()` while a `reset()` is stopping the run now throw a `HostOverlapError`. `reset()` is a test and lifecycle seam for one caller at a time: await it before the next call. To stop a run, dispatch `agentCancelMsg` into `await host.runtime()`.
