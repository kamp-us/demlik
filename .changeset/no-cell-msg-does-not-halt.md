---
"@demlik/tea": patch
---

A Msg with no cell for the current state no longer halts the run under the
default supervision. The reducer's `NoCellError` is reported to `onError` and
that one Msg is dropped; the run keeps going, on both engines (#310).
