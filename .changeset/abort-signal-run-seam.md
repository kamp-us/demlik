---
"@demlik/tea": minor
---

A run can be stopped from outside. `agent.run(input, { signal })` and
`driveToDone(handle, start, isTerminal, { signal, cancel })` take an
`AbortSignal`, and an abort is a TRANSITION rather than a throw: the run settles
on a new `cancelled` terminal outcome and the call RESOLVES with it. Nothing
rejects, and a cancellation is never a `DriveFailedError` — a stop button is not
a failure.

The outcome is in the Model, which is the point. A process killed after an abort
resumes reading a run that ENDED, instead of restarting the run its user
stopped. `status(state)` answers `{ kind: "cancelled", at }`, a member of the
status union in its own right — a consumer handling `done` and `failed` has not
covered every way a run can end, and now the compiler says so.

A signal already aborted when `run` is called ends the run before the first
model call is made.

What cancellation does NOT do is recall work already in flight: a promise cannot
be cancelled, so a tool handler mid-call runs to its own end. Its result reaches
no `onEvent` listener and never folds into the Model, and it does not hold the
runtime's teardown. Propagating the signal INTO handlers is a separate seam this
does not open.

Omit the signal and every existing run path behaves exactly as before.

`DriveToDoneOptions` is now a type alias rather than an interface, because
`signal` and `cancel` are a PAIR — the kernel has no built-in cancel Msg, so a
signal with nothing to dispatch is a stop button wired to nothing, and the union
makes that unrepresentable. Every existing use as a type is unaffected; a
consumer that `extends` it must switch to an intersection.
