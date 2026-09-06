---
"@demlik/tea": minor
---

`driveToDone(handle, start, isTerminal, { failed? })` runs a machine from its
start Msg to its terminal State in one call and stops the runtime on every exit.

It replaces the six-step loop every "run this machine to done" caller
hand-wired — `await ready`, `observe`, park a promise, `dispatch(start)`,
`getState()`, `stop()` — whose two quiet failure modes were an observer left
attached and a `stop` never awaited. The observer is detached and `stop()`
awaited whether the drive resolves or rejects.

Rejections are typed. A final State the caller's `failed` predicate marks
rejects with the new `DriveFailedError<S>`, the State riding on `error.state`.
A machine that never settles rejects with the existing `QuiescenceTimeoutError`
from the cap `dispatch` already enforces — no second clock.
