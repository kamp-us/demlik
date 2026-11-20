---
"@demlik/tea": minor
---

**Breaking:** `doEventSourcedStore` refuses a write that was called before a later `load()` of the same log on the same storage. A `save` or `snapshotNow()` that reaches its write point after that `load()` rejects with `StoreConflictError` and touches no cell. Before, a save that `stop()` gave up on at `disposeTimeoutMs` and that landed late wrote over what the run that replaced it had saved, and nothing reported it. Every `load()` counts, one on the same store included, so a store that a host hands to each run it rebuilds is covered. A save with no later `load()` behind it still lands, whether or not its run was given up on. The check is one generation per log in the isolate: nothing new is written to storage, and a log written before this change reads unchanged. `doStore` and a custom store are unchanged; a custom store that waits between being called and writing checks at its own write point, or is a fenced store.
