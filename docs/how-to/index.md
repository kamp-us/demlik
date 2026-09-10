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
- [Show a run's progress while it runs](./show-a-run-in-progress.md) — pass
  `onEvent` to `agent.run` and observe the run's `TurnSettled` / `ToolSettled` /
  `RunDone` events as the kernel settles them, instead of waiting on the one
  promise that resolves at the end, and `onChunk` for the token deltas below a
  turn.
- [Scope a resource across a run](./scope-a-resource-across-a-run.md) — hand `run`
  a `provide` graph instead of a `ctx` object so a db handle is acquired once at
  boot, in dependency order, and released in reverse when the run ends — done,
  failed or cancelled.
- [Drive a machine from React](./drive-from-react.md) — use `useMachine` from
  `@demlik/tea/react` to own a runtime for a component's lifetime and get a
  `[state, dispatch]` pair.

## Give an agent a brain

- [Use a Vercel AI SDK model as the agent's brain](./use-a-vercel-ai-sdk-model.md) —
  bridge `generateText` to tea's `(messages) => AgentTurn` port so any provider the
  AI SDK speaks works, replacing the tutorial's hand-written Anthropic adapter and
  round-tripping signed reasoning through `AgentTurn.provider` — plus the
  `streamText` variant for the streaming port.

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
- [Bound a `defineAgent` run](./bound-a-run.md) — stop a run that would otherwise
  go on forever with `maxTurns` and `deadlineMs`, and see why `deadlineMs` is a
  no-progress watchdog rather than the wall-clock cap it reads as.
- [Wrap one tool's interpret cell](./wrap-one-tool-cell.md) — use
  `defineAgent(cfg).with({ interpret })` to give one tool a behaviour the lid has
  no option for — a queue, an audit log — without rebuilding the agent with
  `createAgent`.

## Harden a call

- [Add retry and backoff to a call](./add-resilience.md) — fold
  `@demlik/tea/retry-backoff`'s pure ops into `update` so a flaky call schedules a
  backed-off retry without your reducer authoring any timing. Ends with the
  one-field version for a `defineAgent` brain call, and the policy to declare
  against a provider 429/529.

*Guides are added as the how-to quadrant grows.*
