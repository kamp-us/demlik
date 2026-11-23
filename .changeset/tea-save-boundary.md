---
"@demlik/tea": minor
---

**Additive (declaration only):** `Store.save` takes a third optional argument, a `SaveBoundary`, that says which boundary the save is: `{ _tag: "init", cmds }` for the State `init` produced and the Cmds the engine starts for it (`[]` when a wake starts none), `{ _tag: "step", cmds }` for an applied Msg's transition and the Cmds it starts, or `{ _tag: "stop" }` for the flush at `stop()`. Both engines pass it on every save and the Effect engine's store wrapper forwards it. A store that keeps a recording reads the evidence there; every other store ignores it, so a `save(state, msg)` written before this still compiles and runs.
