---
"@demlik/tea": minor
---

Export `applyCellChecked` and `foldUpdates` from the root, and `routeWorkflowMsg` from `./workflow`.

All three already existed internally and were reachable only by re-implementing them. `applyCellChecked` is the DEV-checked twin of `applyCell`, for a consumer driving its own fold rather than `run`. `foldUpdates` is the fold beneath `foldMsgs` and returns `{ state, cmds }` rather than state alone, which is what a caller folding a log needs when it must also act on the emitted Cmds. `routeWorkflowMsg` is the single `WorkflowMsg` → verb routing table, so a consumer driving a workflow from its own host no longer re-derives the mapping by hand — where a fifth Msg variant would have broken it silently instead of at compile time.

Additive only; no existing behaviour changes.
