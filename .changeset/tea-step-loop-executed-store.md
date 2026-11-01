---
"@demlik/tea": minor
---

Add an optional `executed` store to `runStepLoop`, so hands that restart mid-run
do not run a step they already ran; they re-POST its saved result instead. Pass
an `ExecutedSteps<R>` that outlives the process. A `get` or `set` that fails ends
the drive with `gave_up` carrying the store's error. The window between `execute`
finishing and `set` landing stays open, so a step that must never repeat still
has to be safe to repeat.

`RunStepLoopConfig` now takes a type argument, `RunStepLoopConfig<R = never>`, and
references with no type argument still compile.

Without a store, a drive keeps its in-memory memory. One fix applies there too: a
step whose result is `undefined` and which the host hands out again in the same
drive now runs once, where it used to run again.
