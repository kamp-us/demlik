---
"@demlik/tea": minor
---

A `Store` can now refuse a second live writer. Two runtimes pointed at one
`agent.json` both drove the same run to done — `save` was unconditional, so the
last writer won and neither could learn it had raced.

New on the root subpath: `FencedStore<S>`, an optional widening of `Store<S>`
that adds `fenced: true`, `loadFenced()` (bytes plus the version they were
written at) and `saveFenced(state, expectedVersion)` (compare-and-swap);
`isFencedStore`; and `StoreConflictError` (`_tag: "store_conflict"`), thrown when
a swap finds a version other than the one it expected. `run` and
`defineAgent().run` fence automatically when handed a fenced store: they read the
version at boot and swap on every save. A run started after another has moved the
version reads the current one, so the newer starter takes the fence and the older
live writer is refused at its next save — having already fired the effects it
reached by then. Only the boot race, where both processes read one version before
either wrote, is refused before a single effect fires. Fencing buys at most one
live writer from here on, not a guarantee that the loser never ran.

`Store<S>` itself is unchanged and no implementor breaks. Fencing is opt-in per
store for all of 0.x — `fileStore(path, parse, { fenced: true })` (version stamp
guarded by a `wx` lock), `doStore(storage, parse, { fenced: true })` (inside
`storage.transaction`), `memoryStore(initial, parse, { fenced: true })`. The
unfenced call is byte-for-byte the old behaviour. `chromeStorageStore` stays
unfenced deliberately: `chrome.storage` has no atomic compare-and-swap.

See [ADR 0017](../.decisions/0017-fencing-is-an-optional-store-widening.md).
