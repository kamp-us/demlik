---
"@demlik/tea": minor
---

**Breaking: `@demlik/tea` now needs `effect` `~4.1.1`, and a Sub failure on the Effect engine no longer closes the Scope you ran the machine in.**

- The optional `effect` peer range moves from `^4.0.0-rc.0` to `~4.1.1`. It allows 4.1.x and refuses 4.0.x, the release candidates and 4.2, so a host on an older `effect` has to move with it.
- A Sub that fails with an error it did not map to a Msg still stops its run and still reaches `onError` under `"sub"`. The run now closes a child Scope of its own and leaves the caller's open, so whatever else lives in that Scope keeps going, sibling runs included. Before, the failure closed the caller's Scope, and a finalizer there saw it as its `Exit`. That no longer happens: code that relied on the Scope closing to end its work must now wait on `done()`. All of this needs an `onError`: with none, the default sink still rethrows the failure and ends the process, along with every other run in it.
- A Cmd handler or Sub runner that reads `Scope.Scope` now gets the run's child Scope, not the caller's. What it acquires, and any child it spawns under that Scope, is released with the run, as it was before when a Sub failed. A handler that wants something to outlive its run has to hold a different Scope.
- `done()` now reports the failure. It used to wait forever. On the Effect engine it fails with the new `SubFailed` (`done(): Effect<S, StoreFailed | SubFailed>`), and on the Promise engine it rejects with the new `SubFailedError`. Both carry what the Sub failed with as `cause`, for waiting and later callers. The Msgs already in line fold first, so if one of them reaches a terminal State, that State is the answer for every caller and for `result()`. Otherwise `result()` stays `undefined`. On a fenced store that another run has taken over, a terminal State the store refuses keeps `StoreFailed` as its answer. Any other State answers with the Sub failure, and the refused final save still reaches `onError` under `"stop-save"`.
- On the Promise engine, a `done()` with no catch now raises an unhandled rejection when a Sub fails, which ends a Node process by default. Add a catch to every `done()` you do not await.
- A worker started with `spawn` behaves as it did: its Sub failure closes its own child scope, so `remove` and `notify` run. The parent's scope and the other workers stay up.
- A parent's own Sub failure no longer stops its workers. Its scope stays open, they keep running, and `remove` and `notify` do not run until the host closes that scope. To stop the tree with the parent, wait on the parent's `done()` and then close its scope.

Closing the caller's Scope still stops the run.
