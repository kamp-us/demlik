---
"@demlik/tea": minor
---

**Additive (declaration only):** Add the optional `StepEngine.beforeResume` hook on `@demlik/tea/do`. An authenticated pull can return a terminal response before inline resume or deferred enqueue. Existing engines retain their current behavior when the hook is absent.

Resume restored agents whose status is `running` as well as `suspended`, reissuing the existing outstanding model or compaction command through agent boot. Idle and terminal agents are not resumed. Document run-start deadline arming with the existing `durableTimer.rearm()` API.

`createAgentHost`: `reset()` stops the run through the handle the host holds from the moment `run` returned it, so it resolves while a boot is still pending. Add the `HostOverlapError` class on `@demlik/tea/do`, thrown for an overlapping `reset()`. `bootResume` and `autoBoot` still resolve when the resumed work finishes.

Removed: the private copy of the boot rule inside `defineAgent`. That helper was not a public declaration. `defineAgent` and the exported `agentIsResumable` now read one table, so a new status kind is a compile error there. `agentIsResumable` keeps its signature and now answers true for a `running` run.
