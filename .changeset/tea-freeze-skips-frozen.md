---
"@demlik/tea": patch
---

Dev-mode `deepFreeze` returns a value that is already frozen without walking it again, the way
Immer's `freeze` does. A machine whose state keeps earlier frozen states no longer re-walks the
whole state on every transition, which cost hundreds of milliseconds per run in development and
test builds. A value frozen only at its top level by caller code is no longer frozen below it.
