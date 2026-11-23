---
"@demlik/tea": minor
---

`@demlik/tea/persistence` exports `writeTrace(store, trace)`, which writes a captured `Trace` into a `Store` as the boundaries a live run would have saved: an `init` boundary for the State the run started in, then a `step` boundary, with its Cmds, for each recorded transition. Into a store that records (`doEventSourcedStore` with `recording`) it leaves the same cells a live run on that store writes; a store that does not record keeps the Msgs only. It throws before saving anything when the trace has no starting State, or holds Msgs but no steps (record with `captureSteps: true`). Use it to keep only a failed drive's recording.
