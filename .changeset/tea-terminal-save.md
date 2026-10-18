---
"@demlik/tea": minor
---

Wait for the terminal State to be saved before `done()` succeeds or `result()`
returns it on both engines. While that save is pending or has failed, `result()`
returns `undefined`; a failed terminal save rejects waiting and later `done()`
calls. Runs without a store still answer as soon as State is set.

**Breaking:** Effect's `done()` now returns `Effect<S, StoreFailed>` instead of
`Effect<S>`. Handle `StoreFailed` with `operation: "save"`, the same failure
channel used by `dispatch`. Promise's `done()` rejects with the store's own error.
