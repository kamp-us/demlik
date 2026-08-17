# How-to guides

Goal-oriented directions for getting a specific job done with `@demlik/tea`.

- [Add retry and backoff to a call](./add-resilience.md) — fold
  `@demlik/tea/retry-backoff`'s pure ops into `update` so a flaky call schedules a
  backed-off retry without your reducer authoring any timing.
- [Make a machine durable and crash-recoverable](./make-durable.md) — give `run` a
  `Store` so the Model survives a Durable Object eviction and resumes on the next
  boot.
- [Replay a recorded run in a test](./replay-in-a-test.md) — assert what a machine
  did by re-folding its messages with `replay` and the `@demlik/tea/testing`
  assertions — pure, synchronous, no effects.
- [Drive a machine from React](./drive-from-react.md) — use `useMachine` from
  `@demlik/tea/react` to own a runtime for a component's lifetime and get a
  `[state, dispatch]` pair.
- [Author a machine as config](./author-a-machine-as-config.md) — write the
  machine as one `defineChart` value: `ctx`, an event alphabet with a `scope`
  each, states grouped by phase, and the parts bags `compile` demands.
- [Compose a battery inside a chart](./compose-a-battery-inside-a-chart.md) — use
  a `{ to, cell }` edge so a retry/breaker/cache chain can pick the next state
  from a target set the chart still declares and draws.
- [Run many instances of one chart](./run-many-instances-of-one-chart.md) —
  compile with a namespace so N instances share a dispatch surface, and mark
  library-minted events `foreign: true` so their names stay bare.

*Guides are added as the how-to quadrant grows.*
