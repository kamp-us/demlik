# How-to guides

Goal-oriented directions for getting a specific job done with `@demlik/tea`.
Grouped by the job, not by the module — reach for the guide whose title matches
what you are trying to do, and it names the subpath you need.

## Run a machine somewhere

- [Make a machine durable and crash-recoverable](./make-durable.md) — give `run` a
  `Store` so the Model survives a Durable Object eviction and resumes on the next
  boot.
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

## Read a running machine

- [Report on a fabrika lane](./report-on-a-fabrika-lane.md) — import a
  `workflow.json` into charts with `@demlik/tea/chart/report` and render a lane
  as one markdown block (diagram, "waiting on", retry budget, timeline) that
  reads the same in a terminal, a PR comment and an issue comment.

## Test and verify

- [Replay a recorded run in a test](./replay-in-a-test.md) — assert what a machine
  did by re-folding its messages with `replay` and the `@demlik/tea/testing`
  assertions — pure, synchronous, no effects.
- [Gate a refactor on a parity check](./gate-a-refactor-on-parity.md) — record a run
  with `@demlik/tea/parity`'s `recordRun`, re-fold it through the new machine with
  `goldenReplay`, and take a normalized GO/NO-GO verdict from `parityEqual`.
- [Await a machine's terminal state from the caller](./await-a-terminal-state.md) —
  use `awaitTerminal` / `runToTerminal` from `@demlik/tea/await-terminal` to get a
  `Promise<State>` that resolves on the first terminal transition, with the
  already-terminal case and observer detach handled for you.

## Harden a call

- [Add retry and backoff to a call](./add-resilience.md) — fold
  `@demlik/tea/retry-backoff`'s pure ops into `update` so a flaky call schedules a
  backed-off retry without your reducer authoring any timing.
- [Call an API that needs a bearer token](./call-an-authenticated-api.md) — wire
  `@demlik/tea/authed-call`'s knob into a machine so a guarded call gets the full
  resilience gate plus a credential that is refreshed-and-retried exactly once on a
  401.
- [Retry a promise until it succeeds](./retry-until-it-succeeds.md) — hand one
  fallible async port to `@demlik/tea/retry-to-success` for bounded retry and
  backoff without a machine, getting a `Promise<R>` that resolves on the first
  success or rejects with `RetryExhaustedError`.

## Shape work over time

- [Batch a stream of items into bounded flushes](./batch-work-into-windows.md) —
  fold `@demlik/tea/batch-window` into your Model so arrivals coalesce into size- or
  time-bounded batches that flush as a single Cmd, with the window timer riding on a
  `deadline` Sub.
- [Debounce an input burst without a live timer](./debounce-input-durably.md) —
  spread `@demlik/tea/throttled-input`'s knob into your machine so a bursty stream
  collapses to one settled emit, with the pending value and rate cursor held as
  durable, replayable Model state instead of a closure timer.
- [Reconcile the actual world against a desired spec](./reconcile-desired-state.md) —
  fold `@demlik/tea/reconciler` into a machine so a paginated scan of the actual
  world diffs against your spec and applies each change once, resumably, with the
  scan's retry and deadline timers pre-wired.

*Guides are added as the how-to quadrant grows.*
