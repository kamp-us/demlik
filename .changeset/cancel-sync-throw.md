---
"@demlik/tea": patch
---

`driveToDone` no longer hangs when a caller-supplied `cancel` throws
synchronously on a mid-run abort.

The abort listener already routed a rejected cancel dispatch — a reducer or
`interpret` that throws after the Msg is produced — into the drive's rejection.
A `cancel` function that threw before returning a Msg escaped the listener
instead: nothing was dispatched, so the terminal promise had nothing to resolve
it and the drive parked forever. Both throws now take the one route out, so the
returned promise rejects with the thrown error and the runtime is stopped.

Unreachable through `defineAgent`, which supplies its own `cancel`; this bites a
direct kernel consumer passing `{ signal, cancel }` to `driveToDone`.
