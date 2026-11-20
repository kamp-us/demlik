---
"@demlik/tea": minor
---

**Additive (declaration only):** Add the optional `StepEngine.beforeResume` hook on `@demlik/tea/do`. An authenticated pull can return a terminal response before inline resume or deferred enqueue. Existing engines retain their current behavior when the hook is absent.

Resume restored agents whose status is `running` as well as `suspended`, reissuing the existing outstanding model or compaction command through agent boot. Idle and terminal agents are not resumed. Document run-start deadline arming with the existing `durableTimer.rearm()` API.

`createAgentHost`: `runtime()` now resolves once `agent_boot` is queued, not when the work it re-fired has finished, so a run parked on a tool nobody has answered no longer holds up a `/step` engine. A caller that read a finished run right after `await host.runtime()` now waits with `subscribe` or `status()`. `reset()` stops the run through the handle the host holds from the moment `run` returned it, so it resolves while a boot is still pending. `bootResume` and `autoBoot` still resolve when the resumed work finishes.

Removed: the private copy of the boot rule inside `defineAgent`. That helper was not a public declaration. `defineAgent` and the exported `agentIsResumable` now read one table, so a new status kind is a compile error there. `agentIsResumable` keeps its signature and now answers true for a `running` run. A host that dispatched `agent_boot` by hand beside `createAgentHost` to cover a `running` run now boots it twice, so delete that dispatch.
