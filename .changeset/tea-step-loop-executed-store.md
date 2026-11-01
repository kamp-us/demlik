---
"@demlik/tea": minor
---

Add an optional `executed` store to `runStepLoop`, so hands that restart mid-run
do not run a step they already ran; they re-POST its saved result instead. Pass
an `ExecutedSteps<R>` that outlives the process. A `get` or `set` that fails ends
the drive with `gave_up` carrying the store's error. The window between `execute`
finishing and `set` landing stays open, so a step that must never repeat still
has to be safe to repeat.

**Breaking (`./do`, stable tier):** `RunStepLoopConfig` is now
`RunStepLoopConfig<R = never>`, and `runStepLoop` takes `RunStepLoopConfig<R>`.
References with no type argument still compile. A config that carries a store
needs the argument. One behavior also changes with no store passed: a step whose
result is `undefined`, handed out again in the same drive, now runs once where it
used to run again.
