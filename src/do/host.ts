/**
 * @demlik/tea/do — the minimum-viable Durable-Object HOST for a `@demlik/tea`
 * `createAgent` runtime.
 *
 * `doStore` (in `./index`) is the durability half. This module is the rest of
 * the boilerplate a DO consumer hand-rolls every time it drives a tea agent
 * over a remote transport, split by concern (#282) and re-exported here so the
 * public `./do` surface (and every `./host` importer) is unchanged:
 *
 *   - `./deferred-gateway` — the deferred-tool gateway + its durable wrappers
 *     (the command carrier).
 *   - `./command-socket` — the command-runner WS accept + broadcast, resident
 *     and hibernation-aware.
 *   - `./sse` — the runtime→SSE hub, its projection expression, and the
 *     semantic-event adapter.
 *   - `./resume` — cold-wake resume: `bootResume`/`autoBoot` and the wake-time
 *     re-emit of surviving tool round-trips.
 *   - `./agent-host` — `createAgentHost`, the assembly facade.
 *
 * ## The transport model: ONE Sub type, gateway-bridged I/O
 *
 * `createAgent().toMachine()` fixes the machine's Sub type to `DeadlineSub` —
 * the agent owns the retry + watchdog timers and nothing else. That is the
 * WHOLE Sub model for a DO-hosted agent, and it is coherent because the
 * transport deliberately does NOT live in the Sub system:
 *
 *   - Inbound WebSocket frames are bridged straight into `gateway.settle(...)`
 *     from the DO's `webSocketMessage` lifecycle method — a direct dispatch,
 *     not a Sub.
 *   - The per-tool deadline is a `setTimeout` inside the gateway — a timer, not
 *     a DO alarm.
 *
 * The deferred-tool gateway owns each tool round-trip as a Promise the interpret
 * cell awaits; the transport bridges results into `dispatch` from outside the
 * Sub system. The agent's Sub type stays exactly `DeadlineSub` — there is no
 * competing DO-native Sub variant to union in, and the host needs none. This is
 * the single transport model for `@demlik/tea/do` (#52); see
 * `.patterns/tea/durable-actors.md` for the host-layer north star.
 */

export {
  type AgentHost,
  type AgentHostConfig,
  createAgentHost,
} from "./agent-host";
export {
  acceptCommandSocket,
  acceptDurableCommandSocket,
  broadcast,
  broadcastHibernatable,
  type HibernatableCtx,
} from "./command-socket";
export {
  type DeferredGateway,
  type DurableCommandCarrier,
  deferredGateway,
  durableCommandCarrier,
  durableDeferredGateway,
} from "./deferred-gateway";
export {
  agentIsResumable,
  autoBoot,
  bootResume,
  type ResumePort,
  reissueSurvivingEffects,
} from "./resume";
export {
  type SseHub,
  sseFromAgentEvents,
  sseHub,
  sseProjection,
} from "./sse";
