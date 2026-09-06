---
"@demlik/tea": minor
---

The bare flow knobs move inside the package (ADR 0015, ADR 0016). Eight battery subpaths
leave `exports`; every primitive they published still exists, under
`src/internal/flow/`, and is no longer importable from outside the package. `saga` and
`workflow` stay two separate modules (ADR 0010: the boundary is compensation); only their
doors close.

| Removed door | Internal home |
|---|---|
| `@demlik/tea/fan-out` | `src/internal/flow/fan-out` |
| `@demlik/tea/monitored-run` | `src/internal/flow/monitored-run` |
| `@demlik/tea/poller` | `src/internal/flow/poller` |
| `@demlik/tea/reconciler` | `src/internal/flow/reconciler` |
| `@demlik/tea/saga` | `src/internal/flow/saga` |
| `@demlik/tea/workflow` | `src/internal/flow/workflow` |
| `@demlik/tea/await-terminal` | `src/internal/flow/await-terminal` |
| `@demlik/tea/batch-window` | `src/internal/flow/batch-window` |

`workflow`'s two Cmds — `workflow_activity`, `workflow_compensation` — are now built by
`Cmd.define` constructors (`workflowActivityDef<A>()`, `workflowCompensationDef<A>()`), so
each carries its input shape as a type. The emitted records are unchanged; a ledger written
before this release folds identically. The other moved modules emit no Cmds of their own.

`docs/reference/saga.md` and `docs/reference/workflow.md` go with their doors.
