---
"@demlik/tea": minor
---

**Additive (declaration only)** `./persistence`: `replayTrace` tells you where a saved session parts from your current code. `ReplayResult` gains `states` (the State your code computes after each Msg), `divergence.at` (the first Msg after which it differs from the recording, when the trace was recorded with `captureSteps: true`), and `refusal` (the Msg your machine no longer has a cell for, the state it arrived in, and the Msgs that state accepts). A recorded Msg with no cell used to throw; it now comes back as `refusal`.

**Fix** `./persistence`: `parseJSONL` keeps `steps` only when every step line carries a State. A JSONL recorded without `captureSteps` used to come back with one step, misaligned with its Msgs.
