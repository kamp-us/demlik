---
"@demlik/tea": minor
---

`@demlik/tea/persistence` exports `writeTrace(store, trace)`, which writes a captured `Trace` into a `Store` as the boundaries a live run would have saved: an `init` boundary for the State the run started in, then a `step` boundary, with its Cmds, for each recorded transition. Into a store that records (`doEventSourcedStore` with `recording`) it leaves the same cells a live run on that store writes, provided `init` starts no Cmds (the recorder's boot observation carries none, so the `init` frame is written with `cmds: []`); a store that does not record keeps the Msgs only. It throws before saving anything when the trace has no starting State, holds Msgs but no steps (record with `captureSteps: true`), or has a different number of steps than Msgs. Use it to keep only a failed drive's recording.
