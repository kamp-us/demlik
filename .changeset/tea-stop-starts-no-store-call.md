---
"@demlik/tea": patch
---

A run stopped while its store was still loading no longer saves after `stop()` has returned. Before this, when `stop()` gave up at `disposeTimeoutMs` with `store.load()` still pending, the load's late return started one `store.save()`, which could write over what a newer run on the same store had saved. Now that run saves nothing: `ready` resolves with the loaded State installed and unsaved, and no Sub and no Cmd handler starts. Both engines.

A second `stop()` on the same run now returns the first one's result. It used to run the final save again, which on the Effect engine also happened when the run's Scope closed after the handle's own `stop()`.
