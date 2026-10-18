---
"@demlik/tea": minor
---

Allow restored `init(loaded, ctx)` to return a new State and resume Cmds.
`replay` now collects those Cmds alongside update Cmds instead of throwing.

**Breaking:** recorded `replayTrace` and `goldenReplay` fold from
the captured post-init State without calling init again. An unanchored trace
is refused rather than reconstructed with fresh init. Existing-State `step`
and `bindMachine(...).step` call update directly, and event-store snapshot
recovery no longer initializes the snapshot before the runtime's live init.

Resume machine-owned work in init and reflect it in the returned State.
`bootResume` and `driveToDone` remain tools for a deliberate host Msg after
boot, when subscriptions are already open.
