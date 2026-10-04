---
"@demlik/tea": minor
---

`@demlik/tea/effect` now exports `spawn` and `tell`, two helpers for a host
that runs child machines under a parent. `spawn(parentScope, steps)` forks a
child scope, starts the child and enrols it in the host's table as one
uninterruptible step, and sends the stop notice from a fiber the closing scope
never waits for. `tell(machine, runtime, msg)` dispatches a Msg only when the
run's State has a cell for it, and drops it when the State changed or the run
stopped; a failed save still fails with `StoreFailed`. The host keeps its own
table, ids and Msg names: tea adds no supervisor and no registry.
`SpawnSteps` is the type of the four host steps `spawn` takes.

`docs/how-to/run-many-machines.md` is rewritten on the helpers, and
`examples/process-tree-effect.ts` shows a host that builds a service set per
child between the fork and the run.
