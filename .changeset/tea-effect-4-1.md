---
"@demlik/tea": minor
---

**Breaking: `@demlik/tea` now needs `effect` `~4.1.1`, and a Sub failure on the Effect engine no longer closes the Scope you ran the machine in.**

- The optional `effect` peer range moves from `^4.0.0-rc.0` to `~4.1.1`. It allows 4.1.x and refuses 4.0.x, the release candidates and 4.2, so a host on an older `effect` has to move with it.
- A Sub that fails with an error it did not map to a Msg still stops its run and still reaches `onError` under `"sub"`. The run now closes a child Scope of its own and leaves the caller's open, so whatever else lives in that Scope keeps going, sibling runs included. Before, the failure closed the caller's Scope, and a finalizer there saw it as its `Exit`. That no longer happens: code that relied on the Scope closing to end its work must now wait on `done()`.
- `done()` now reports the failure. It used to wait forever. On the Effect engine it fails with the new `SubFailed` (`done(): Effect<S, StoreFailed | SubFailed>`), and on the Promise engine it rejects with the new `SubFailedError`. Both carry what the Sub failed with as `cause`, for waiting and later callers. A State that was already terminal keeps its answer. `result()` stays `undefined` for such a run.
- A worker started with `spawn` behaves as it did: its Sub failure closes its own child scope, so `remove` and `notify` run. The parent's scope and the other workers stay up.

Closing the caller's Scope still stops the run.
