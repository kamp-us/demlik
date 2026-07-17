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

*Guides are added as the how-to quadrant grows.*
