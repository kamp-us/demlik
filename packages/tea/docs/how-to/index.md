# How-to guides

Goal-oriented directions for getting a specific job done with `@demlik/tea`.
Grouped by the job, not by the module — reach for the guide whose title matches
what you are trying to do, and it names the subpath you need.

## Upgrade

- [Migrate from 0.15 to the two-engine release](./migrate-from-0-15.md) — every
  removed or reshaped API, before and after: `run` on `@demlik/tea/promise`,
  handlers and Sub runners at `run`, Subs as `{ type, deps }` data, handler
  outcomes, and the end of `provide`, `mount*` and the `with*` wrappers.

## Run a machine somewhere

- [Run a machine on the Promise engine](./run-on-the-promise-engine.md) — hand
  `run` from `@demlik/tea/promise` Promise handlers for a machine file that
  imports only `@demlik/tea`.
- [Run a machine on the Effect engine](./run-on-the-effect-engine.md) — run the
  same machine file with `run` from `@demlik/tea/effect`: Effect handlers,
  services from your Layers, and interruption when the scope closes.
- [Make a machine durable and crash-recoverable](./make-durable.md) — give `run` a
  `Store` so the Model survives a Durable Object eviction and resumes on the next
  boot.
- [Deploy an agent to a Durable Object](./deploy-an-agent-to-a-durable-object.md) —
  run a `defineAgent` agent inside a Cloudflare Durable Object with `doStore`
  as its `Store`, so an eviction mid-run resumes on the next request instead of
  starting over.
- [Skip saving short-lived states](./skip-saving-transient-states.md) — wrap
  your `Store` so `save` does nothing while a reply streams, on either engine,
  with no tea option behind it.
- [Show a run's progress while it runs](./show-a-run-in-progress.md) — pass
  `onEvent` to `agent.run` and observe the run's `TurnSettled` / `ToolSettled` /
  `RunDone` events as the kernel settles them, instead of waiting on the one
  promise that resolves at the end, and `onChunk` for the token deltas below a
  turn.
- [Drive a machine from React](./drive-from-react.md) — use `useMachine` from
  `@demlik/tea/react` to own a runtime for a component's lifetime and get a
  `[state, dispatch]` pair.

## Give an agent a brain

- [Supply the agent's model](./supply-the-agents-model.md) — the contract tea's
  `async (messages) => AgentTurn` port holds you to (`toolCalls`, the `provider`
  round-trip, the `async` requirement, the streaming arity form), and one
  adapter over the `openai` SDK that reaches every provider behind an
  OpenAI-compatible endpoint such as Cloudflare AI Gateway or OpenRouter.

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

## Compose batteries into one door

- [Compose two battery slices into one door](./compose-two-battery-slices.md) —
  thread each battery verb's `[slice, cmds]` back into the host Model with
  `liftSlice`, whose key is checked against the Model, and state a read that
  spans both slices as a named `readInOrder` precedence you can assert on
  instead of two `if` statements nothing can name.

## Harden a call

- [Add retry and backoff to a call](./add-resilience.md) — fold
  `@demlik/tea/retry-backoff`'s pure ops into `update` so a flaky call schedules a
  backed-off retry without your reducer authoring any timing. Ends with the
  one-field version for a `defineAgent` brain call, and the policy to declare
  against a provider 429/529.
- [Hand-wire a resilient call](./hand-wire-a-resilient-call.md) — wire
  `@demlik/tea/resilience`'s `createResilientCall` knob into your own `update`
  cell by cell, with `settle` and an `onSettle` helper of your own, so a call
  gets retry, backoff and a circuit breaker from plain functions.

## Classify something

- [Ask Jev a typed question](./ask-jev-a-typed-question.md) — send a rubric to
  TypeSafe Jev with `@demlik/tea/jev` and get the answer back narrowed to the
  criteria keys you wrote, with the HTTP call as a handler you write so the whole
  call replays in a test without a key.

*Guides are added as the how-to quadrant grows.*
