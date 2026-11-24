---
"@demlik/tea": minor
---

**Breaking (`@demlik/tea/do`):** `FrameRefusal` gains `"oversized"`, the refusal a reader gives the marker a store writes in place of a frame too large for its row (`recording.maxRowBytes`). `StoredEventRefusal` and `RecordingBreak["reason"]` include it through `FrameRefusal`. A `switch` that handles every member of any of them and checks it is exhaustive no longer compiles. Add an `"oversized"` case: the frame at that seq was not kept, and a `RecordingBreak` with it carries `seq` and `bytes`.
