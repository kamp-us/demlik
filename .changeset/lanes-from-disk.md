---
"@demlik/tea": minor
---

**Point at a folder.** `serveLaneViewer({ root, transition })` is now the whole integration — a lane is a directory holding `workflow.json` and `events.jsonl`, that convention is ours, so reading it is ours too. Three hosts had written the same loop before it moved here, each with its own idea of the edges: whether a directory with no `workflow.json` is a lane (it is not — a scratch dir under the root is not something to draw) and whether one with no `events.jsonl` is broken (it is not — it was emitted and never run, and every task sits where it booted).

`lanesFromDisk(root, { origins })` is exported for callers who want the reader without the server. `lanes: () => …` still takes precedence, for lanes that do not live in a folder. `origins` moves to the top level, so the cast is stated once rather than copied onto every lane.

A lane that cannot be read is skipped rather than thrown — one bad directory should not take down a fleet view — while a root that cannot be listed still throws, because a short list presented as "your lanes" is worse than an error.
