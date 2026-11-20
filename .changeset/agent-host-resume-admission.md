---
"@demlik/tea": minor
---

**Additive (declaration only):** Add the optional `StepEngine.beforeResume` hook on `@demlik/tea/do`. An authenticated pull can return a terminal response before inline resume or deferred enqueue. Existing engines retain their current behavior when the hook is absent.

Resume restored agents whose status is `running` as well as `suspended`, reissuing the existing outstanding model or compaction command through agent boot. Idle and terminal agents are not resumed. Document run-start deadline arming with the existing `durableTimer.rearm()` API.

Removed: `defineAgent` no longer holds its own private copy of the rule that decides whether a restored run is booted. It and `agentIsResumable` now read one table, so a new status kind is a compile error there. Neither is a public declaration. A host that dispatched `agent_boot` by hand beside `createAgentHost` to cover a `running` run now boots it twice, so delete that dispatch.
