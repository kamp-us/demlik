# @demlik/tea/do

> Durable Object adapter for `@demlik/tea`.

```ts
import { … } from "@demlik/tea/do";
```

## Exports (105)

| Symbol | Kind | Summary |
| --- | --- | --- |
| `acceptCommandSocket` | Function | Accept a command-runner WebSocket on the DO's `fetch`. |
| `acceptDurableCommandSocket` | Function | Accept a command-runner WebSocket using the Cloudflare **Hibernation API** so the socket survives DO eviction. |
| `acceptPresenceSocket` | Function | Accept a client WebSocket upgrade on a native DO and register it for hibernation. |
| `AgentHost` | Interface | The assembled host: the runtime cell + the SSE hub + the framework test seam, owned ONCE. |
| `AgentHostConfig` | Interface | What the consumer supplies to createAgentHost — the domain mappings, nothing of the wiring. |
| `agentIsResumable` | Function | True iff an agent slice loaded from storage is mid-loop (running + awaiting tools) — the resumable case `agent_boot` re-fires. |
| `AlarmStorage` | Interface | The DO-native alarm slice `stepHost` re-arms. |
| `appliedEffects` | Function | Build a live guard. |
| `AppliedEffects` | Type | The set of keys whose effect has been applied. |
| `AppliedEffectsEvent` | Type | The event union the applied-marker set folds over. |
| `AppliedEffectsGuard` | Interface | A live guard over an applied-marker set. |
| `applyAppliedEvent` | Function | Apply ONE event — the reducer at the heart of the fold. |
| `applyEffectEvent` | Function | Apply ONE ledger event — the reducer at the heart of the fold. |
| `AttachableSocket` | Interface | The subset of `WebSocket` registerHibernatableSocket writes to — the attachment serializer. |
| `autoBoot` | Function | The AGENT specialization of bootResume (issue #231): after `runtime.ready`, self-dispatch `agent_boot` iff the rehydrated slice is resumable, a no-op on a fresh DO. |
| `bootResume` | Function | After `runtime.ready`, derive the single resume Msg from the rehydrated State via `port` and dispatch it exactly once — the generalized AgentBoot. |
| `broadcast` | Function | Broadcast a JSON frame to every connected command-runner socket. |
| `broadcastFrame` | Function | Serialize `frame` ONCE and send it to every OPEN socket in `sockets`, skipping any that is closed, errors on `send`, or is the `except` socket. |
| `broadcastHibernatable` | Function | Broadcast a JSON frame to every hibernatable command-runner socket. |
| `BroadcastOptions` | Interface | Optional knobs for broadcastFrame. |
| `BroadcastReport` | Interface | What a broadcastFrame fan-out did, surfaced rather than swallowed: `sent` is the number of sockets the frame reached; `skipped` is the number passed over (not OPEN, errored on `send`, or the `except` socket). |
| `constantTimeEqual` | Function | Constant-time string equality. |
| `createAgentHost` | Function | Build an AgentHost from the consumer's domain mappings. |
| `deferredGateway` | Function | Build a deferred-tool gateway. |
| `DeferredGateway` | Interface | The deferred-tool gateway. |
| `DeferredStepOutcome` | Type | The `/step` outcome a DEFER-RESUME host returns — like StepOutcome but its 200 body is the 3-arm DeferredStepResponse (it can carry the not-ready arm). |
| `DeferredStepResponse` | Type | The 3-arm response a DEFER-RESUME host returns — the inline StepResponse arms PLUS StepWorking. |
| `DeferResumeHook` | Interface | The DEFER-RESUME hook — the opt-in seam that drives `engine.resume` OUT of the held `/step` request. |
| `DeferStepHostConfig` | Interface | `StepHostConfig` with the defer-resume hook engaged — the presence of `deferResume` is the type-level switch that selects the 3-arm response (see the `stepHost` overloads). |
| `DeliveryId` | Type | Monotonic, gap-free delivery id — the single correlation + dedup key. |
| `doEventSourcedStore` | Function | Build an event-sourced `Store<S>` over `DurableObjectStorage`. |
| `doStore` | Function | `Store<S>` over `DurableObjectStorage`. |
| `DoStoreOptions` | Interface | Options for doStore. |
| `driveProjections` | Function | Wire a ProjectionRegistry to a runtime's transition stream. |
| `durableCommandCarrier` | Function | Build a durable command carrier over a (volatile) `DeferredGateway<R>` and a `PendingEffectsRecorder`. |
| `DurableCommandCarrier` | Type | The durable command carrier — a DurableDeferredGateway whose every tool round-trip is also a durable owed effect. |
| `durableDeferredGateway` | Function | Wrap a `DeferredGateway<R>` so every round-trip is also recorded in a durable `PendingEffectsRecorder`. |
| `durableTimer` | Function | Build a DurableTimer over an injected alarm carrier, a next-deadline computation, and a fire handler. |
| `DurableTimer` | Interface | The activated durable timer. |
| `DurableTimerConfig` | Interface | The construction inputs for durableTimer — the impure edges the grain injects, kept out of the pure reducer exactly like raft/do's `RaftGrainCtx`/room's `ArenaPorts`. |
| `EffectApplied` | Interface | An effect keyed `key` has been APPLIED. |
| `EffectConfirmed` | Interface | An owed effect has been CONFIRMED delivered. |
| `EffectForgotten` | Interface | An applied-marker is no longer needed (its effect can no longer re-fire, e.g. |
| `EffectKey` | Type | The caller-supplied durable dedup identity for an effect — stable across the re-fire (e.g. |
| `EffectLedgerEvent` | Type | The event union the ledger folds over. |
| `EffectOwed` | Interface | An effect is now OWED: it has been decided but its delivery is not yet confirmed. |
| `emptyApplied` | Function | The empty applied set — the fold's seed (a fresh actor has applied nothing). |
| `emptyLedger` | Function | The empty ledger — the fold's seed (a fresh actor owes nothing). |
| `EventLogRange` | Interface | Optional inclusive bounds for EventSourcedStore.readEvents. |
| `EventSourcedOptions` | Interface | Options for doEventSourcedStore. |
| `EventSourcedStore` | Interface | The handle returned by doEventSourcedStore: a `Store<S>` to hand to `run(...)`, plus the append + recovery surface the cooperating DO drives. |
| `ExecuteStep` | Type | Execute one tool call and produce its result (the consumer's hands). |
| `foldApplied` | Function | THE FOLD. |
| `foldLedger` | Function | THE FOLD. |
| `HibernatableCtx` | Interface | The slice of `DurableObjectState` the durable carrier needs: the Hibernation API accept + the registry of hibernatable sockets. |
| `idempotentEffect` | Function | Pair a durable `key` with an external effect `fn` — the brick's primary surface. |
| `IdempotentEffect` | Interface | A keyed external effect. |
| `IdempotentOutcome` | Type | The outcome of running a keyed effect through the guard. |
| `isApplied` | Function | Has this key's effect already been applied (folded into the set)? |
| `isOwed` | Function | Is this id still owed (unconfirmed) in the ledger? |
| `mintRunToken` | Function | Mint a fresh per-run capability token: 32 random bytes, hex-encoded. |
| `NextStep` | Interface | The next tool call to execute — the "continue" arm of a `/step` response. |
| `OwedEffect` | Interface | A single surviving entry to re-emit: its id and the effect it owes. |
| `pendingEffectsLedger` | Function | Build a live recorder. |
| `PendingEffectsLedger` | Type | The pending-effects ledger: owed-but-unconfirmed effects keyed by their monotonic delivery id. |
| `PendingEffectsRecorder` | Interface | A live, monotonic-id-issuing ledger recorder. |
| `PersistedEvent` | Interface | One persisted log entry handed to a EventSourcedStore.readEvents consumer: the monotonic `seq` the event was appended under, paired with the decoded `event`. |
| `presenceCount` | Function | The live connection count for a presence grain — `ctx.getWebSockets(tag) .length`, repopulated by the runtime after a wake. |
| `PresenceCtx` | Interface | The Hibernation slice of `DurableObjectState` a presence grain needs — the accept that hands the socket to the runtime (surviving eviction) and the getter that repopulates the live set after a wake. |
| `PresenceSocket` | Interface | The minimal "send a string frame" surface broadcastFrame needs. |
| `PresenceUpgrade` | Interface | What acceptPresenceSocket hands back: the live server end (to send initial frames on) and the 101 upgrade `Response` (to return from `fetch`). |
| `Projection` | Interface | A named CQRS projection: an independent fold of the write model's `(Msg\|Model)` stream into a private `View`, plus a sink to publish it. |
| `ProjectionErrorContext` | Interface | Context handed to a ProjectionOnError sink alongside the throw. |
| `ProjectionId` | Interface | A projection's identity: `name` (the view) + `key` (the instance). |
| `projectionIdString` | Function | Render a `ProjectionId` to its canonical `name-key` string. |
| `ProjectionOnError` | Type | Sink for a projection `apply`/`emit` throw the driver isolated. |
| `projectionRegistry` | Function | Build an empty ProjectionRegistry. |
| `ProjectionRegistry` | Interface | A driver over a set of projections sharing one write-model stream. |
| `ProjectionRunner` | Interface | A live, running projection instance: the projection's current `View`, its exclusive stored `offset`, and the `present`/`reset` operations the driver (or a rebuild) calls. |
| `ProjectionUpdate` | Interface | One unit the projection driver presents to a projection's `apply`. |
| `rebuildProjection` | Function | Rebuild a projection's view by folding an ordered event stream from the `NoOffset` start. |
| `registerHibernatableSocket` | Function | Register an already-created `server` socket on the DO via the Cloudflare **Hibernation API**: `ctx.acceptWebSocket(server, tags)` hands the socket to the runtime (it survives eviction and re-delivers inbound frames to the DO's `webSocketMessage` lifecycle method), and — when an `attachment` is supplied — persists it via `server.serializeAttachment` so it survives the wake. |
| `RegisterOptions` | Interface | Optional knobs for registerHibernatableSocket / acceptPresenceSocket. |
| `reissueSurvivingEffects` | Function | RE-EMIT ON ACTIVATION (the #91 wake path). |
| `ResumePort` | Interface | The typed cold-wake resume port `bootResume` fires through — the agent's `AgentBootPort` (issue #60) generalized to any DO-hosted machine (issue #231). |
| `runProjection` | Function | Build a ProjectionRunner for a projection, starting from a stored offset (default 0 = `NoOffset`, a fresh run). |
| `runStepLoop` | Function | Drive the pull loop to completion. |
| `RunStepLoopConfig` | Interface | Tuning for runStepLoop. |
| `sseFromAgentEvents` | Function | Wire an SseHub to a runtime's semantic AgentEvent stream (#47). |
| `sseHub` | Function | Build an SSE hub for event type `E` (the consumer's domain event shape). |
| `SseHub` | Interface | A set of SSE sinks plus the plumbing to fan an event out to all of them and to open a `text/event-stream` Response wired to a fresh sink. |
| `sseProjection` | Function | Express an SseHub as a Projection. |
| `StepCtx` | Interface | The minimal `ctx` slice `stepHost` reads — just the alarm-bearing storage. |
| `StepEngine` | Interface | The run-specific operations `stepHost` orchestrates. |
| `stepHost` | Function | Build the `/step` handler for a DO that drives one or more runs over the pull carrier. |
| `StepHostConfig` | Interface | Tuning for `stepHost`'s give-up alarm. |
| `StepLoopOutcome` | Type | The terminal outcome of a full runStepLoop drive. |
| `StepOutcome` | Type | A structured `/step` outcome `stepHost` returns — the response body plus the HTTP status the consumer's route should send. |
| `StepRequest` | Interface | A `/step` request. |
| `StepResponse` | Type | A `/step` response — a discriminated union on `done`: - `{ done: false, step }` — execute `step`, POST its result, ask again. |
| `StepResult` | Interface | The tool result the hands POST back for the step they just executed. |
| `StepTransport` | Type | The `/step` transport the hands POST through (injected; faked in tests). |
| `StepWorking` | Interface | The NOT-READY arm — the run is computing OUT-OF-BAND under a defer-resume host (a production incident: a non-blocking pull carrier must answer a pull with an explicit "computing, poll again" instead of holding the request across a multi-second step). |
| `survivingEffects` | Function | RE-EMIT ON ACTIVATION. |
| `WS_READY_STATE_OPEN` | Variable | The OPEN `readyState` value (`WebSocket.READY_STATE_OPEN` in the Cloudflare runtime). |
