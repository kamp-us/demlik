# @demlik/tea/do

> Durable Object adapter for `@demlik/tea`.

Tier: `stable`

```ts
import { … } from "@demlik/tea/do";
```

## Exports (105)

| Symbol | Kind | Tier | Summary |
| --- | --- | --- | --- |
| [`acceptCommandSocket`](#acceptCommandSocket) | Function | stable | Accept a command-runner WebSocket on the DO's `fetch`. |
| [`acceptDurableCommandSocket`](#acceptDurableCommandSocket) | Function | stable | Accept a command-runner WebSocket using the Cloudflare **Hibernation API** so the socket survives DO eviction. |
| [`acceptPresenceSocket`](#acceptPresenceSocket) | Function | stable | Accept a client WebSocket upgrade on a native DO and register it for hibernation. |
| [`AgentHost`](#AgentHost) | Interface | stable | The assembled host: the runtime handle + the SSE hub + the framework test seam, owned ONCE. |
| [`AgentHostConfig`](#AgentHostConfig) | Interface | stable | What the consumer supplies to createAgentHost — the domain mappings, nothing of the wiring. |
| [`agentIsResumable`](#agentIsResumable) | Function | stable | True iff an agent slice loaded from storage is mid-loop (running + awaiting tools) — the resumable case `agent_boot` re-fires. |
| [`AlarmStorage`](#AlarmStorage) | Interface | stable | The DO-native alarm slice `stepHost` re-arms. |
| [`appliedEffects`](#appliedEffects) | Function | stable | Build a live guard. |
| [`AppliedEffects`](#AppliedEffects) | Type | stable | The set of keys whose effect has been applied. |
| [`AppliedEffectsEvent`](#AppliedEffectsEvent) | Type | stable | The event union the applied-marker set folds over. |
| [`AppliedEffectsGuard`](#AppliedEffectsGuard) | Interface | stable | A live guard over an applied-marker set. |
| [`applyAppliedEvent`](#applyAppliedEvent) | Function | stable | Apply ONE event — the reducer at the heart of the fold. |
| [`applyEffectEvent`](#applyEffectEvent) | Function | stable | Apply ONE ledger event — the reducer at the heart of the fold. |
| [`AttachableSocket`](#AttachableSocket) | Interface | stable | The subset of `WebSocket` registerHibernatableSocket writes to — the attachment serializer. |
| [`autoBoot`](#autoBoot) | Function | stable | The AGENT specialization of bootResume: after `runtime.ready`, self-dispatch `agent_boot` iff the rehydrated slice is resumable, a no-op on a fresh DO. |
| [`bootResume`](#bootResume) | Function | stable | After `runtime.ready`, derive the single resume Msg from the rehydrated State via `port` and dispatch it exactly once — the generalized AgentBoot. |
| [`broadcast`](#broadcast) | Function | stable | Broadcast a JSON frame to every connected command-runner socket. |
| [`broadcastFrame`](#broadcastFrame) | Function | stable | Serialize `frame` ONCE and send it to every OPEN socket in `sockets`, skipping any that is closed, errors on `send`, or is the `except` socket. |
| [`broadcastHibernatable`](#broadcastHibernatable) | Function | stable | Broadcast a JSON frame to every hibernatable command-runner socket. |
| [`BroadcastOptions`](#BroadcastOptions) | Interface | stable | Optional settings for broadcastFrame. |
| [`BroadcastReport`](#BroadcastReport) | Interface | stable | What a broadcastFrame fan-out did, surfaced rather than swallowed: `sent` is the number of sockets the frame reached; `skipped` is the number passed over (not OPEN, errored on `send`, or the `except` socket). |
| [`constantTimeEqual`](#constantTimeEqual) | Function | stable | Constant-time string equality. |
| [`createAgentHost`](#createAgentHost) | Function | stable | Build an AgentHost from the consumer's domain mappings. |
| [`deferredGateway`](#deferredGateway) | Function | stable | Build a deferred-tool gateway. |
| [`DeferredGateway`](#DeferredGateway) | Interface | stable | The deferred-tool gateway. |
| [`DeferredStepOutcome`](#DeferredStepOutcome) | Type | stable | The `/step` outcome a DEFER-RESUME host returns — like StepOutcome but its 200 body is the 3-arm DeferredStepResponse (it can carry the not-ready arm). |
| [`DeferredStepResponse`](#DeferredStepResponse) | Type | stable | The 3-arm response a DEFER-RESUME host returns — the inline StepResponse arms PLUS StepWorking. |
| [`DeferResumeHook`](#DeferResumeHook) | Interface | stable | The DEFER-RESUME hook — the opt-in seam that drives `engine.resume` OUT of the held `/step` request. |
| [`DeferStepHostConfig`](#DeferStepHostConfig) | Interface | stable | `StepHostConfig` with the defer-resume hook engaged — the presence of `deferResume` is the type-level switch that selects the 3-arm response (see the `stepHost` overloads). |
| [`DeliveryId`](#DeliveryId) | Type | stable | Monotonic, gap-free delivery id — the single correlation + dedup key. |
| [`doEventSourcedStore`](#doEventSourcedStore) | Function | stable | Build an event-sourced `Store<S>` over `DurableObjectStorage`. |
| [`doStore`](#doStore) | Function | stable | `Store<S>` over `DurableObjectStorage`. |
| [`DoStoreOptions`](#DoStoreOptions) | Interface | stable | Options for doStore. |
| [`driveProjections`](#driveProjections) | Function | stable | Wire a ProjectionRegistry to a runtime's transition stream. |
| [`durableCommandCarrier`](#durableCommandCarrier) | Function | stable | Build a durable command carrier over a (volatile) `DeferredGateway<R>` and a `PendingEffectsRecorder`. |
| [`DurableCommandCarrier`](#DurableCommandCarrier) | Type | stable | The durable command carrier — a DurableDeferredGateway whose every tool round-trip is also a durable owed effect. |
| [`durableDeferredGateway`](#durableDeferredGateway) | Function | stable | Wrap a `DeferredGateway<R>` so every round-trip is also recorded in a durable `PendingEffectsRecorder`. |
| [`durableTimer`](#durableTimer) | Function | stable | Build a DurableTimer over an injected alarm carrier, a next-deadline computation, and a fire handler. |
| [`DurableTimer`](#DurableTimer) | Interface | stable | The activated durable timer. |
| [`DurableTimerConfig`](#DurableTimerConfig) | Interface | stable | The construction inputs for durableTimer — the impure edges the grain injects, kept out of the pure reducer exactly like raft/do's `RaftGrainCtx`/room's `ArenaPorts`. |
| [`EffectApplied`](#EffectApplied) | Interface | stable | An effect keyed `key` has been APPLIED. |
| [`EffectConfirmed`](#EffectConfirmed) | Interface | stable | An owed effect has been CONFIRMED delivered. |
| [`EffectForgotten`](#EffectForgotten) | Interface | stable | An applied-marker is no longer needed (its effect can no longer re-fire, e.g. |
| [`EffectKey`](#EffectKey) | Type | stable | The caller-supplied durable dedup identity for an effect — stable across the re-fire (e.g. |
| [`EffectLedgerEvent`](#EffectLedgerEvent) | Type | stable | The event union the ledger folds over. |
| [`EffectOwed`](#EffectOwed) | Interface | stable | An effect is now OWED: it has been decided but its delivery is not yet confirmed. |
| [`emptyApplied`](#emptyApplied) | Function | stable | The empty applied set — the fold's starting value (a fresh actor has applied nothing). |
| [`emptyLedger`](#emptyLedger) | Function | stable | The empty ledger — the fold's starting value (a fresh actor owes nothing). |
| [`EventLogRange`](#EventLogRange) | Interface | stable | Optional inclusive bounds for EventSourcedStore.readEvents. |
| [`EventSourcedOptions`](#EventSourcedOptions) | Interface | stable | Options for doEventSourcedStore. |
| [`EventSourcedStore`](#EventSourcedStore) | Interface | stable | The handle returned by doEventSourcedStore: a `Store<S>` to hand to `run(...)`, plus the append + recovery surface the cooperating DO drives. |
| [`ExecuteStep`](#ExecuteStep) | Type | stable | Execute one tool call and produce its result (the consumer's hands). |
| [`foldApplied`](#foldApplied) | Function | stable | THE FOLD. |
| [`foldLedger`](#foldLedger) | Function | stable | THE FOLD. |
| [`HibernatableCtx`](#HibernatableCtx) | Interface | stable | The slice of `DurableObjectState` the durable carrier needs: the Hibernation API accept + the registry of hibernatable sockets. |
| [`idempotentEffect`](#idempotentEffect) | Function | stable | Pair a durable `key` with an external effect `fn` — this module's primary surface. |
| [`IdempotentEffect`](#IdempotentEffect) | Interface | stable | A keyed external effect. |
| [`IdempotentOutcome`](#IdempotentOutcome) | Type | stable | The outcome of running a keyed effect through the guard. |
| [`isApplied`](#isApplied) | Function | stable | Has this key's effect already been applied (folded into the set)? |
| [`isOwed`](#isOwed) | Function | stable | Is this id still owed (unconfirmed) in the ledger? |
| [`mintRunToken`](#mintRunToken) | Function | stable | Mint a fresh per-run capability token: 32 random bytes, hex-encoded. |
| [`NextStep`](#NextStep) | Interface | stable | The next tool call to execute — the "continue" arm of a `/step` response. |
| [`OwedEffect`](#OwedEffect) | Interface | stable | A single surviving entry to re-emit: its id and the effect it owes. |
| [`pendingEffectsLedger`](#pendingEffectsLedger) | Function | stable | Build a live recorder. |
| [`PendingEffectsLedger`](#PendingEffectsLedger) | Type | stable | The pending-effects ledger: owed-but-unconfirmed effects keyed by their monotonic delivery id. |
| [`PendingEffectsRecorder`](#PendingEffectsRecorder) | Interface | stable | A live, monotonic-id-issuing ledger recorder. |
| [`PersistedEvent`](#PersistedEvent) | Interface | stable | One persisted log entry handed to a EventSourcedStore.readEvents consumer: the monotonic `seq` the event was appended under, paired with the decoded `event`. |
| [`presenceCount`](#presenceCount) | Function | stable | The live connection count for a presence grain — `ctx.getWebSockets(tag) .length`, repopulated by the runtime after a wake. |
| [`PresenceCtx`](#PresenceCtx) | Interface | stable | The Hibernation slice of `DurableObjectState` a presence grain needs — the accept that hands the socket to the runtime (surviving eviction) and the getter that repopulates the live set after a wake. |
| [`PresenceSocket`](#PresenceSocket) | Interface | stable | The minimal "send a string frame" surface broadcastFrame needs. |
| [`PresenceUpgrade`](#PresenceUpgrade) | Interface | stable | What acceptPresenceSocket hands back: the live server end (to send initial frames on) and the 101 upgrade `Response` (to return from `fetch`). |
| [`Projection`](#Projection) | Interface | stable | A named CQRS projection: an independent fold of the write model's `(Msg\|Model)` stream into a private `View`, plus a sink to publish it. |
| [`ProjectionErrorContext`](#ProjectionErrorContext) | Interface | stable | Context handed to a ProjectionOnError sink alongside the throw. |
| [`ProjectionId`](#ProjectionId) | Interface | stable | A projection's identity: `name` (the view) + `key` (the instance). |
| [`projectionIdString`](#projectionIdString) | Function | stable | Render a `ProjectionId` to its canonical `name-key` string. |
| [`ProjectionOnError`](#ProjectionOnError) | Type | stable | Sink for a projection `apply`/`emit` throw the driver isolated. |
| [`projectionRegistry`](#projectionRegistry) | Function | stable | Build an empty ProjectionRegistry. |
| [`ProjectionRegistry`](#ProjectionRegistry) | Interface | stable | A driver over a set of projections sharing one write-model stream. |
| [`ProjectionRunner`](#ProjectionRunner) | Interface | stable | A live, running projection instance: the projection's current `View`, its exclusive stored `offset`, and the `present`/`reset` operations the driver (or a rebuild) calls. |
| [`ProjectionUpdate`](#ProjectionUpdate) | Interface | stable | One unit the projection driver presents to a projection's `apply`. |
| [`rebuildProjection`](#rebuildProjection) | Function | stable | Rebuild a projection's view by folding an ordered event stream from the `NoOffset` start. |
| [`registerHibernatableSocket`](#registerHibernatableSocket) | Function | stable | Register an already-created `server` socket on the DO via the Cloudflare **Hibernation API**: `ctx.acceptWebSocket(server, tags)` hands the socket to the runtime (it survives eviction and re-delivers inbound frames to the DO's `webSocketMessage` lifecycle method), and — when an `attachment` is supplied — persists it via `server.serializeAttachment` so it survives the wake. |
| [`RegisterOptions`](#RegisterOptions) | Interface | stable | Optional settings for registerHibernatableSocket / acceptPresenceSocket. |
| [`reissueSurvivingEffects`](#reissueSurvivingEffects) | Function | stable | Re-fire every round-trip a rehydrated actor still owes, on wake. |
| [`ResumePort`](#ResumePort) | Interface | stable | The typed cold-wake resume port `bootResume` fires through — the agent's `AgentBootPort`, generalized to any DO-hosted machine. |
| [`runProjection`](#runProjection) | Function | stable | Build a ProjectionRunner for a projection, starting from a stored offset (default 0 = `NoOffset`, a fresh run). |
| [`runStepLoop`](#runStepLoop) | Function | stable | Drive the pull loop to completion. |
| [`RunStepLoopConfig`](#RunStepLoopConfig) | Interface | stable | Tuning for runStepLoop. |
| [`sseFromAgentEvents`](#sseFromAgentEvents) | Function | stable | Wire an SseHub to a runtime's semantic AgentEvent stream. |
| [`sseHub`](#sseHub) | Function | stable | Build an SSE hub for event type `E` (the consumer's domain event shape). |
| [`SseHub`](#SseHub) | Interface | stable | A set of SSE sinks plus the plumbing to fan an event out to all of them and to open a `text/event-stream` Response wired to a fresh sink. |
| [`sseProjection`](#sseProjection) | Function | stable | Express an SseHub as a Projection. |
| [`StepCtx`](#StepCtx) | Interface | stable | The minimal `ctx` slice `stepHost` reads — just the alarm-bearing storage. |
| [`StepEngine`](#StepEngine) | Interface | stable | The run-specific operations `stepHost` orchestrates. |
| [`stepHost`](#stepHost) | Function | stable | Build the `/step` handler for a DO that drives one or more runs over the pull carrier. |
| [`StepHostConfig`](#StepHostConfig) | Interface | stable | Tuning for `stepHost`'s give-up alarm. |
| [`StepLoopOutcome`](#StepLoopOutcome) | Type | stable | The terminal outcome of a full runStepLoop drive. |
| [`StepOutcome`](#StepOutcome) | Type | stable | A structured `/step` outcome `stepHost` returns — the response body plus the HTTP status the consumer's route should send. |
| [`StepRequest`](#StepRequest) | Interface | stable | A `/step` request. |
| [`StepResponse`](#StepResponse) | Type | stable | A `/step` response — a discriminated union on `done`: - `{ done: false, step }` — execute `step`, POST its result, ask again. |
| [`StepResult`](#StepResult) | Interface | stable | The tool result the hands POST back for the step they just executed. |
| [`StepTransport`](#StepTransport) | Type | stable | The `/step` transport the hands POST through (injected; faked in tests). |
| [`StepWorking`](#StepWorking) | Interface | stable | The NOT-READY arm — the run is computing OUT-OF-BAND under a defer-resume host (a production incident: a non-blocking pull carrier must answer a pull with an explicit "computing, poll again" instead of holding the request across a multi-second step). |
| [`survivingEffects`](#survivingEffects) | Function | stable | RE-EMIT ON ACTIVATION. |
| [`WS_READY_STATE_OPEN`](#WS_READY_STATE_OPEN) | Variable | stable | The OPEN `readyState` value (`WebSocket.READY_STATE_OPEN` in the Cloudflare runtime). |

## Declarations

<a id="acceptCommandSocket"></a>

### `acceptCommandSocket`

```ts
function acceptCommandSocket(
  clients: Set<WebSocket>,
  onFrame: (data: string) => void,
): Response
```

<a id="acceptDurableCommandSocket"></a>

### `acceptDurableCommandSocket`

```ts
function acceptDurableCommandSocket(ctx: HibernatableCtx): Response
```

<a id="acceptPresenceSocket"></a>

### `acceptPresenceSocket`

```ts
function acceptPresenceSocket<A>(
  ctx: PresenceCtx,
  options?: RegisterOptions<A>,
): PresenceUpgrade
```

<a id="AgentHost"></a>

### `AgentHost`

```ts
interface AgentHost<Stage, P extends string, O extends Record<P, AgentTurn>, R, Frame> {
  readonly sse: SseHub<Frame>;
  reset(): Promise<void>;
  result(): Promise<AgentState<Stage, P, O, R> | undefined>;
  runtime(): Promise<BootedRunHandle<AgentState<Stage, P, O, R>, AgentMachineMsg<P, O, R>, AgentEvent<R>>>;
  status(): Promise<AgentStatus<Stage>>;
}
```

<a id="AgentHostConfig"></a>

### `AgentHostConfig`

```ts
interface AgentHostConfig<
  Stage,
  P extends string,
  O extends Record<P, AgentTurn>,
  R,
  Frame,
  C extends Cmd = Cmd,
  U extends Sub = Sub,
  Ctx = unknown,
> {
  readonly buildMachine: () => Wired<AgentState<Stage, P, O, R>, AgentMachineMsg<P, O, R>, C, U, Ctx>;
  readonly ctx: Ctx;
  readonly now?: () => number;
  readonly run: EngineRun<AgentState<Stage, P, O, R>, AgentMachineMsg<P, O, R>, C, U, Ctx, AgentEvent<R>>;
  readonly store: Store<AgentState<Stage, P, O, R>>;
  readonly terminal?: (state: AgentState<Stage, P, O, R>) => boolean;
  readonly toSseFrame: (event: AgentEvent<R>) => Frame | null;
}
```

<a id="agentIsResumable"></a>

### `agentIsResumable`

```ts
function agentIsResumable<
  Stage,
  P extends string,
  O extends Record<P, unknown>,
  R,
>(
  state: AgentState<Stage, P, O, R>,
): boolean
```

<a id="AlarmStorage"></a>

### `AlarmStorage`

```ts
interface AlarmStorage {
  setAlarm(scheduledTime: number): void | Promise<void>;
}
```

<a id="appliedEffects"></a>

### `appliedEffects`

```ts
function appliedEffects(
  restore?: {
    readonly events?: Iterable<AppliedEffectsEvent, any, any>;
  },
): AppliedEffectsGuard
```

<a id="AppliedEffects"></a>

### `AppliedEffects`

```ts
type AppliedEffects = ReadonlySet<EffectKey>
```

<a id="AppliedEffectsEvent"></a>

### `AppliedEffectsEvent`

```ts
type AppliedEffectsEvent = EffectApplied | EffectForgotten
```

<a id="AppliedEffectsGuard"></a>

### `AppliedEffectsGuard`

```ts
interface AppliedEffectsGuard {
  applied(): AppliedEffects;
  forget(key: string): { readonly event: EffectForgotten };
  isApplied(key: string): boolean;
  run<A>(effect: IdempotentEffect<A>): Promise<IdempotentOutcome<A>>;
}
```

<a id="applyAppliedEvent"></a>

### `applyAppliedEvent`

```ts
function applyAppliedEvent(
  applied: AppliedEffects,
  event: AppliedEffectsEvent,
): AppliedEffects
```

<a id="applyEffectEvent"></a>

### `applyEffectEvent`

```ts
function applyEffectEvent<E>(
  ledger: PendingEffectsLedger<E>,
  event: EffectLedgerEvent<E>,
): PendingEffectsLedger<E>
```

<a id="AttachableSocket"></a>

### `AttachableSocket`

```ts
interface AttachableSocket {
  serializeAttachment(value: unknown): void;
}
```

<a id="autoBoot"></a>

### `autoBoot`

```ts
function autoBoot<
  Stage,
  P extends string,
  O extends Record<P, unknown>,
  R,
  E extends { type: string } = never,
>(
  booting: RunHandle<AgentState<Stage, P, O, R>, AgentMachineMsg<P, O, R>, E>,
  now?: () => number,
): Promise<void>
```

<a id="bootResume"></a>

### `bootResume`

```ts
function bootResume<
  S,
  M extends { type: string },
  E extends { type: string } = never,
>(
  booting: RunHandle<S, M, E>,
  port: ResumePort<S, M>,
  now?: () => number,
): Promise<void>
```

<a id="broadcast"></a>

### `broadcast`

```ts
function broadcast(clients: Set<WebSocket>, frame: unknown): void
```

<a id="broadcastFrame"></a>

### `broadcastFrame`

```ts
function broadcastFrame<S extends PresenceSocket>(
  sockets: Iterable<S>,
  frame: unknown,
  options?: BroadcastOptions<S>,
): BroadcastReport
```

<a id="broadcastHibernatable"></a>

### `broadcastHibernatable`

```ts
function broadcastHibernatable(ctx: HibernatableCtx, frame: unknown): void
```

<a id="BroadcastOptions"></a>

### `BroadcastOptions`

```ts
interface BroadcastOptions<S extends PresenceSocket> {
  readonly except?: S;
  readonly serialize?: (frame: unknown) => string;
}
```

<a id="BroadcastReport"></a>

### `BroadcastReport`

```ts
interface BroadcastReport {
  readonly sent: number;
  readonly skipped: number;
}
```

<a id="constantTimeEqual"></a>

### `constantTimeEqual`

```ts
function constantTimeEqual(a: string, b: string): boolean
```

<a id="createAgentHost"></a>

### `createAgentHost`

```ts
function createAgentHost<
  Stage,
  P extends string,
  O extends Record<P, AgentTurn>,
  R,
  Frame,
  C extends Cmd = Cmd,
  U extends Sub = Sub,
  Ctx = unknown,
>(
  config: AgentHostConfig<Stage, P, O, R, Frame, C, U, Ctx>,
): AgentHost<Stage, P, O, R, Frame>
```

<a id="deferredGateway"></a>

### `deferredGateway`

```ts
function deferredGateway<R>(): DeferredGateway<R>
```

<a id="DeferredGateway"></a>

### `DeferredGateway`

```ts
interface DeferredGateway<R> {
  await(callId: string, send: () => void, deadlineMs: number): Promise<R>;
  fail(callId: string, reason: string): void;
  inFlight(): readonly string[];
  settle(callId: string, result: R): void;
}
```

<a id="DeferredStepOutcome"></a>

### `DeferredStepOutcome`

```ts
type DeferredStepOutcome<I, O> =
  | {
    readonly body: DeferredStepResponse<I, O>;
    readonly status: 200;
  }
  | {
    readonly body: { readonly error: string };
    readonly status: 401 | 404;
  }
```

<a id="DeferredStepResponse"></a>

### `DeferredStepResponse`

```ts
type DeferredStepResponse<I, O> = StepResponse<I, O> | StepWorking
```

<a id="DeferResumeHook"></a>

### `DeferResumeHook`

```ts
interface DeferResumeHook<R> {
  readonly retryAfterMs?: number;
  enqueue(runId: string, posted: StepResult<R>): void | Promise<void>;
  settled(runId: string, callId: string): boolean | Promise<boolean>;
}
```

<a id="DeferStepHostConfig"></a>

### `DeferStepHostConfig`

```ts
interface DeferStepHostConfig<R> extends StepHostConfig {
  readonly deferResume: DeferResumeHook<R>;
}
```

<a id="DeliveryId"></a>

### `DeliveryId`

```ts
type DeliveryId = number
```

<a id="doEventSourcedStore"></a>

### `doEventSourcedStore`

```ts
function doEventSourcedStore<
  S,
  M extends { type: string },
  Ctx,
  C extends Cmd = Cmd,
  U extends Sub = Sub,
>(
  storage: DurableObjectStorage,
  machine: Machine<S, M, C, U, Ctx>,
  ctx: Ctx,
  opts?: EventSourcedOptions<S, M>,
): EventSourcedStore<S, M>
```

<a id="doStore"></a>

### `doStore`

```ts
function doStore<S>(
  storage: DurableObjectStorage,
  parse: (raw: unknown) => Migrated<S>,
  keyOrOptions: DoStoreOptions<S> & { readonly fenced: true },
): FencedStore<S> & DeletableStore<S>
function doStore<S>(
  storage: DurableObjectStorage,
  parse: (raw: unknown) => Migrated<S>,
  keyOrOptions?: string | DoStoreOptions<S>,
): DeletableStore<S>
```

<a id="DoStoreOptions"></a>

### `DoStoreOptions`

```ts
interface DoStoreOptions<S> {
  readonly fenced?: true;
  readonly key?: string;
  readonly serialize?: (state: S) => unknown;
}
```

<a id="driveProjections"></a>

### `driveProjections`

```ts
function driveProjections<Model, Msg extends { type: string }>(
  registry: ProjectionRegistry<Model, Msg>,
  runtime: {
    observe(observer: (msg: Msg, model: Model) => void): () => void;
    onBoot(handler: (model: Model) => void): () => void;
  },
): () => void
```

<a id="durableCommandCarrier"></a>

### `durableCommandCarrier`

```ts
function durableCommandCarrier<R>(
  inner: DeferredGateway<R>,
  recorder: PendingEffectsRecorder<{ callId: string }>,
  hooks: {
    recordConfirmed(callId: string, event: EffectConfirmed): void;
    recordOwed(callId: string, event: EffectOwed<{ callId: string }>): void;
  },
): DurableCommandCarrier<R>
```

<a id="DurableCommandCarrier"></a>

### `DurableCommandCarrier`

```ts
type DurableCommandCarrier<R> = DurableDeferredGateway<R>
```

<a id="durableDeferredGateway"></a>

### `durableDeferredGateway`

```ts
function durableDeferredGateway<R>(
  inner: DeferredGateway<R>,
  recorder: PendingEffectsRecorder<{ callId: string }>,
  hooks: {
    recordConfirmed(callId: string, event: EffectConfirmed): void;
    recordOwed(callId: string, event: EffectOwed<{ callId: string }>): void;
  },
): DurableDeferredGateway<R>
```

<a id="durableTimer"></a>

### `durableTimer`

```ts
function durableTimer(config: DurableTimerConfig): DurableTimer
```

<a id="DurableTimer"></a>

### `DurableTimer`

```ts
interface DurableTimer {
  onAlarm(): Promise<void>;
  rearm(): Promise<void>;
}
```

<a id="DurableTimerConfig"></a>

### `DurableTimerConfig`

```ts
interface DurableTimerConfig {
  readonly alarm: AlarmStorage;
  nextDeadline(): number | Promise<number | null> | null;
  onFire(): void | Promise<void>;
}
```

<a id="EffectApplied"></a>

### `EffectApplied`

```ts
interface EffectApplied extends Cmd<"effect_applied"> {
  readonly key: string;
}
```

<a id="EffectConfirmed"></a>

### `EffectConfirmed`

```ts
interface EffectConfirmed extends Cmd<"effect_confirmed"> {
  readonly id: number;
}
```

<a id="EffectForgotten"></a>

### `EffectForgotten`

```ts
interface EffectForgotten extends Cmd<"effect_forgotten"> {
  readonly key: string;
}
```

<a id="EffectKey"></a>

### `EffectKey`

```ts
type EffectKey = string
```

<a id="EffectLedgerEvent"></a>

### `EffectLedgerEvent`

```ts
type EffectLedgerEvent<E> = EffectOwed<E> | EffectConfirmed
```

<a id="EffectOwed"></a>

### `EffectOwed`

```ts
interface EffectOwed<E> extends Cmd<"effect_owed"> {
  readonly effect: E;
  readonly id: number;
}
```

<a id="emptyApplied"></a>

### `emptyApplied`

```ts
function emptyApplied(): AppliedEffects
```

<a id="emptyLedger"></a>

### `emptyLedger`

```ts
function emptyLedger<E>(): PendingEffectsLedger<E>
```

<a id="EventLogRange"></a>

### `EventLogRange`

```ts
interface EventLogRange {
  readonly fromSeq?: number;
  readonly toSeq?: number;
}
```

<a id="EventSourcedOptions"></a>

### `EventSourcedOptions`

```ts
interface EventSourcedOptions<S, M> {
  readonly keys?: {
    readonly eventPrefix?: string;
    readonly meta?: string;
    readonly snapshot?: string;
  };
  readonly onReady?: (state: S) => void;
  readonly parse?: (raw: unknown) => S | null;
  readonly parseEvent?: (raw: unknown) => M | null;
  readonly snapshotEvery?: number;
}
```

<a id="EventSourcedStore"></a>

### `EventSourcedStore`

```ts
interface EventSourcedStore<S, M> {
  readonly store: Store<S>;
  append(msg: M): Promise<void>;
  readEvents(range?: EventLogRange): AsyncIterable<PersistedEvent<M>>;
  snapshotNow(): Promise<boolean>;
}
```

<a id="ExecuteStep"></a>

### `ExecuteStep`

```ts
type ExecuteStep<I, R> = (step: NextStep<I>) => Promise<R> | R
```

<a id="foldApplied"></a>

### `foldApplied`

```ts
function foldApplied(events: Iterable<AppliedEffectsEvent>): AppliedEffects
```

<a id="foldLedger"></a>

### `foldLedger`

```ts
function foldLedger<E>(
  events: Iterable<EffectLedgerEvent<E>>,
): PendingEffectsLedger<E>
```

<a id="HibernatableCtx"></a>

### `HibernatableCtx`

```ts
interface HibernatableCtx {
  acceptWebSocket(ws: WebSocket): void;
  getWebSockets(): WebSocket[];
}
```

<a id="idempotentEffect"></a>

### `idempotentEffect`

```ts
function idempotentEffect<A>(
  key: string,
  fn: () => A | Promise<A>,
): IdempotentEffect<A>
```

<a id="IdempotentEffect"></a>

### `IdempotentEffect`

```ts
interface IdempotentEffect<A> {
  readonly fn: () => A | Promise<A>;
  readonly key: string;
}
```

<a id="IdempotentOutcome"></a>

### `IdempotentOutcome`

```ts
type IdempotentOutcome<A> =
  | {
    readonly event: EffectApplied;
    readonly key: EffectKey;
    readonly ran: true;
    readonly result: A;
  }
  | { readonly key: EffectKey; readonly ran: false }
```

<a id="isApplied"></a>

### `isApplied`

```ts
function isApplied(applied: AppliedEffects, key: string): boolean
```

<a id="isOwed"></a>

### `isOwed`

```ts
function isOwed<E>(ledger: PendingEffectsLedger<E>, id: number): boolean
```

<a id="mintRunToken"></a>

### `mintRunToken`

```ts
function mintRunToken(randomBytes?: (n: number) => Uint8Array): string
```

<a id="NextStep"></a>

### `NextStep`

```ts
interface NextStep<I> {
  readonly callId: string;
  readonly input: I;
  readonly tool: string;
}
```

<a id="OwedEffect"></a>

### `OwedEffect`

```ts
interface OwedEffect<E> {
  readonly effect: E;
  readonly id: number;
}
```

<a id="pendingEffectsLedger"></a>

### `pendingEffectsLedger`

```ts
function pendingEffectsLedger<E>(
  restore?: {
    readonly events?: Iterable<EffectLedgerEvent<E>, any, any>;
    readonly lastId?: number;
  },
): PendingEffectsRecorder<E>
```

<a id="PendingEffectsLedger"></a>

### `PendingEffectsLedger`

```ts
type PendingEffectsLedger<E> = ReadonlyMap<DeliveryId, E>
```

<a id="PendingEffectsRecorder"></a>

### `PendingEffectsRecorder`

```ts
interface PendingEffectsRecorder<E> {
  confirm(id: number): { confirmed: boolean; event: EffectConfirmed };
  lastId(): number;
  ledger(): PendingEffectsLedger<E>;
  owe(effect: E): { event: EffectOwed<E>; id: number };
  surviving(): readonly OwedEffect<E>[];
}
```

<a id="PersistedEvent"></a>

### `PersistedEvent`

```ts
interface PersistedEvent<M> {
  readonly event: M;
  readonly seq: number;
}
```

<a id="presenceCount"></a>

### `presenceCount`

```ts
function presenceCount(ctx: PresenceCtx, tag?: string): number
```

<a id="PresenceCtx"></a>

### `PresenceCtx`

```ts
interface PresenceCtx {
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
}
```

<a id="PresenceSocket"></a>

### `PresenceSocket`

```ts
interface PresenceSocket {
  readonly readyState?: number;
  send(message: string): void;
}
```

<a id="PresenceUpgrade"></a>

### `PresenceUpgrade`

```ts
interface PresenceUpgrade {
  readonly response: Response;
  readonly server: WebSocket;
}
```

<a id="Projection"></a>

### `Projection`

```ts
interface Projection<Model, Msg extends { type: string }, View> {
  readonly id: ProjectionId;
  readonly initial: View;
  apply(view: View, update: ProjectionUpdate<Model, Msg>): View;
  emit(view: View): void;
}
```

<a id="ProjectionErrorContext"></a>

### `ProjectionErrorContext`

```ts
interface ProjectionErrorContext {
  readonly id: ProjectionId;
}
```

<a id="ProjectionId"></a>

### `ProjectionId`

```ts
interface ProjectionId {
  readonly key: string;
  readonly name: string;
}
```

<a id="projectionIdString"></a>

### `projectionIdString`

```ts
function projectionIdString(id: ProjectionId): string
```

<a id="ProjectionOnError"></a>

### `ProjectionOnError`

```ts
type ProjectionOnError = (error: unknown, context: ProjectionErrorContext) => void
```

<a id="projectionRegistry"></a>

### `projectionRegistry`

```ts
function projectionRegistry<Model, Msg extends { type: string }>(
  onError?: ProjectionOnError,
): ProjectionRegistry<Model, Msg>
```

<a id="ProjectionRegistry"></a>

### `ProjectionRegistry`

```ts
interface ProjectionRegistry<Model, Msg extends { type: string }> {
  dispatch(msg: Msg | null, model: Model): number;
  offset(): number;
  register<View>(
    projection: Projection<Model, Msg, View>,
    startOffset?: number,
  ): ProjectionRunner<Model, Msg, View>;
  runners(): readonly ProjectionRunner<Model, Msg, unknown>[];
}
```

<a id="ProjectionRunner"></a>

### `ProjectionRunner`

```ts
interface ProjectionRunner<Model, Msg extends { type: string }, View> {
  readonly id: ProjectionId;
  offset(): number;
  present(update: ProjectionUpdate<Model, Msg>): boolean;
  reset(): void;
  view(): View;
}
```

<a id="ProjectionUpdate"></a>

### `ProjectionUpdate`

```ts
interface ProjectionUpdate<Model, Msg> {
  readonly model: Model;
  readonly msg: Msg | null;
  readonly offset: number;
}
```

<a id="rebuildProjection"></a>

### `rebuildProjection`

```ts
function rebuildProjection<Model, Msg extends { type: string }, View>(
  projection: Projection<Model, Msg, View>,
  updates: readonly {
    readonly model: Model;
    readonly msg: Msg | null;
  }[],
): ProjectionRunner<Model, Msg, View>
```

<a id="registerHibernatableSocket"></a>

### `registerHibernatableSocket`

```ts
function registerHibernatableSocket<S extends AttachableSocket, A>(
  ctx: PresenceCtx,
  server: S,
  options?: RegisterOptions<A>,
): void
```

<a id="RegisterOptions"></a>

### `RegisterOptions`

```ts
interface RegisterOptions<A> {
  readonly attachment?: A;
  readonly tags?: readonly string[];
}
```

<a id="reissueSurvivingEffects"></a>

### `reissueSurvivingEffects`

```ts
function reissueSurvivingEffects<R>(
  carrier: DurableCommandCarrier<R>,
  reissue: (callId: string) => void,
): readonly string[]
```

<a id="ResumePort"></a>

### `ResumePort`

```ts
interface ResumePort<S, M extends { type: string }> {
  readonly isResumable: (state: S) => boolean;
  readonly resumeMsg: (now: number) => M;
}
```

<a id="runProjection"></a>

### `runProjection`

```ts
function runProjection<Model, Msg extends { type: string }, View>(
  projection: Projection<Model, Msg, View>,
  startOffset?: number,
): ProjectionRunner<Model, Msg, View>
```

<a id="runStepLoop"></a>

### `runStepLoop`

```ts
function runStepLoop<R, I, O>(
  token: string,
  runId: string,
  transport: StepTransport<R, I, O>,
  execute: ExecuteStep<I, R>,
  config: RunStepLoopConfig,
): Promise<StepLoopOutcome<O>>
```

<a id="RunStepLoopConfig"></a>

### `RunStepLoopConfig`

```ts
interface RunStepLoopConfig {
  readonly deadlineMs: number;
  readonly now?: () => number;
  readonly retry?: RetryPolicy;
  readonly rng?: Rng;
  readonly sleep?: (ms: number) => Promise<void>;
}
```

<a id="sseFromAgentEvents"></a>

### `sseFromAgentEvents`

```ts
function sseFromAgentEvents<R, Frame>(
  runtime: {
    on<
      K extends "BrainStarted" | "TurnSettled" | "ToolStarted" | "ToolSettled" | "ToolFailed" | "RunDone",
    >(
      type: K,
      handler: (
        event: Extract<AgentEventHead & {
          readonly model: string | null;
          readonly payload: unknown;
          readonly purpose: string;
          readonly turn: number;
          readonly type: "BrainStarted";
        }, { type: K }> | Extract<AgentEventHead & {
          readonly turn: AgentTurn;
          readonly type: "TurnSettled";
          readonly usage?: TurnUsage;
        }, { type: K }> | Extract<AgentEventHead & {
          readonly args: Readonly<Record<string, unknown>>;
          readonly callId: string;
          readonly name: string;
          readonly type: "ToolStarted";
        }, { type: K }> | Extract<AgentEventHead & {
          readonly callId: string;
          readonly failure: ToolFailure;
          readonly name: string;
          readonly type: "ToolFailed";
        }, { type: K }> | Extract<AgentEventHead & {
          readonly status: AgentEndedStatus;
          readonly type: "RunDone";
        }, { type: K }> | Extract<AgentEventHead & {
          readonly callId: string;
          readonly result: R;
          readonly type: "ToolSettled";
        }, { type: K }>,
      ) => void,
    ): () => void;
  },
  hub: SseHub<Frame>,
  toFrame: (event: AgentEvent<R>) => Frame | null,
): () => void
```

<a id="sseHub"></a>

### `sseHub`

```ts
function sseHub<E>(): SseHub<E>
```

<a id="SseHub"></a>

### `SseHub`

```ts
interface SseHub<E> {
  emit(event: E): void;
  open(): Response;
  register(sink: (event: E) => void): () => void;
}
```

<a id="sseProjection"></a>

### `sseProjection`

```ts
function sseProjection<Model, Msg extends { type: string }, E>(
  hub: SseHub<E>,
  toEvent: (msg: Msg | null, model: Model) => E | null,
  id?: { key?: string; name?: string },
): Projection<Model, Msg, E | null>
```

<a id="StepCtx"></a>

### `StepCtx`

```ts
interface StepCtx {
  readonly storage: AlarmStorage;
}
```

<a id="StepEngine"></a>

### `StepEngine`

```ts
interface StepEngine<R, I, O> {
  nextStep(runId: string): NextStep<I> | Promise<NextStep<I> | null> | null;
  resume(runId: string, posted: StepResult<R>): void | Promise<void>;
  terminalOutput(runId: string): O | Promise<O>;
  tokenFor(runId: string): string | Promise<string | null> | null;
}
```

<a id="stepHost"></a>

### `stepHost`

```ts
function stepHost<R, I, O>(
  ctx: StepCtx,
  engine: StepEngine<R, I, O>,
  config: DeferStepHostConfig<R>,
): {
  handle(request: StepRequest<R>, now: number): Promise<DeferredStepOutcome<I, O>>;
}
function stepHost<R, I, O>(
  ctx: StepCtx,
  engine: StepEngine<R, I, O>,
  config?: StepHostConfig,
): {
  handle(request: StepRequest<R>, now: number): Promise<StepOutcome<I, O>>;
}
```

<a id="StepHostConfig"></a>

### `StepHostConfig`

```ts
interface StepHostConfig {
  readonly giveUpAfterMs?: number;
}
```

<a id="StepLoopOutcome"></a>

### `StepLoopOutcome`

```ts
type StepLoopOutcome<O> =
  | { readonly kind: "done"; readonly output: O }
  | { readonly kind: "deadline_exceeded" }
  | {
    readonly error: unknown;
    readonly kind: "gave_up";
  }
```

<a id="StepOutcome"></a>

### `StepOutcome`

```ts
type StepOutcome<I, O> =
  | {
    readonly body: StepResponse<I, O>;
    readonly status: 200;
  }
  | {
    readonly body: { readonly error: string };
    readonly status: 401 | 404;
  }
```

<a id="StepRequest"></a>

### `StepRequest`

```ts
interface StepRequest<R> {
  readonly posted: StepResult<R> | null;
  readonly runId: string;
  readonly token: string;
}
```

<a id="StepResponse"></a>

### `StepResponse`

```ts
type StepResponse<I, O> =
  | {
    readonly done: false;
    readonly step: NextStep<I>;
  }
  | { readonly done: true; readonly output: O }
```

<a id="StepResult"></a>

### `StepResult`

```ts
interface StepResult<R> {
  readonly callId: string;
  readonly result: R;
}
```

<a id="StepTransport"></a>

### `StepTransport`

```ts
type StepTransport<R, I, O> = (request: StepRequest<R>) => Promise<DeferredStepResponse<I, O>>
```

<a id="StepWorking"></a>

### `StepWorking`

```ts
interface StepWorking {
  readonly done: false;
  readonly retryAfterMs?: number;
  readonly working: true;
}
```

<a id="survivingEffects"></a>

### `survivingEffects`

```ts
function survivingEffects<E>(
  ledger: PendingEffectsLedger<E>,
): readonly OwedEffect<E>[]
```

<a id="WS_READY_STATE_OPEN"></a>

### `WS_READY_STATE_OPEN`

```ts
const WS_READY_STATE_OPEN: 1
```
