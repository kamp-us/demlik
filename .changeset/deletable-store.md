---
"@demlik/tea": minor
---

Add `DeletableStore<S>`, an optional widening of `Store<S>` with `delete()`.
`fileStore`, `memoryStore` and `doStore` now return one, fenced and unfenced, so
a host can forget a run without knowing how each store lays out its bytes.
`delete()` is idempotent, and afterwards `load()` answers what a never-saved
store answers. `fileStore` also removes the `.fence` stamp, and `doStore` the
version cell. A fenced run still live on the store is refused with a
`StoreConflictError` at its next save. `Store<S>` itself is unchanged (#314).
