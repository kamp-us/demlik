---
"@demlik/tea": minor
---

**Additive (declaration only):** `run` on `@demlik/tea/promise` and `@demlik/tea/effect` takes `boot?: "restored"` (`PromiseRunOptions`, `EffectRunOptions`). Not passed, a run behaves exactly as before. Passed, and the store holds a State, boot folds it through `init` but runs none of `init`'s Cmds, writes nothing while `init` returns the loaded State itself, and the run never saves again at `stop()`; a transition still saves before its Cmds run. A host that wakes on its next Msg can say "this start is a wake" without `init`'s Cmds running on every wake, and on a fenced store a wake that changed nothing takes no turn at the fence. With nothing saved, `init(null)` runs, its Cmds run and its State is saved. An `init` that returns another State than the loaded one has it saved, and still runs no Cmds. A store with a durable log, or no store, is unchanged.
