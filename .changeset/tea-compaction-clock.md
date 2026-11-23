---
"@demlik/tea": patch
---

A defined agent's compaction settle is stamped by the run's clock. `agent.run({ clock })` now stamps the `compact_ok` Msg with the injected clock, as `DefinedAgentRunOptions.clock` documents, where it used wall time before. `machine(input)` is unchanged: a raw kernel run of it still stamps that settle with `Date.now`.
