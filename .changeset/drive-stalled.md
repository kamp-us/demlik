---
"@demlik/tea": patch
---

`driveToDone` no longer hangs when `start`'s follow-up chain quiesces on a
State that is neither terminal nor `failed`. When the runtime has no live Sub
(manual or dep-keyed) and no Cmd in flight at that point, nothing inside it can
deliver another transition, so the drive now rejects with the new
`DriveStalledError<S>` — the stalled State riding on `error.state`, sibling to
`DriveFailedError` — and `stop()` is awaited before it settles, as the docstring
already promised for every exit.

A Sub-driven machine is unchanged: a Sub that delivers the terminal Msg after
the dispatch quiesces keeps the drive waiting, and it resolves on that State.
