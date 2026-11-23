---
"@demlik/tea": minor
---

`@demlik/tea/do`: `readFrames(range, options)` takes options. `{ evidence: true }` rebuilds each recording frame's State and Cmds, `{ evidence: "verify" }` checks that they rebuild without returning them, and `{ reverse: true }` reads the range from its highest `seq` down. A range that starts inside a run of deltas reads one page of the frames before it to find its basis. A frame that cannot be rebuilt is reported as refused, never thrown, and a delta after it is refused too. New exported types: `FrameReadOptions`, `FrameEvidence`, `FrameRefusal`.

**Breaking:** `StoredEventRefusal` has two new members, `"basis"` (a delta whose earlier frame is missing) and `"checksum"` (evidence that does not rebuild). Code that switches over every `StoredEventRefusal` no longer compiles until it handles them. A read that asks for no evidence never yields them.
