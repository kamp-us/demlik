---
"@demlik/tea": minor
---

**`@demlik/tea/devtools/redux` (new, experimental): debug a run in the Redux DevTools extension.** `connectReduxDevtools(machine, runtime, { dispatch })` shows every applied Msg and the State it produced in the extension's timeline. Export saves the session, and Import replays a saved session through the machine you pass in, with no effects, then names the first Msg where your current code diverges from the recording, or the Msg it no longer has a cell for. The panel's Dispatch box sends a JSON Msg, checked against the Msgs the current state accepts. Jump, skip and reorder are switched off: they never rewind a run whose effects already happened. `parseDevtoolsExport(json)` turns a file saved from the panel into a `Trace` for a `replayTrace` regression test. Without the extension, the bridge does nothing.

**Additive (declaration only)** `./persistence`: `ReplayResult` gains `states` (the State after each replayed Msg), `divergence.at` (the first Msg whose State differs, when the trace carries steps) and `refusal` (the Msg the machine has no cell for, returned instead of thrown). `ReplayResult` takes the Msg union as an optional second type parameter.

**Fix** `./persistence`: `parseJSONL` keeps `steps` only when every step line carries a State. A JSONL recorded without `captureSteps` used to come back with one step, misaligned with its Msgs.
