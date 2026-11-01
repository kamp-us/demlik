---
"@demlik/tea": minor
---

`DrainTimeoutNotice` has a new field, `droppedMsgs`. When `stop()` gives up on a stuck Cmd handler, it counts the Msgs that were queued behind that handler, per Msg type, for example `{ item: 10, ping: 7, done: 3 }`. It covers Msgs handed to `dispatch` or `tell` and those a handler or a Sub sent, on both engines. It holds types and counts only, never a payload. Before, a Msg behind a handler that never returned was dropped and nothing named it.

One changed behaviour: a Msg with no caller, one from `tell`, a handler or a Sub, that was counted this way no longer reaches `onError` as its own `DispatchDiscardedError` when the handler returns late. The count already reported it. A caller holding a dispatch promise still gets `DispatchDiscardedError`, or `Stopped` on the Effect engine.
