---
"@demlik/tea": minor
---

`replayStoredTrace(machine, trace)` (`@demlik/tea/persistence`) replays a recording read back from storage, a `Trace<unknown, { readonly _tag: string }>` whose states and Msgs are plain data and not typed as the machine's. It folds and compares them as `replayTrace` does, and the result's states and Msgs are `unknown`. It trusts the recording to be the machine's own. `replayTrace` keeps its one typed signature, so `replayTrace(machineA, traceOfMachineB)` still fails to compile.

**Additive (declaration only):** one new name, `replayStoredTrace`; `replayTrace` is unchanged.
