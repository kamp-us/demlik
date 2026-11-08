---
"@demlik/tea": minor
---

**Additive (declaration only)** `observe` hands its observer a third argument, the Cmds the transition started: `runtime.observe((msg, state, cmds) => …)`, on the Promise and Effect engines. It is optional in the type, so an observer that takes two arguments, and a hand-written handle that calls its observers with two, still fit.

**Additive (declaration only)** `./persistence`: a recorded step keeps its Cmds. With `captureSteps: true`, each `Trace.steps` entry (the new `TraceStep` type) carries `cmds`, and `toJSONL` / `parseJSONL` round-trip them. `replayTrace` compares each step's Cmds after its State, so a change that keeps every State but starts different effects diverges, at a path such as `cmds[0].total`, with `divergence.at` naming the Msg. `ReplayResult.cmds` holds the Cmds the current code starts for each replayed Msg, beside `states`.
