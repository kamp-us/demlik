---
"@demlik/tea": minor
---

The resilience family moves inside the package (ADR 0015, ADR 0016). Eleven battery
subpaths leave `exports`; every primitive they published still exists, under
`src/internal/resilience/`, and is no longer importable from outside the package. Only
`@demlik/tea/retry-backoff` remains public in this family — Binclusive imports it — and it is
unchanged.

| Removed door | Internal home |
|---|---|
| `@demlik/tea/resilient-call` | `src/internal/resilience/resilient-call` |
| `@demlik/tea/with-resilience` | `src/internal/resilience/with-resilience` |
| `@demlik/tea/authed-call` | `src/internal/resilience/authed-call` |
| `@demlik/tea/cache` | `src/internal/resilience/cache` |
| `@demlik/tea/circuit-breaker` | `src/internal/resilience/circuit-breaker` |
| `@demlik/tea/deadline` | `src/internal/resilience/deadline` |
| `@demlik/tea/rate-limit` | `src/internal/resilience/rate-limit` |
| `@demlik/tea/retry-to-success` | `src/internal/resilience/retry-to-success` |
| `@demlik/tea/token-refresh` | `src/internal/resilience/token-refresh` |
| `@demlik/tea/with-deadline` | `src/internal/resilience/with-deadline` |
| `@demlik/tea/with-telemetry` | `src/internal/resilience/with-telemetry` |

The `@deprecated` stamp on `resilient-call` goes with its door: the module is
`with-resilience`'s implementation and stays, internal.

Every Cmd these modules emit is now built by a `Cmd.define` constructor — `resilient_run`,
`$resilience:run`, `$deadline:decision`, `$telemetry:emit`, `refresh_token` — so each carries
its input schema, result schema and failure tags as types. The emitted records are unchanged;
a replay log written before this release folds identically.
