---
"@demlik/tea": minor
---

`DrainTimeoutNotice` has a new field, `droppedMsgs`. When `stop()` gives up on a stuck Cmd handler, it counts the Msgs that were queued behind that handler, per Msg type, for example `{ item: 10, ping: 7, done: 3 }`. It covers Msgs handed to `dispatch` or `tell` and those a handler or a Sub sent, on both engines. It holds types and counts only, never a payload. Before, a Msg behind a handler that never returned was dropped and nothing named it.

**Breaking: a Msg with no caller that the notice counted no longer reaches `onError` on its own.** That is a Msg from `tell`, a handler or a Sub. When the handler returns late, it used to arrive as its own `DispatchDiscardedError`. A host that counted those errors now reads `droppedMsgs` instead, since the count already reported each one. A caller holding a dispatch promise still gets `DispatchDiscardedError`, or `Stopped` on the Effect engine.
