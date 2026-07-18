# 0002 — A Durable-Object host layer, not a DO framework

- **Status:** Accepted
- **Date:** 2026-06-22
- **Scope:** the `@demlik/tea/do` subpath — `host.ts` (`deferredGateway`,
  `autoBoot`/`agentIsResumable`, `acceptCommandSocket`/`broadcast`, `sseHub`,
  `captureLastTurn`) plus the core lifts it required (`runtime.idle()`,
  exported `agentTurnSchema`/`isAgentTurn`, optional
  `snapshot_write`).

## Context

The first real consumer to drive a `createAgent` runtime inside a Durable Object
over a remote transport (`services/sr-graph-tea`: an accessibility-audit agent
whose tools run NVDA / Playwright on remote WebSocket clients) hand-rolled the
same five concerns LangGraph + the Cloudflare Agents SDK provide off the shelf:

1. a deferred-tool round-trip (a tool ships to a client and the run parks until
   the reply arrives, correlated by `callId`, raced against a deadline),
2. cold-wake reconcile (re-fire the one outstanding effect after rehydrate),
3. command-runner WS accept + an inbound-frame bridge,
4. runtime→SSE streaming for a chat UI,
5. reading a finished run's terminal output.

None of these are domain logic. They are the integration boundary every durable
tea agent with a remote transport re-solves. Per **dogfooding** — we use what we
build so its seams surface — porting the consumer is what drove this layer; the
shrinkage of its `server.ts` (488→345; all pure boilerplate removed) is the
evidence the layer earns its place.

## Decision

Provide the host concerns as **composable functions in the `@demlik/tea/do`
subpath**, not as a base class and not in tea core.

- **Subpath, not core.** These functions touch `cloudflare:workers` types; the
  pure substrate (`index.ts`, `agent/`) must never. `do/` is already the
  Workers-coupled home (`doStore`), so the host lives there.
- **Functions, not a base class.** A `DurableObject` base class would own the
  consumer's lifecycle and hide the wiring. Composable functions keep the
  consumer in control of its own `fetch`/`webSocketMessage`/runtime construction
  — consistent with tea's knob contract (capability you splice in, not a frame
  you inherit). The consumer still writes its runtime glue and domain wiring; it
  no longer writes the boilerplate.
- **Minimum viable.** Only what the port needed to delete a hand-rolled piece.
  No speculative API.

### The Sub-composition decision

`createAgent().toMachine()` fixes the machine's Sub type to `DeadlineSub` — the
agent owns its retry + watchdog timers and nothing else. The DO-native `do_ws` /
`do_alarm` subs therefore cannot union into an agent machine's Sub set. Rather
than widen the agent's Sub type now, the host **sidesteps the Sub system**: the
deferred gateway owns each tool round-trip as a Promise the interpret cell
awaits, the deadline is a `setTimeout`, and inbound frames are bridged straight
into `gateway.settle(...)` from the DO's `webSocketMessage`. The agent's Sub type
stays exactly `DeadlineSub`; the transport lives outside the Sub system entirely.

## Deferred debts (the dogfood loop's findings)

Recorded so they are not rediscovered from scratch:

1. **The agent's Sub type is closed to `DeadlineSub`.** Any consumer wanting
   Sub-based transport (`do_ws`/`do_alarm`) cannot compose it with `createAgent`.
   The host works around this; a future change could let extra subs union into an
   agent machine. Until then, transport is bridged outside the Sub system.
2. **No first-class run terminal output.** `advanceStage` clears `conversation`
   on stage-retire (correct durability hygiene — a finished transcript is not
   live state), so a completed run has no readable result. `captureLastTurn`
   recovers it host-side off the `resilient_ok` observe Msg. A `runtime.result()`
   or a terminal Msg carrying the output would make this first-class.

## Consequences

- A second durable agent over a remote transport writes domain + lifecycle glue
  only; the five concerns above are imports.
- tea core gained `runtime.idle()` (run-to-quiescence), closing a real gap where
  `dispatch` awaited only one transition's effects, forcing `until()` polls.
- The two deferred debts are the next dogfood targets, prioritised by the next
  consumer that hits them.
