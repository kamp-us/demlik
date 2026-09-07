# How-to guides

Goal-oriented directions for getting a specific job done with `@demlik/tea`.
Grouped by the job, not by the module — reach for the guide whose title matches
what you are trying to do, and it names the subpath you need.

## Run a machine somewhere

- [Make a machine durable and crash-recoverable](./make-durable.md) — give `run` a
  `Store` so the Model survives a Durable Object eviction and resumes on the next
  boot.
- [Deploy an agent to a Durable Object](./deploy-an-agent-to-a-durable-object.md) —
  run a `defineAgent` agent inside a Cloudflare Durable Object with `doStore`
  as its `Store`, so an eviction mid-run resumes on the next request instead of
  starting over.
- [Drive a machine from React](./drive-from-react.md) — use `useMachine` from
  `@demlik/tea/react` to own a runtime for a component's lifetime and get a
  `[state, dispatch]` pair.

## Test and verify

- [Replay a recorded run in a test](./replay-in-a-test.md) — assert what a machine
  did by re-folding its messages with `replay` and the `@demlik/tea/testing`
  assertions — pure, synchronous, no effects.
- [Gate a refactor on a parity check](./gate-a-refactor-on-parity.md) — record a run
  with `@demlik/tea/parity`'s `recordRun`, re-fold it through the new machine with
  `goldenReplay`, and take a normalized GO/NO-GO verdict from `parityEqual`.

## Build an agent

- [Handle a tool failure](./handle-a-tool-failure.md) — declare an `err` tag, fail
  with it from the handler, and read the `ToolOutcome` the model gets back —
  including `thrown`, `unknown_tool` and `malformed_args`, the three failures you
  never declared.

## Harden a call

- [Add retry and backoff to a call](./add-resilience.md) — fold
  `@demlik/tea/retry-backoff`'s pure ops into `update` so a flaky call schedules a
  backed-off retry without your reducer authoring any timing.

*Guides are added as the how-to quadrant grows.*
