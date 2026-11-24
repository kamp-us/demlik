---
"@demlik/tea": minor
---

**Additive (declaration only):** `RecorderOptions` (`@demlik/tea/persistence`, `@demlik/tea/parity`)
gains an optional `window`, and `Trace` gains an optional `skipped`.

`recorder` takes a `window` option that keeps only the last N transitions, so a flight recorder on
a long-running machine holds O(window) msgs and State refs, however long the run. When a
transition falls out of the window, the trace's `loaded` anchor moves to the State after it, so
`replayTrace` still reproduces `finalState` from the kept msgs, directly or after
`toJSONL` / `parseJSONL`. The new optional `Trace.skipped` counts the transitions before the
anchor, and the JSONL boot line carries it. A trace or JSONL without it reads as 0, and a recording
without a `window` writes the same JSONL as before. `window` must be an integer >= 1 and cannot be
combined with a `sampleRate` between 0 and 1; `recorder` throws a `RangeError` otherwise.
