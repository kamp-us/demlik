---
"@demlik/tea": minor
---

A `subscribe` listener now hears a new State right after its save and before that State's first Cmd handler starts, on both engines. Before, it heard only after every Cmd had answered, so a screen showed the old State for the whole of a slow Cmd. This is a changed timing on a stable export, and `useMachine` and `useRuntime` read it, so a machine that moves to `loading` and emits a slow read now shows `loading` during the read. A page reloaded in the middle of work does the same: with a `store` holding a State and an `init` that emits a Cmd for it, `useMachine` shows that State during the Cmd, not what `init` gives with nothing saved.

What to check in your code:

- A listener that assumed "the Cmds are done when I hear this" no longer can. Move it to `observe`, `on` or `done()`, which keep their timing and hear after the Cmds.
- A `dispatch` issued from a listener now folds ahead of the Msgs that transition's Cmds return, not behind them.

A listener still hears once per transition, a failed save still tells it nothing, and a listener that throws is still reported under `"listener"` while the step's Cmds run.
