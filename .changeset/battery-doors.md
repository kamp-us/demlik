---
"@demlik/tea": minor
---

The grouped battery doors are open. Seven new subpaths, all `battery` tier:

| Door | What is behind it |
|---|---|
| `@demlik/tea/idempotency` | `idempotency`, `idempotent-intake` |
| `@demlik/tea/flow` | `await-terminal`, `batch-window`, `fan-out`, `monitored-run`, `poller`, `reconciler`, `saga`, `workflow` |
| `@demlik/tea/resilience` | `authed-call`, `cache`, `circuit-breaker`, `deadline`, `rate-limit`, `resilient-call`, `retry-to-success`, `token-refresh`, `with-deadline`, `with-resilience`, `with-telemetry` |
| `@demlik/tea/timing` | `debounce`, `throttle`, `throttled-input` |
| `@demlik/tea/persistence` | `recorder`, `snapshot`, `trace-replay` |
| `@demlik/tea/paginate` | `paginator`, `paginated-walk` |
| `@demlik/tea/work-queue` | `work-queue`, its pure `ops`, and the `adapter` verb seam |

A consumer who needed exactly-once payouts or a compensating workflow had to
copy the source: the modules were finished and tested and simply unreachable.
Each door is a re-export file over `src/internal/`, so nothing moved, nothing
was renamed, and no module's own file path changed.

`battery` means these may break in a minor, before and after 1.0, provided the
changelog for that minor says so — a weaker promise than `stable`, and the
reason a battery break never forces a major on someone who never imported one.
The doors are grouped rather than one-per-module because a door is a permanent
promise and a maintenance cost; `MAINTAINING.md` carries the tier row for each.

One name needed a decision. `resilient-call` and `with-deadline` each declare a
different `DeadlineConfig` — a per-call in-process budget, and an inactivity
window with a progress predicate. On `@demlik/tea/resilience`, `DeadlineConfig`
is `with-deadline`'s, the consumer-facing wrapper's knob; `resilient-call`'s is
carried through as `ResilientCallDeadlineConfig`. Both are reachable.

`@demlik/tea/idempotency` and `@demlik/tea/work-queue` were published before and
closed by the v0.13.0 sweep. They are open again at `battery`, re-exporting the
same modules from their in-tree home.

Reference pages are generated for all seven. The generator now follows a
re-export to the declaration it names, so a symbol one door carries from another
module's declaration renders its real kind and summary instead of an empty
`Reference` row.
