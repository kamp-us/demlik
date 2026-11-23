---
"@demlik/tea": minor
---

`@demlik/tea/do`: `doEventSourcedStore` takes `recording: { provenance }`. A log it starts is written as a recording: an `init` frame for each boot, carrying `provenance`, and a `step` frame for each applied Msg, each with the State after it and the Cmds the engine started for it, stored whole or as a delta against the frame before it. Restore folds the step frames and skips the init frames, and `snapshotEvery` counts Msgs only. A log already written as bare messages keeps being written that way, and a recording stays one without the option. A recording whose last frames cannot be rebuilt refuses restore. Read it with `doEventLogReader(...).readFrames`.

**Additive (declaration only):** `EventSourcedOptions` gains the optional field `recording`.
