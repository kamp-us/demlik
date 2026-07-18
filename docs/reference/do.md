# @demlik/tea/do

> Durable Object adapter for `@demlik/tea`.

```ts
import { … } from "@demlik/tea/do";
```

## Exports (103)

| Symbol | Kind | Summary |
| --- | --- | --- |
| `acceptCommandSocket` | Function |  |
| `acceptDurableCommandSocket` | Function |  |
| `acceptPresenceSocket` | Function |  |
| `AgentHost` | Interface | The assembled host: the runtime cell + the SSE hub + the framework test seam, owned ONCE. |
| `AgentHostConfig` | Interface | What the consumer supplies to createAgentHost — the domain mappings, nothing of the wiring. |
| `agentIsResumable` | Function |  |
| `AlarmStorage` | Interface | The DO-native alarm slice `stepHost` re-arms. |
| `appliedEffects` | Function |  |
| `AppliedEffects` | Type | The set of keys whose effect has been applied. |
| `AppliedEffectsEvent` | Type | The event union the applied-marker set folds over. |
| `AppliedEffectsGuard` | Interface | A live guard over an applied-marker set. |
| `applyAppliedEvent` | Function |  |
| `applyEffectEvent` | Function |  |
| `AttachableSocket` | Interface | The subset of `WebSocket` registerHibernatableSocket writes to — the attachment serializer. |
| `autoBoot` | Function |  |
| `bootResume` | Function |  |
| `broadcast` | Function |  |
| `broadcastFrame` | Function |  |
| `broadcastHibernatable` | Function |  |
| `BroadcastOptions` | Interface | Optional knobs for broadcastFrame. |
| `BroadcastReport` | Interface | What a broadcastFrame fan-out did, surfaced rather than swallowed: `sent` is the number of sockets the frame reached; `skipped` is the number passed over (not OPEN, errored on `send`, or the `except` socket). |
| `constantTimeEqual` | Function |  |
| `createAgentHost` | Function |  |
| `deferredGateway` | Function |  |
| `DeferredGateway` | Interface | The deferred-tool gateway. |
| `DeferredStepOutcome` | Type | The `/step` outcome a DEFER-RESUME host returns — like StepOutcome but its 200 body is the 3-arm DeferredStepResponse (it can carry the not-ready arm). |
| `DeferredStepResponse` | Type | The 3-arm response a DEFER-RESUME host returns — the inline StepResponse arms PLUS StepWorking. |
| `DeferResumeHook` | Interface | The DEFER-RESUME hook — the opt-in seam that drives `engine.resume` OUT of the held `/step` request. |
| `DeferStepHostConfig` | Interface | `StepHostConfig` with the defer-resume hook engaged — the presence of `deferResume` is the type-level switch that selects the 3-arm response (see the `stepHost` overloads). |
| `DeliveryId` | Type | Monotonic, gap-free delivery id — the single correlation + dedup key. |
| `doEventSourcedStore` | Function |  |
| `doStore` | Function |  |
| `DoStoreOptions` | Interface | Options for doStore. |
| `driveProjections` | Function |  |
| `durableCommandCarrier` | Function |  |
| `DurableCommandCarrier` | Type | The durable command carrier — a DurableDeferredGateway whose every tool round-trip is also a durable owed effect. |
| `durableDeferredGateway` | Function |  |
| `durableTimer` | Function |  |
| `DurableTimer` | Interface | The activated durable timer. |
| `DurableTimerConfig` | Interface | The construction inputs for durableTimer — the impure edges the grain injects, kept out of the pure reducer exactly like raft/do's `RaftGrainCtx`/room's `ArenaPorts`. |
| `EffectApplied` | Interface | An effect keyed `key` has been APPLIED. |
| `EffectConfirmed` | Interface | An owed effect has been CONFIRMED delivered. |
| `EffectForgotten` | Interface | An applied-marker is no longer needed (its effect can no longer re-fire, e.g. |
| `EffectKey` | Type | The caller-supplied durable dedup identity for an effect — stable across the re-fire (e.g. |
| `EffectLedgerEvent` | Type | The event union the ledger folds over. |
| `EffectOwed` | Interface | An effect is now OWED: it has been decided but its delivery is not yet confirmed. |
| `emptyApplied` | Function |  |
| `emptyLedger` | Function |  |
| `EventLogRange` | Interface | Optional inclusive bounds for EventSourcedStore.readEvents. |
| `EventSourcedOptions` | Interface | Options for doEventSourcedStore. |
| `EventSourcedStore` | Interface | The handle returned by doEventSourcedStore: a `Store<S>` to hand to `run(...)`, plus the append + recovery surface the cooperating DO drives. |
| `ExecuteStep` | Type | Execute one tool call and produce its result (the consumer's hands). |
| `foldApplied` | Function |  |
| `foldLedger` | Function |  |
| `HibernatableCtx` | Interface | The slice of `DurableObjectState` the durable carrier needs: the Hibernation API accept + the registry of hibernatable sockets. |
| `idempotentEffect` | Function |  |
| `IdempotentEffect` | Interface | A keyed external effect. |
| `IdempotentOutcome` | Type | The outcome of running a keyed effect through the guard. |
| `isApplied` | Function |  |
| `isOwed` | Function |  |
| `mintRunToken` | Function |  |
| `NextStep` | Interface | The next tool call to execute — the "continue" arm of a `/step` response. |
| `OwedEffect` | Interface | A single surviving entry to re-emit: its id and the effect it owes. |
| `pendingEffectsLedger` | Function |  |
| `PendingEffectsLedger` | Type | The pending-effects ledger: owed-but-unconfirmed effects keyed by their monotonic delivery id. |
| `PendingEffectsRecorder` | Interface | A live, monotonic-id-issuing ledger recorder. |
| `PersistedEvent` | Interface | One persisted log entry handed to a EventSourcedStore.readEvents consumer: the monotonic `seq` the event was appended under, paired with the decoded `event`. |
| `presenceCount` | Function |  |
| `PresenceCtx` | Interface | The Hibernation slice of `DurableObjectState` a presence grain needs — the accept that hands the socket to the runtime (surviving eviction) and the getter that repopulates the live set after a wake. |
| `PresenceSocket` | Interface | The minimal "send a string frame" surface broadcastFrame needs. |
| `PresenceUpgrade` | Interface | What acceptPresenceSocket hands back: the live server end (to send initial frames on) and the 101 upgrade `Response` (to return from `fetch`). |
| `Projection` | Interface | A named CQRS projection: an independent fold of the write model's `(Msg\|Model)` stream into a private `View`, plus a sink to publish it. |
| `ProjectionId` | Interface | A projection's identity: `name` (the view) + `key` (the instance). |
| `projectionIdString` | Function |  |
| `projectionRegistry` | Function |  |
| `ProjectionRegistry` | Interface | A driver over a set of projections sharing one write-model stream. |
| `ProjectionRunner` | Interface | A live, running projection instance: the projection's current `View`, its exclusive stored `offset`, and the `present`/`reset` operations the driver (or a rebuild) calls. |
| `ProjectionUpdate` | Interface | One unit the projection driver presents to a projection's `apply`. |
| `rebuildProjection` | Function |  |
| `registerHibernatableSocket` | Function |  |
| `RegisterOptions` | Interface | Optional knobs for registerHibernatableSocket / acceptPresenceSocket. |
| `reissueSurvivingEffects` | Function |  |
| `ResumePort` | Interface | The typed cold-wake resume port `bootResume` fires through — the agent's `AgentBootPort` (issue #60) generalized to any DO-hosted machine (issue #231). |
| `runProjection` | Function |  |
| `runStepLoop` | Function |  |
| `RunStepLoopConfig` | Interface | Tuning for runStepLoop. |
| `sseFromAgentEvents` | Function |  |
| `sseHub` | Function |  |
| `SseHub` | Interface | A set of SSE sinks plus the plumbing to fan an event out to all of them and to open a `text/event-stream` Response wired to a fresh sink. |
| `sseProjection` | Function |  |
| `StepCtx` | Interface | The minimal `ctx` slice `stepHost` reads — just the alarm-bearing storage. |
| `StepEngine` | Interface | The run-specific operations `stepHost` orchestrates. |
| `stepHost` | Function |  |
| `StepHostConfig` | Interface | Tuning for `stepHost`'s give-up alarm. |
| `StepLoopOutcome` | Type | The terminal outcome of a full runStepLoop drive. |
| `StepOutcome` | Type | A structured `/step` outcome `stepHost` returns — the response body plus the HTTP status the consumer's route should send. |
| `StepRequest` | Interface | A `/step` request. |
| `StepResponse` | Type | A `/step` response — a discriminated union on `done`: - `{ done: false, step }` — execute `step`, POST its result, ask again. |
| `StepResult` | Interface | The tool result the hands POST back for the step they just executed. |
| `StepTransport` | Type | The `/step` transport the hands POST through (injected; faked in tests). |
| `StepWorking` | Interface | The NOT-READY arm — the run is computing OUT-OF-BAND under a defer-resume host (Binclusive ADR 0035 / prod incident #1873: a non-blocking pull carrier must answer a pull with an explicit "computing, poll again" instead of holding the request across a multi-second step). |
| `survivingEffects` | Function |  |
| `WS_READY_STATE_OPEN` | Variable | The OPEN `readyState` value (`WebSocket.READY_STATE_OPEN` in the Cloudflare runtime). |
