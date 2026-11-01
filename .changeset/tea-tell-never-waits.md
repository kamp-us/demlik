---
"@demlik/tea": minor
---

**Breaking: `tell` on `@demlik/tea/effect` no longer waits, and its promise is now queued, not handled.** It puts the Msg on the receiver's line and answers at once, so a parent and a child that tell each other from Cmd handlers keep moving instead of both stopping with no error.

- `tell` now succeeds with a `TellAnswer`: `"queued"`, `"stopped"` (the receiver is stopping or has stopped) or `"no_cell"` (its current State has no cell for the Msg).
- `StoreFailed` leaves `tell`'s type. A failed save of the receiver reaches the receiver's `onError`, and no longer comes back to the sender. Drop any `Effect.catch` around a `tell`, as `spawn`'s `notify` no longer needs one.
- A State read right after a `tell` no longer shows the Msg folded. Wait for the result as its own Msg, or use `idle()` on the receiver outside its Cmd handlers.
- A Msg whose cell is gone by its turn is dropped without a word. It never ends the process, with or without an `onError`.
- `tell` now needs the handle `ready` gives, or a spread of one: an `EffectRun`, or a `Run` on the Promise engine. A plain object built by hand worked before and no longer compiles, and neither does the handle straight from `run`.

Added: `tell` and `TellAnswer` on `@demlik/tea/promise`, and `TellAnswer` on `@demlik/tea/effect`. On the Promise engine `tell` returns its answer directly. `spawn` and `stop` keep their signatures. Two hand-written waiting `dispatch` calls into each other can still stop both machines.
