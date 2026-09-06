---
"@demlik/tea": minor
---

The composed-flow families move inside the package (ADR 0015, ADR 0016). Eleven battery
subpaths leave `exports`; every primitive they published still exists, under
`src/internal/{timing,paginate,idempotency,work-queue}/`, and is no longer importable from
outside the package. `debounce`, `throttle` and `throttled-input` stay three separate
modules (ADR 0010's no-collapse verdict); only their doors close.

| Removed door | Internal home |
|---|---|
| `@demlik/tea/debounce` | `src/internal/timing/debounce` |
| `@demlik/tea/throttle` | `src/internal/timing/throttle` |
| `@demlik/tea/throttled-input` | `src/internal/timing/throttled-input` |
| `@demlik/tea/paginator` | `src/internal/paginate/paginator` |
| `@demlik/tea/paginated-walk` | `src/internal/paginate/paginated-walk` |
| `@demlik/tea/idempotency` | `src/internal/idempotency/idempotency` |
| `@demlik/tea/idempotency/adapter` | `src/internal/idempotency/idempotency/adapter` |
| `@demlik/tea/idempotent-intake` | `src/internal/idempotency/idempotent-intake` |
| `@demlik/tea/work-queue` | `src/internal/work-queue` |
| `@demlik/tea/work-queue/ops` | `src/internal/work-queue/ops` |
| `@demlik/tea/work-queue/adapter` | `src/internal/work-queue/adapter` |

`idempotent-intake`'s two Cmds — `intake:process`, `intake:replay` — are now built by
`Cmd.define` constructors (`intakeProcessDef<P>()`, `intakeReplayDef<R>()`), so each carries
its input shape as a type. The emitted records are unchanged; a replay log written before
this release folds identically. The other moved modules emit no Cmds of their own.

`docs/reference/work-queue.md` goes with its door.
