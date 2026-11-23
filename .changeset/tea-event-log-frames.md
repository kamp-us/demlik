---
"@demlik/tea": minor
---

`@demlik/tea/do`: `doEventLogReader(...).readFrames(range)` reads a log's cells as frames, in `seq` order. A log written as a recording has an `init` frame for each boot and a `step` frame for each applied Msg, each with the State after it and the Cmds the engine started for it, in the form `@demlik/tea/do` stores them. `readStoredEvents` and `readEvents` still yield Msgs only, for either format. New exported types: `StoredFrame`, `EvidenceEncoding`, `LogFormat`.

**Breaking:** `EventLogHead` has a new field, `format` (`"messages"`, `"recording"` or `null` when the log has no first cell), and `StoredEventRefusal` has a new member, `"frame"`. Code that builds an `EventLogHead` by hand, or switches over every `StoredEventRefusal`, no longer compiles until it handles them. A log of bare messages reads as before.
