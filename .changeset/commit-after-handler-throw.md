---
"@demlik/tea": patch
---

When a hand-written Cmd handler throws, the transition it ran in is no longer
hidden from the run's listeners. `subscribe`, `observe`, `on`, the telemetry
sink and `done()` now hear the State that was already installed and saved, and
the dispatch still rejects with the handler's error. Both the Promise and the
Effect engine are fixed (#311).
