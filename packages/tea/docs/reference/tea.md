# @demlik/tea

> TEA-faithful state machine substrate.

Tier: `stable`

```ts
import { … } from "@demlik/tea";
```

## Exports (157)

| Symbol | Kind | Tier | Summary |
| --- | --- | --- | --- |
| [`absurd`](#absurd) | Function | stable | Compile-time exhaustiveness assertion for default branches of switches over discriminated unions narrowed by hand (Sub handlers, message-bridge dispatchers, port fanouts) — TS narrows the operand to `never` only if every variant is covered, so adding one produces a compile error at the `absurd(x)` site. |
| [`acceptedTypes`](#acceptedTypes) | Function | stable | The Msg types this machine would accept in this state — the same set a `NoCellError` reports, asked before anything is dispatched. |
| [`acceptsOf`](#acceptsOf) | Function | stable | List the Msg types a machine accepts in the state named `stateType`. |
| [`ack`](#ack) | Function | stable | Construct an `Ack` for a last-applied sequence number. |
| [`Ack`](#Ack) | Interface | stable | The authoritative side's acknowledgement: the highest `seq` it has applied. |
| [`AckPartition`](#AckPartition) | Interface | stable | The result of splitting a seq-tagged buffer against an ack. |
| [`AnyCmdDef`](#AnyCmdDef) | Type | stable | The declaration-erased view the runtime reads: which `type` a def builds, which two Msg types it settles with, the `ok` schema the edge parses against and the tags an `Err` may carry. |
| [`applyCell`](#applyCell) | Function | stable | Run the one update cell that matches `state` and `msg` and return its `[nextState, cmds]`. |
| [`applyCellChecked`](#applyCellChecked) | Function | stable | `applyCell` with the development-mode checks that catch an impure cell: the input state is frozen and the result is asserted to be plain data. |
| [`asReducer`](#asReducer) | Function | stable | Type-check a standalone reducer record and return it branded. |
| [`AsyncSchemaError`](#AsyncSchemaError) | Class | stable | A schema whose `validate` returned a Promise where the kernel needs an answer now — the `ok` check at the interpret edge, the `args` check in a reducer. |
| [`BootedRunHandle`](#BootedRunHandle) | Interface | stable | A RunHandle whose boot has completed, so its State exists. |
| [`BootingRuntime`](#BootingRuntime) | Interface | stable | What the Promise engine's `run` returns, the instant it is called, while boot is still in flight: its RunHandle, widened with Ports and `dispatchOnce`. |
| [`Branded`](#Branded) | Type | stable | A `Reducer` or `Transitions` value that went through `asReducer` or `defineMachine`. |
| [`BuiltinSub`](#BuiltinSub) | Type | stable | The built-in Subs a machine over `M` may declare without declaring them. |
| [`BuiltinSubType`](#BuiltinSubType) | Type | stable | The Sub types every engine ships a runner for. |
| [`CancelTimer`](#CancelTimer) | Type | stable | Cancels a scheduled reconnect timer (the inverse of `schedule`). |
| [`Cmd`](#Cmd) | Type | stable | A tagged-union, one-shot effect — JSON-plain, hashable, replayable. |
| [`Cmd`](#Cmd) | Variable | stable | The helpers for building Cmds: `Cmd.define` declares a typed Cmd constructor, and `Cmd.none`, `Cmd.batch`, `Cmd.when` and `Cmd.whenDefined` build the Cmd list an update cell returns. |
| [`CmdDef`](#CmdDef) | Interface | stable | What `Cmd.define` returns: the Cmd builder itself (`fetch({ url })`), with the minted Msg builders and the declaration hung on it. |
| [`CmdInput`](#CmdInput) | Type | stable | The payload a constructor accepts: a plain record spread beside `type`. |
| [`CmdOf`](#CmdOf) | Type | stable | The Cmd value a def (or a union of defs) builds. |
| [`CmdValue`](#CmdValue) | Type | stable | The value `Cmd.define("fetch", …)` builds: `{ type: "fetch", ...input }`. |
| [`CtxArg`](#CtxArg) | Type | stable | The `ctx` field of an engine's options: optional when the machine's `Ctx` is empty, required otherwise. |
| [`DeclaredErrorsOf`](#DeclaredErrorsOf) | Type | stable | The failures a `Cmd.define`d Cmd's handler may return: its declared tags. |
| [`defineListener`](#defineListener) | Function | stable | Build a listener-backed Sub factory whose cleanup is mandatory and derived. |
| [`defineMachine`](#defineMachine) | Function | stable | Define a machine: its `init`, its `update` (a reducer or a transitions table), and optionally its `subs`, `cmds` and `identity`. |
| [`defineManagedResource`](#defineManagedResource) | Function | stable | Build the battery. |
| [`DefineManagedResourceOpts`](#DefineManagedResourceOpts) | Interface | stable | Options for `defineManagedResource`: the resource's `name`, how to `acquire` it for a key, and how to `release` the handle. |
| [`definePort`](#definePort) | Function | stable | Define a typed port. |
| [`DeletableStore`](#DeletableStore) | Interface | stable | A `Store<S>` that can remove what it saved — how a host forgets a run. |
| [`DepKeyedSub`](#DepKeyedSub) | Type | stable | One entry of a machine's `subs`: a Sub `type` plus `deps(state)`, which returns the data the runner needs, or `null` to keep the Sub off. |
| [`describeMachine`](#describeMachine) | Function | stable | Describe a machine's update table as data: its form, its Msg types, and the per-state accept sets of a transitions machine. |
| [`detectUpdateForm`](#detectUpdateForm) | Function | stable | Work out an `update` record's `UpdateForm` from its shape. |
| [`DispatchDiscardedError`](#DispatchDiscardedError) | Class | stable | The rejection of a dispatch that arrived DURING `stop()`'s drain — an in-flight interpret handler's follow-up Msg, a detached handler's terminal Msg, or a Sub that is still live because subs are torn down only after the drain. |
| [`DispatchSettle`](#DispatchSettle) | Type | stable | How long a `dispatch` waits before it resolves: `quiescent`, the default, waits for every follow-up Msg to drain, and `once` waits for the single transition. |
| [`Dispose`](#Dispose) | Type | stable | The cleanup function a Sub runner returns. |
| [`DisposeTimeoutNotice`](#DisposeTimeoutNotice) | Class | stable | Reported to the `OnError` sink under `phase: "discard"` when `stop()`'s wait for async teardown work hits `disposeTimeoutMs`. |
| [`DriveFailedError`](#DriveFailedError) | Class | stable | Raised by `driveToDone` when the drive ends on a State its `failed` predicate marks as a failure. |
| [`DriveStalledError`](#DriveStalledError) | Class | stable | Raised by `driveToDone` when `start`'s follow-up chain quiesces on a State that is neither terminal nor `failed` AND nothing in the runtime can still transition it — no live Sub, no in-flight Cmd. |
| [`EngineRun`](#EngineRun) | Type | stable | An engine's `run`, seen from a host adapter: a machine and its RunOptions in, a RunHandle out. |
| [`ErrOf`](#ErrOf) | Type | stable | The DECLARED failure union a def's handler may settle with. |
| [`ErrorsOf`](#ErrorsOf) | Type | stable | The `E` union one Cmd can settle with; `unknown` for an untyped Cmd. |
| [`EventSourceFactoryOpts`](#EventSourceFactoryOpts) | Interface | stable | Options for `fromEventSource`: map each server-sent message, error and open event to a Msg, or to `null` to drop it. |
| [`ExhaustiveTransitions`](#ExhaustiveTransitions) | Type | stable | `Transitions<S, M, C>` with every cell REQUIRED — the opt-in floor for a machine that wants the compiler to force a decision on every (state, message) pair. |
| [`FencedRead`](#FencedRead) | Interface | stable | What a fenced store's `loadFenced` returns: the raw saved value and the version it was written at. |
| [`FencedStore`](#FencedStore) | Interface | stable | A `Store<S>` that can refuse a second live writer. |
| [`foldMsgs`](#foldMsgs) | Function | stable | Fold a machine's `update` over a list of Msgs from a base state and return only the final state. |
| [`FoldRefusal`](#FoldRefusal) | Interface | stable | The refusal `tryFoldMsgs` reports: WHICH msg in the log had no handler, where. |
| [`foldUpdates`](#foldUpdates) | Function | stable | Fold a machine's `update` over a list of Msgs from a starting state, and return the final state with every Cmd the cells emitted. |
| [`formOf`](#formOf) | Function | stable | Read a machine's `UpdateForm`. |
| [`fromBroadcastChannel`](#fromBroadcastChannel) | Function | stable | Build a Sub runner that listens on the `BroadcastChannel` named by `sub.deps.channelName` and dispatches `msgFn(event, sub)` for each message. |
| [`fromEventSource`](#fromEventSource) | Function | stable | Build a Sub runner that opens an `EventSource` on `sub.deps.url` and dispatches a Msg for each server-sent event. |
| [`fromEventTarget`](#fromEventTarget) | Function | stable | Build a Sub runner that listens for `eventName` on a DOM-style event target and dispatches `msgFn(event, sub)` for each event. |
| [`fromInterval`](#fromInterval) | Function | stable | Build a Sub runner that dispatches `msgFn(sub)` every `sub.deps.intervalMs` milliseconds while the Sub is on. |
| [`fromPort`](#fromPort) | Function | stable | Build a Sub runner that listens to a `Port` on another runtime and dispatches `msgFn(value, sub)` for each value emitted. |
| [`fromReconnectingWebSocket`](#fromReconnectingWebSocket) | Function | stable | Build a Sub runner that keeps a WebSocket to `sub.deps.wsUrl` open, reconnecting with backoff when it drops. |
| [`fromTimeout`](#fromTimeout) | Function | stable | Build a Sub runner that dispatches `msgFn(sub)` once, `sub.deps.delayMs` milliseconds after the Sub turns on. |
| [`fromTransport`](#fromTransport) | Function | stable | Build the battery. |
| [`FromTransportOpts`](#FromTransportOpts) | Interface | stable | Options for `fromTransport`: the seam's `name`, how to open the transport, and how inbound values, outbound values and a dropped connection map to and from Msgs. |
| [`fromWebSocket`](#fromWebSocket) | Function | stable | Build a Sub runner that opens a WebSocket to `sub.deps.wsUrl` and dispatches a Msg for each socket event. |
| [`historyTracker`](#historyTracker) | Function | stable | Create a bounded history tracker over a Runtime. |
| [`HistoryTracker`](#HistoryTracker) | Interface | stable | A bounded log of a runtime's recent `(msg, state)` transitions, returned by `historyTracker`. |
| [`Identity`](#Identity) | Interface | stable | A machine's optional message filter: `ofState` names the identity this instance owns, and `ofMsg` the identity a Msg is addressed to. |
| [`IdentityDropNotice`](#IdentityDropNotice) | Class | stable | Reported to the `OnError` sink under `phase: "identity-drop"` when the `Identity` filter drops a message addressed to a different instance. |
| [`initAck`](#initAck) | Function | stable | The `Ack` for a server that has applied nothing yet — `ack(NO_ACK)`. |
| [`Interpret`](#Interpret) | Type | stable | The Cmd handler table an engine is handed: one async handler per Cmd type. |
| [`InterpretArg`](#InterpretArg) | Type | stable | The `interpret` option of an engine's `run`: optional for a machine that emits no Cmd, required — one handler per Cmd variant — for one that does. |
| [`InterpretCell`](#InterpretCell) | Type | stable | One cell of Interpret: the outcome-returning form for a `Cmd.define`d Cmd, the form returning a Msg, a list of Msgs or nothing for a hand-written one. |
| [`InterpretDetached`](#InterpretDetached) | Type | stable | A Cmd handler that reports back through a `dispatch` limited to the Msgs it is allowed to send. |
| [`isFencedStore`](#isFencedStore) | Function | stable | Narrow a `Store<S>` to a FencedStore — what `run` uses to decide. |
| [`liftSlice`](#liftSlice) | Function | stable | Lift a battery verb's result into the host state that carries its slice. |
| [`ListenerTarget`](#ListenerTarget) | Interface | stable | The imperative listener target, expressed as the `add`/`remove` pair the substrate pairs into a reconciled resource. |
| [`Machine`](#Machine) | Type | stable | A machine as plain data: `init`, `update`, and optionally `subs`, `cmds` and `identity`. |
| [`MachineShape`](#MachineShape) | Type | stable | What `describeMachine` returns: the Msg types a machine handles and, for a transitions machine, its states and the Msg types each one accepts. |
| [`MachineTypes`](#MachineTypes) | Type | stable | The `types` option: the slots of a machine's shape that no value in the object can imply, declared once as phantom values (`{} as Model`). |
| [`MalformedResult`](#MalformedResult) | Type | stable | The kernel-minted failure: a handler returned an `Ok` value the Cmd's `ok` schema rejects. |
| [`ManagedResourceBattery`](#ManagedResourceBattery) | Interface | stable | What the battery returns: a `.depKeyed(when)` entry for the machine's `subs`, the `.subscribe` runner for the `subscribe` table handed to `run`, and a `.get(key)` accessor so Cmd handlers can reach the live Handle while the resource is held. |
| [`ManagedResourceSub`](#ManagedResourceSub) | Type | stable | The running Sub of a managed resource named `N`: its `deps` is the lifetime key. |
| [`Migrated`](#Migrated) | Type | stable | What `Store.migrate` answers: the parsed `S`, `null` when nothing was saved, or a Refusal for saved bytes it cannot read. |
| [`msgKeysOf`](#msgKeysOf) | Function | stable | List every Msg type a machine has an update cell for, across all of its states. |
| [`nextSeq`](#nextSeq) | Function | stable | The next sequence number to assign: one past the highest `seq` in the buffer, or `0` for an empty buffer. |
| [`NO_ACK`](#NO_ACK) | Variable | stable | The "nothing applied yet" cursor — the ack value for a server that has applied no client input at all. |
| [`NoCellError`](#NoCellError) | Class | stable | Thrown when a Msg is dispatched to a state that has no update cell for it. |
| [`NoCtx`](#NoCtx) | Type | stable | The `Ctx` of a machine whose handlers read nothing from context. |
| [`noop`](#noop) | Function | stable | An update cell that ignores its Msg: it returns the state unchanged, with no Cmds. |
| [`OkOf`](#OkOf) | Type | stable | The `Ok` a def's handler must produce. |
| [`OkOfCmd`](#OkOfCmd) | Type | stable | The value a Cmd settles with; `unknown` for a hand-written Cmd. |
| [`OnError`](#OnError) | Type | stable | Sink for runtime failures that have no caller to reject at. |
| [`Outcome`](#Outcome) | Type | stable | The result a `Cmd.define`d handler returns: its value, or a declared failure. |
| [`Outcome`](#Outcome) | Variable | stable | Build an Outcome outside a handler's helpers — in a test that calls a handler directly, or in an adapter converting another result type. |
| [`OutcomeContractError`](#OutcomeContractError) | Class | stable | A `Cmd.define`d handler returned something the engine cannot settle: any Msg (the engine mints the Cmd's `<name>_ok` / `<name>_err`, never the handler — ADR 0021), or any other value that is neither an Outcome nor nothing. |
| [`OutcomeHelpers`](#OutcomeHelpers) | Interface | stable | The two builders the Promise engine hands a `Cmd.define`d handler on its ctx: `ok(value)` and `err({ _tag })`, with `err` typed to the def's declared tags. |
| [`partitionByAck`](#partitionByAck) | Function | stable | Partition a buffer of seq-tagged commands into ACKED and PENDING against the authoritative `lastAppliedSeq`. |
| [`Port`](#Port) | Interface | stable | A named, typed channel for values leaving the runtime. |
| [`PortEmitter`](#PortEmitter) | Interface | stable | Augmentation injected onto `ctx` inside Cmd handlers. |
| [`PortNameCollisionError`](#PortNameCollisionError) | Class | stable | Thrown by `definePort` when a name has already been registered in the current process. |
| [`QuiescenceTimeoutError`](#QuiescenceTimeoutError) | Class | stable | Raised by `idle()` when the quiescence wait hits its iteration cap without the dispatch tail stabilizing — `idle()` REJECTS rather than silently resolving, so a livelocking machine surfaces instead of masquerading as quiescent. |
| [`readInOrder`](#readInOrder) | Function | stable | Run a composed read through `order` and return the first answer any step gives, or `absent` when every one defers. |
| [`ReadStep`](#ReadStep) | Interface | stable | One step of a composed read: the slice it consults, under the name that slice goes by. |
| [`reconcile`](#reconcile) | Function | stable | The client prediction/reconciliation helper — the Gambetta/Valve authoritative-server loop's reconcile step, generalized. |
| [`ReconnectingWebSocketFactoryOpts`](#ReconnectingWebSocketFactoryOpts) | Interface | stable | Options for `fromReconnectingWebSocket`: the event-to-Msg mappers, the backoff settings, and an injectable `connect` and `schedule` for tests. |
| [`Reducer`](#Reducer) | Type | stable | The flat form of `update`: a record with one handler per Msg type, each returning `[nextState, cmds]`. |
| [`Refusal`](#Refusal) | Class | stable | `migrate`'s answer for saved bytes it cannot read. |
| [`refuse`](#refuse) | Function | stable | Refuse saved bytes from `Store.migrate`. |
| [`replay`](#replay) | Function | stable | Run a machine's `init` and then its `update` over a list of Msgs, with no engine, store or effects. |
| [`RunHandle`](#RunHandle) | Interface | stable | A running machine's handle: queue a Msg, listen, wait for boot, stop. |
| [`RunHandlers`](#RunHandlers) | Type | stable | The handlers an engine is handed beside a machine: the InterpretArg Cmd handlers and the SubscribeArg sub runners. |
| [`RunOptions`](#RunOptions) | Type | stable | The options every engine's `run` accepts: the `ctx`, the handlers the machine runs under, an optional `store`, and the `events` projector that feeds `on`. |
| [`Runtime`](#Runtime) | Interface | stable | The Promise engine's booted handle — what BootingRuntime's `ready` resolves to once boot completes. |
| [`RuntimeDiscardedError`](#RuntimeDiscardedError) | Class | stable | Reported to the `OnError` sink under `phase: "discard"` when `stop()` is called while `interpret` handlers are still awaiting. |
| [`RuntimeDiscardNotice`](#RuntimeDiscardNotice) | Class | stable | Base of the LOSSY-BUT-LEGAL teardown facts: work the host discarded by letting go of a runtime that still had something outstanding. |
| [`RuntimeErrorContext`](#RuntimeErrorContext) | Interface | stable | Context handed to an `OnError` sink alongside the error itself. |
| [`RuntimeErrorPhase`](#RuntimeErrorPhase) | Type | stable | Which otherwise-unattributable runtime path produced an error. |
| [`RuntimeRef`](#RuntimeRef) | Interface | stable | The dispatch-only view of a runtime. |
| [`Schema`](#Schema) | Interface | stable | The minimal validator shape `schemaMigrate` accepts: an object with `safeParse`. |
| [`schemaMigrate`](#schemaMigrate) | Function | stable | Build a `Store.migrate` from a schema (job 1) and an optional thin `upcast` (job 2). |
| [`Seq`](#Seq) | Type | stable | A monotonic, non-negative sequence number tagging one client-predicted command. |
| [`SeqTagged`](#SeqTagged) | Interface | stable | A command (or `Msg`) tagged with the `seq` the client assigned it. |
| [`Settled`](#Settled) | Type | stable | The settled-Msg union a def (or a union of defs) mints: `<name>_ok` carrying `value`, `<name>_err` carrying `error`. |
| [`SettledErr`](#SettledErr) | Type | stable | The Msg the engine mints when a `Cmd.define`d Cmd's handler fails: `<name>_err`, carrying the Cmd and the tagged error. |
| [`SettledOk`](#SettledOk) | Type | stable | The Msg the engine mints when a `Cmd.define`d Cmd's handler succeeds: `<name>_ok`, carrying the Cmd and its value. |
| [`Store`](#Store) | Interface | stable | Where an engine loads and saves a machine's state. |
| [`StoreConflictError`](#StoreConflictError) | Class | stable | Thrown when a fenced save finds a version other than the one it expected — another live writer has this run. |
| [`StoreRefusedError`](#StoreRefusedError) | Class | stable | `ready` rejects with this when the saved state could not be restored: `migrate` returned refuse, or `load` / `migrate` threw (that throw is the `cause`). |
| [`structuralHash`](#structuralHash) | Function | stable | Turn a plain-data value into a stable string that does not depend on object key order. |
| [`Sub`](#Sub) | Type | stable | A running subscription as its runner sees it: its `type`, the `deps` value the machine's `subs` entry returned, and an `id` derived from both. |
| [`subId`](#subId) | Function | stable | Construct a `SubId` from a string. |
| [`SubId`](#SubId) | Type | stable | The branded string that identifies a running Sub. |
| [`subIdOf`](#subIdOf) | Function | stable | The one `id` of a Sub: a structural hash of its `type` and its `deps` value. |
| [`Subscribe`](#Subscribe) | Type | stable | The Sub runner table an engine is handed: one runner per Sub type. |
| [`SubscribeArg`](#SubscribeArg) | Type | stable | The `subscribe` option of an engine's `run`: one runner per Sub type the machine declares, except the built-ins (`timer`) the engine already ships. |
| [`SubscribeHandler`](#SubscribeHandler) | Type | stable | A Sub runner: given the Sub, the `ctx` and a `dispatch`, it opens the resource and returns a `Dispose`. |
| [`Supervision`](#Supervision) | Type | stable | Declared supervision policy for a reducer (`update`) throw, at `run(machine, { supervision })`. |
| [`SupervisionStrategy`](#SupervisionStrategy) | Type | stable | The three declared reducer-throw supervision strategies. |
| [`SyncReturn`](#SyncReturn) | Type | stable | What an update cell returns: the `[nextState, cmds]` tuple, typed so that a Promise cannot stand in for it. |
| [`Tagged`](#Tagged) | Type | stable | The shape every settled failure has (ADR 0011): a plain `_tag` record. |
| [`TaggedError`](#TaggedError) | Type | stable | One declared failure per tag. |
| [`tagSeq`](#tagSeq) | Function | stable | Tag a command/`Msg` with its sequence number. |
| [`TelemetryEvent`](#TelemetryEvent) | Interface | stable | What the `telemetry` sink passed to `run` receives, once per APPLIED transition. |
| [`TelemetrySink`](#TelemetrySink) | Type | stable | The `telemetry` option of `run`: a fire-and-forget sink. |
| [`TimerDeps`](#TimerDeps) | Type | stable | The `deps` a `timer` Sub declares: fire `msg` once, `ms` after it starts. |
| [`TimerSub`](#TimerSub) | Type | stable | The built-in `timer` Sub, as its runner sees it. |
| [`Transitions`](#Transitions) | Type | stable | The state × message table form of `update`. |
| [`Transport`](#Transport) | Interface | stable | Duplex transport. |
| [`TransportBattery`](#TransportBattery) | Interface | stable | What the battery returns: a `.depKeyed(when)` entry for the machine's `subs`, the `.subscribe` runner for the `subscribe` table handed to `run`, and a `send(key, outbound)` helper the consumer's Cmd handler calls. |
| [`TransportFactory`](#TransportFactory) | Type | stable | Factory the consumer wires to a platform-specific transport. |
| [`TransportSub`](#TransportSub) | Type | stable | The running Sub of a seam named `N`: its `deps` is the seam key. |
| [`tryApplyCell`](#tryApplyCell) | Function | stable | `applyCell`, with "no handler for this Msg" moved into the return type instead of a throw. |
| [`tryFoldMsgs`](#tryFoldMsgs) | Function | stable | `foldMsgs`, with the "no handler for this Msg" case in the return type, INCLUDING which message failed. |
| [`tryInterpret`](#tryInterpret) | Function | stable | Wrap a function that may throw into a Cmd handler that never rejects: success maps to one Msg through `onOk`, failure to another through `onErr`. |
| [`UndeclaredFailureError`](#UndeclaredFailureError) | Class | stable | A `Cmd.define`d handler failed outside its declared channel: its `Err` carried no `_tag`, or a tag the def does not declare. |
| [`UpdateForm`](#UpdateForm) | Type | stable | Which of the two shapes a machine's `update` takes: a flat `reducer` keyed by Msg type, or a `transitions` table keyed by state type and then Msg type. |
| [`WebSocketFactoryOpts`](#WebSocketFactoryOpts) | Interface | stable | Options for `fromWebSocket`: map each message, open, error and close event to a Msg, or to `null` to drop it. |
| [`WebSocketSubData`](#WebSocketSubData) | Type | stable | The `deps` a WebSocket Sub carries: the `wsUrl` to connect to. |
| [`Wired`](#Wired) | Type | stable | A machine beside the handlers it runs under — what a wrapper, a battery's `toMachine` or an agent host hands around, and what an engine takes apart: `run(wired.machine, { ...wired, ctx })`. |
| [`wrapDetached`](#wrapDetached) | Function | stable | Adapt an `InterpretDetached` handler into an ordinary `interpret` cell. |

## Declarations

<a id="absurd"></a>

### `absurd`

```ts
function absurd(x: never): never
```

<a id="acceptedTypes"></a>

### `acceptedTypes`

```ts
function acceptedTypes<S>(
  machine: { __form?: UpdateForm; update: object },
  state: S,
): readonly string[]
```

<a id="acceptsOf"></a>

### `acceptsOf`

```ts
function acceptsOf(
  machine: { __form?: UpdateForm; update: object },
  stateType: string,
): readonly string[]
```

<a id="ack"></a>

### `ack`

```ts
function ack(lastAppliedSeq: number): Ack
```

<a id="Ack"></a>

### `Ack`

```ts
interface Ack {
  readonly lastAppliedSeq: number;
}
```

<a id="AckPartition"></a>

### `AckPartition`

```ts
interface AckPartition<T> {
  /** Inputs the authoritative side has applied (`seq <= lastAppliedSeq`). */
  readonly acked: readonly SeqTagged<T>[];
  /** Inputs still in flight / un-acked (`seq > lastAppliedSeq`) — the replay tail. */
  readonly pending: readonly SeqTagged<T>[];
}
```

<a id="AnyCmdDef"></a>

### `AnyCmdDef`

```ts
type AnyCmdDef = {
  readonly cmdType: string;
  readonly errTags: ReadonlyArray<string>;
  readonly errType: string;
  readonly okType: string;
  readonly schema: { readonly ok: StandardSchemaV1 };
}
```

<a id="applyCell"></a>

### `applyCell`

```ts
function applyCell<
  S,
  M extends { type: string },
  C extends Cmd<string, unknown, unknown>,
>(
  machine: { __form?: UpdateForm; update: object },
  state: S,
  msg: M,
): readonly [S, readonly C[]]
```

<a id="applyCellChecked"></a>

### `applyCellChecked`

```ts
function applyCellChecked<
  S,
  M extends { type: string },
  C extends Cmd<string, unknown, unknown>,
>(
  machine: { __form?: UpdateForm; update: object },
  state: S,
  msg: M,
): readonly [S, readonly C[]]
```

<a id="asReducer"></a>

### `asReducer`

```ts
function asReducer<S, M extends { type: string }, C extends Cmd>(
  reducer: Reducer<S, M, C>,
): Branded<Reducer<S, M, C>>
```

<a id="AsyncSchemaError"></a>

### `AsyncSchemaError`

```ts
class AsyncSchemaError extends Error {
  constructor(where: string);
  readonly _tag: "AsyncSchemaError";
  readonly name: "AsyncSchemaError";
  /** What the schema was checking, e.g. `the "fetch" Cmd's ok schema`. */
  readonly where: string;
}
```

<a id="BootedRunHandle"></a>

### `BootedRunHandle`

```ts
interface BootedRunHandle<S, M extends { type: string }, E extends { type: string } = never> extends RunHandle<S, M, E> {
  /** Resolves to the booted handle once boot completes. */
  readonly ready: Promise<BootedRunHandle<S, M, E>>;
  /** The current State. Total. */
  getState(): S;
}
```

<a id="BootingRuntime"></a>

### `BootingRuntime`

```ts
interface BootingRuntime<S, M extends { type: string }, E extends { type: string } = never> extends RuntimeRef<M>, RunHandle<S, M, E> {
  /**
   * Resolves to the booted `Runtime<S, M>` after boot completes (or rejects with
   * the boot error). This is the ONLY way to obtain a `Runtime` — and a
   * `Runtime` is the only handle whose `getState()` is total. Awaiting `ready` is
   * the single gate between "boot in flight" and "State exists":
   *
   * ```ts
   * const runtime = await run(machine, opts).ready;
   * runtime.getState(); // total — never throws-before-boot
   * ```
   *
   * Idempotent — the same settled promise, resolving to the same `Runtime`, comes
   * back on every read. Expresses canon §2.3 (boot is a named, awaitable moment).
   */
  ready: Promise<Runtime<S, M, E>>;
  /**
   * Put a Msg in the runtime's inbox and resolve once processed. Runs to
   * QUIESCENCE by default: settles only after the dispatched Msg AND every
   * transitive interpret follow-up has drained. Pass `{ settle: "once" }` (or
   * call `dispatchOnce`) for the single-step case.
   *
   * Rejection ordering: the ONE dispatched transition's own failure surfaces
   * first, here. If it succeeds but the follow-up chain never stabilizes, the
   * quiescent drain rejects with `QuiescenceTimeoutError`. Follow-up Msg
   * rejections themselves route to the `onError` sink, never here.
   */
  dispatch(msg: M, opts?: { readonly settle?: DispatchSettle }): Promise<void>;
  /**
   * Dispatch `msg` and resolve after exactly ONE transition's effects settle,
   * WITHOUT draining the follow-up chain — equivalent to
   * `dispatch(msg, { settle: "once" })`. Prefer plain `dispatch` unless you will
   * `await runtime.idle()` yourself; the un-awaited follow-up chain is the
   * footgun the quiescent default removed.
   */
  dispatchOnce(msg: M): Promise<void>;
  /**
   * Emit a value on a Port from OUTSIDE an interpret handler — same synchronous
   * fanout as `ctx.emit`. The canonical use is `observe`-driven emission (one
   * runtime publishing a state-derived signal another subscribes to via
   * `subscribePort`) without spawning a "tell the outside world" Cmd per
   * transition.
   */
  emitPort<T>(port: Port<T>, value: T): void;
  /**
   * Register a `(msg, state)` trace hook, fired for every applied transition
   * with the fold's committed State. A `dispatch` issued from the observer is
   * SCHEDULED onto the serial tail behind the fold that fired it, never folded
   * re-entrantly and never discarded, so it needs no `setTimeout(fn, 0)`
   * deferral; two listeners issuing in order fold in that order.
   */
  observe(observer: (msg: M, state: S) => void): () => void;
  /**
   * Subscribe to a SEMANTIC event of `type`. The handler receives exactly the
   * `E` member whose `type` matches `K`, so a consumer never touches another
   * event's shape and never references the machine's PRIVATE Msg names. Multiple
   * handlers per type; fanout is synchronous and throw-isolated. Fires only when
   * the machine's `events` projector (wired on `run`) emits that type.
   */
  on<K extends string>(
    type: K,
    handler: (event: Extract<E, { type: K }>) => void,
  ): () => void;
  /**
   * Subscribe to the INITIAL State — the boot transition. Fires exactly once:
   * immediately if boot already completed (so a late subscriber never misses
   * it), otherwise on the boot fanout. Returns a cleanup (a no-op once fired).
   */
  onBoot(handler: (state: S) => void): () => void;
  /** Stop the run; resolves once the engine has torn it down. */
  stop(): Promise<void>;
  /**
   * Register a zero-arg change notifier, fired for every applied transition
   * with the fold's State already committed — `getState()` inside the listener
   * reads it, not the State before. A `dispatch` issued from the listener is
   * SCHEDULED onto the serial tail behind the fold that fired it, never folded
   * re-entrantly and never discarded, so it needs no `setTimeout(fn, 0)`
   * deferral; two listeners issuing in order fold in that order.
   */
  subscribe(listener: () => void): () => void;
  /**
   * Subscribe to a typed Port. Multiple listeners per port; fanout is synchronous
   * and isolated. Ports are for "data leaving the runtime selectively" (see
   * `definePort`) — distinct from `observe` (every transition) and State.
   */
  subscribePort<T>(port: Port<T>, listener: (value: T) => void): () => void;
}
```

<a id="Branded"></a>

### `Branded`

```ts
type Branded<T> = T & { readonly "[ReducerBrand]": true }
```

<a id="BuiltinSub"></a>

### `BuiltinSub`

```ts
type BuiltinSub<M> = TimerSub<M>
```

<a id="BuiltinSubType"></a>

### `BuiltinSubType`

```ts
type BuiltinSubType = "timer"
```

<a id="CancelTimer"></a>

### `CancelTimer`

```ts
type CancelTimer = () => void
```

<a id="Cmd"></a>

### `Cmd`

```ts
type Cmd<T extends string = string, Ok = unknown, E = unknown> = {
  /** Phantom — the `_tag` union this Cmd can settle with. Never assigned. */
  readonly __e?: E;
  /** Phantom — the value this Cmd settles with. Never assigned. */
  readonly __ok?: Ok;
  readonly type: T;
}

const Cmd: {
  /**
   * Flat concat of cmd arrays. Use when a cell composes effects from
   * multiple conditional sources:
   *
   *   return [next, Cmd.batch(
   *     Cmd.whenDefined(state.queueItemId, (id) => ({ type: "complete", id })),
   *     Cmd.when(state.windowId !== undefined, { type: "close_window", windowId }),
   *     [{ type: "detach_debugger", tabId: state.tabId }],
   *   )];
   *
   * `<const C>` keeps inline cmd literals' discriminants narrow (same
   * rationale as `when` / `whenDefined` above).
   */
  readonly batch: <const C extends Cmd<string, unknown, unknown>>(
    ...arrs: readonly (readonly C[])[],
  ) => readonly C[];
  /**
   * Declare a typed Cmd constructor (ADR 0014, 0021). Returns the builder —
   * `fetch({ url })` yields `{ type: "fetch", url }` — carrying the minted Msg
   * builders `fetch.ok(cmd, value)` / `fetch.err(cmd, error)` (for replay
   * logs and tests) and the declaration the runtime edge parses against.
   * `Settled<typeof fetch>` is the two-arm Msg union it settles with;
   * `defineMachine({ cmds: [fetch] })` folds that union into the machine's `M`.
   *
   *   const fetch = Cmd.define("fetch", {
   *     input: z.object({ url: z.string() }),
   *     ok: z.object({ status: z.number(), body: z.string() }),
   *     err: ["not_found", "timeout"],
   *   });
   *
   * `input` and `ok` take any Standard Schema whose `validate` is synchronous:
   * zod directly, Effect Schema through `Schema.toStandardSchemaV1(...)`. `err`
   * is the `_tag` list the handler may fail with; the runtime adds
   * `malformed_result` for an `Ok` value the `ok` schema rejects.
   *
   * The handler returns an outcome and the engine mints the Msg:
   *
   *   fetch: async (cmd, { ok, err }) =>
   *     res.status === 404 ? err({ _tag: "not_found" }) : ok(await res.json()),
   *
   * A throw or an undeclared tag goes to the error sink, never to `fetch_err`.
   * The handler reads its services off the plain `ctx` handed to `run` (ADR
   * 0020).
   *
   * A Cmd must not wait; see `DepKeyedSub` for anything that watches.
   */
  readonly define: <
    const Name extends string,
    Input extends CmdInput,
    Ok,
    const Tags extends readonly string[],
  >(
    name: Name,
    spec: {
      readonly err: Tags;
      readonly input: StandardSchemaV1<unknown, Input>;
      readonly ok: StandardSchemaV1<unknown, Ok>;
    },
  ) => CmdDef<Name, Input, Ok, TaggedError<Tags[number]>>;
  /**
   * The empty Cmd array. Typed `readonly never[]` so it's assignable to any
   * `readonly C[]` for any `C extends Cmd`. Use in `init` returns and
   * Transitions cells that emit zero effects:
   *
   *   init: (loaded) => [loaded ?? initial, Cmd.none],
   *   tick: (state) => [state, Cmd.none],
   *
   * Elm's `Cmd.none` analogue. Cultural signal alongside the runtime help:
   * `[state, Cmd.none]` reads as intent ("this transition emits nothing"),
   * `[state, []]` reads as "empty array of what".
   *
   * Frozen at runtime so a downstream consumer can't `.push()` into the
   * shared reference.
   */
  readonly none: readonly never[];
  /**
   * Emit `cmd` wrapped in a single-element array iff `cond` is true.
   * Otherwise return the empty array. Spreads cleanly into the cmds array
   * returned by a Transitions cell.
   *
   * `const C` (TypeScript 5.0+) keeps the inferred `type:` discriminator
   * literal narrow when called with an object literal — so `Cmd.when(b,
   * { type: "x", ... })` infers as `{ type: "x", ... }`, not `{ type:
   * string, ... }`, and stays assignable to a discriminated-union arm
   * without `as const` at the call site.
   */
  readonly when: <const C extends Cmd<string, unknown, unknown>>(
    cond: boolean,
    cmd: C,
  ) => readonly C[];
  /**
   * If `value` is defined, call `build(value)` and emit the resulting cmd
   * wrapped in a single-element array. If `value` is `undefined`, return
   * the empty array. `value` is narrowed to `T` inside `build`.
   *
   * `const C` on the return type keeps the callback's object-literal
   * `type:` field narrow (see `when` above for the full rationale).
   */
  readonly whenDefined: <T, const C extends Cmd<string, unknown, unknown>>(
    value: T | undefined,
    build: (value: T) => C,
  ) => readonly C[];
}
```

<a id="CmdDef"></a>

### `CmdDef`

```ts
interface CmdDef<Name extends string, Input extends CmdInput, Ok, E extends Tagged> {
  (input: Input): CmdValue<Name, Input, Ok, E>;
  /** The `type` discriminant of every Cmd this builds. */
  readonly cmdType: Name;
  readonly err: (
    cmd: CmdValue<Name, Input, Ok, E>,
    error: E,
    at?: number,
  ) => SettledErr<Name, CmdValue<Name, Input, Ok, E>, E>;
  /** The declared `_tag` list, verbatim. */
  readonly errTags: readonly E["_tag"][];
  readonly errType: `${Name}_err`;
  readonly ok: (
    cmd: CmdValue<Name, Input, Ok, E>,
    value: Ok,
    at?: number,
  ) => SettledOk<Name, CmdValue<Name, Input, Ok, E>, Ok>;
  readonly okType: `${Name}_ok`;
  readonly schema: {
    readonly input: StandardSchemaV1<unknown, Input>;
    readonly ok: StandardSchemaV1<unknown, Ok>;
  };
}
```

<a id="CmdInput"></a>

### `CmdInput`

```ts
type CmdInput = { readonly type?: never } & Record<string, unknown>
```

<a id="CmdOf"></a>

### `CmdOf`

```ts
type CmdOf<D extends AnyCmdDef> = D extends ((input: never) => infer C extends Cmd) ? C : never
```

<a id="CmdValue"></a>

### `CmdValue`

```ts
type CmdValue<Name extends string, Input extends CmdInput, Ok, E extends Tagged> = Cmd<Name, Ok, E | MalformedResult> & Readonly<Input>
```

<a id="CtxArg"></a>

### `CtxArg`

```ts
type CtxArg<Ctx> = [Record<never, never>] extends [Ctx] ? { ctx?: Ctx } : { ctx: Ctx }
```

<a id="DeclaredErrorsOf"></a>

### `DeclaredErrorsOf`

```ts
type DeclaredErrorsOf<C> = Exclude<ErrorsOf<C>, MalformedResult>
```

<a id="defineListener"></a>

### `defineListener`

```ts
function defineListener<
  Args extends readonly unknown[],
  S extends Sub = Sub,
  Ctx = unknown,
>(
  target: ListenerTarget<Args, S, Ctx>,
): <M>(msgFn: (sub: S, ...args: Args) => M | null) => SubscribeHandler<S, M, Ctx>
```

<a id="defineMachine"></a>

### `defineMachine`

```ts
function defineMachine<
  S,
  M extends { type: string },
  D extends AnyCmdDef,
  U extends Sub = Sub<never>,
  Ctx = unknown,
>(
  m: NoInfer<Omit<Machine<S, M | Settled<D>, CmdOf<D>, U, Ctx>, "cmds">> & {
    readonly cmds: readonly D[];
    readonly types: MachineTypes<S, M, Cmd<never>, U, Ctx>;
  },
): Machine<S, M | Settled<D>, CmdOf<D>, U, Ctx>
function defineMachine<
  S,
  M extends { type: string },
  C extends Cmd = Cmd<never>,
  U extends Sub = Sub<never>,
  Ctx = unknown,
>(
  m: NoInfer<Machine<S, M, C, U, Ctx>> & {
    readonly types: MachineTypes<S, M, C, U, Ctx>;
  },
): Machine<S, M, C, U, Ctx>
function defineMachine<
  S,
  M extends { type: string },
  D extends AnyCmdDef,
  U extends Sub,
  Ctx,
>(
  m: Omit<Machine<S, M | Settled<D>, CmdOf<D>, U, Ctx>, "cmds" | "update"> & {
    readonly cmds: readonly D[];
    update: [S] extends [{ type: string }] ? Transitions<S, M | Settled<D>, CmdOf<D>> : never;
  },
): Machine<S, M | Settled<D>, CmdOf<D>, U, Ctx>
function defineMachine<
  S,
  M extends { type: string },
  D extends AnyCmdDef,
  U extends Sub,
  Ctx,
>(
  m: Omit<Machine<S, M | Settled<D>, CmdOf<D>, U, Ctx>, "cmds" | "update"> & {
    readonly cmds: readonly D[];
    update: Reducer<S, M | Settled<D>, CmdOf<D>>;
  },
): Machine<S, M | Settled<D>, CmdOf<D>, U, Ctx>
function defineMachine<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  m: Omit<Machine<S, M, C, U, Ctx>, "update"> & {
    update: [S] extends [{ type: string }] ? Transitions<S, M, C> : never;
  },
): Machine<S, M, C, U, Ctx>
function defineMachine<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  m: Omit<Machine<S, M, C, U, Ctx>, "update"> & { update: Reducer<S, M, C> },
): Machine<S, M, C, U, Ctx>
```

<a id="defineManagedResource"></a>

### `defineManagedResource`

```ts
function defineManagedResource<N extends string, TKey, Handle, Ctx>(
  opts: DefineManagedResourceOpts<N, TKey, Handle, Ctx>,
): ManagedResourceBattery<N, TKey, Handle, Ctx>
```

<a id="DefineManagedResourceOpts"></a>

### `DefineManagedResourceOpts`

```ts
interface DefineManagedResourceOpts<N extends string, TKey, Handle, Ctx> {
  /**
   * Build the resource. Runs when the resource's `deps` turns non-null.
   * The returned Handle is the ONLY thing `release` receives — capture
   * everything teardown needs into it. If `acquire` throws, the engine does
   * NOT register the Sub and `release` is never called (no dangling
   * half-built resource).
   */
  readonly acquire: (key: TKey, ctx: Ctx) => Handle;
  /**
   * A short, stable name — and the resource's Sub `type`. The machine's
   * `subscribe` table holds this battery's runner under it, so it must be
   * unique among the machine's Sub types.
   */
  readonly name: N;
  /**
   * Tear the resource down. Runs when the key goes null (phase exited) or
   * changes. MANDATORY — the guaranteed teardown is the reason this battery
   * exists.
   *
   * May be sync or async, and an async one is really awaited: the promise is
   * returned to the substrate, which tracks it and drains it inside `stop()`
   * (bounded by `run({ disposeTimeoutMs })`). So `await runtime.stop()` means
   * the release finished — the reading a host evicting an isolate acts on.
   * MID-RUN teardown (a phase exit, a key change) is still fire-and-forget
   * (Rule 2): the reconcile pass is synchronous by construction, so it starts
   * the release and moves on. A rejection is never a Msg — it reaches the
   * runtime's `onError` sink under `phase: "sub-cleanup"`.
   */
  readonly release: (handle: Handle) => void | Promise<void>;
}
```

<a id="definePort"></a>

### `definePort`

```ts
function definePort<T>(name: string): Port<T>
```

<a id="DeletableStore"></a>

### `DeletableStore`

```ts
interface DeletableStore<S> extends Store<S> {
  /** Remove the saved state. Idempotent: deleting nothing resolves. */
  delete(): Promise<void>;
}
```

<a id="DepKeyedSub"></a>

### `DepKeyedSub`

```ts
type DepKeyedSub<S, U extends Sub = Sub> = U extends Sub<infer T, infer D> ? {
  /**
   * The slice of state this Sub depends on. `null` or `undefined` ⇒ off in
   * this state (see `depsInactive`), so `(s) => s.optionalRunId` gates
   * correctly. Pure (invariant 2). Plain JSON-compatible data only
   * (invariant 1): the structural hash THROWS on a `Date`, `Map`, `Set`,
   * `Error` or class instance rather than collapsing them onto one id.
   */
  readonly deps: (state: S) => D | null | undefined;
  readonly type: T;
} : never
```

<a id="describeMachine"></a>

### `describeMachine`

```ts
function describeMachine(
  machine: { __form?: UpdateForm; update: object },
): MachineShape
```

<a id="detectUpdateForm"></a>

### `detectUpdateForm`

```ts
function detectUpdateForm(update: object): UpdateForm
```

<a id="DispatchDiscardedError"></a>

### `DispatchDiscardedError`

```ts
class DispatchDiscardedError extends RuntimeDiscardNotice {
  constructor(msgType: string);
  readonly _tag: "DispatchDiscardedError";
  readonly msgType: string;
  readonly name: "DispatchDiscardedError";
}
```

<a id="DispatchSettle"></a>

### `DispatchSettle`

```ts
type DispatchSettle = "quiescent" | "once"
```

<a id="Dispose"></a>

### `Dispose`

```ts
type Dispose = () => void | Promise<void>
```

<a id="DisposeTimeoutNotice"></a>

### `DisposeTimeoutNotice`

```ts
class DisposeTimeoutNotice extends RuntimeDiscardNotice {
  constructor(pendingDisposals: number, timeoutMs: number);
  readonly _tag: "DisposeTimeoutNotice";
  readonly name: "DisposeTimeoutNotice";
  readonly pendingDisposals: number;
  readonly timeoutMs: number;
}
```

<a id="DriveFailedError"></a>

### `DriveFailedError`

```ts
class DriveFailedError<S> extends Error {
  constructor(state: S);
  readonly _tag: "DriveFailedError";
  readonly name: "DriveFailedError";
  readonly state: S;
}
```

<a id="DriveStalledError"></a>

### `DriveStalledError`

```ts
class DriveStalledError<S> extends Error {
  constructor(state: S);
  readonly _tag: "DriveStalledError";
  readonly name: "DriveStalledError";
  readonly state: S;
}
```

<a id="EngineRun"></a>

### `EngineRun`

```ts
type EngineRun<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
  E extends { type: string } = never,
> = (
  machine: Machine<S, M, C, U, Ctx>,
  opts: RunOptions<S, M, C, U, Ctx, E>,
) => RunHandle<S, M, E>
```

<a id="ErrOf"></a>

### `ErrOf`

```ts
type ErrOf<D extends AnyCmdDef> = D extends CmdDef<infer _Name, infer _Input, infer _Ok, infer E> ? E : never
```

<a id="ErrorsOf"></a>

### `ErrorsOf`

```ts
type ErrorsOf<C> = C extends { readonly __e?: infer E } ? E : unknown
```

<a id="EventSourceFactoryOpts"></a>

### `EventSourceFactoryOpts`

```ts
interface EventSourceFactoryOpts<S, M> {
  onError?: (event: MinimalEvent, sub: S) => M | null;
  onMessage: (data: string, sub: S) => M | null;
  onOpen?: (sub: S) => M | null;
}
```

<a id="ExhaustiveTransitions"></a>

### `ExhaustiveTransitions`

```ts
type ExhaustiveTransitions<S extends { type: string }, M extends { type: string }, C extends Cmd> = { [P in S["type"]]: { [K in M["type"]]: (
  state: Extract<S, { type: P }>,
  msg: Extract<M, { type: K }>,
) => SyncReturn<S, C> } }
```

<a id="FencedRead"></a>

### `FencedRead`

```ts
interface FencedRead {
  /** Raw bytes at the key, the `Store.load` contract unchanged. */
  readonly raw: unknown;
  /** The version those bytes were written at. A never-written key reads `0`. */
  readonly version: number;
}
```

<a id="FencedStore"></a>

### `FencedStore`

```ts
interface FencedStore<S> extends Store<S> {
  /** Discriminant — the one thing isFencedStore reads. */
  readonly fenced: true;
  /** `load`, plus the version those bytes carry. */
  loadFenced(): Promise<FencedRead>;
  /**
   * Compare-and-swap save. Writes `state` only if the stored version is still
   * `expectedVersion`, and resolves with the NEW version to swap on next time.
   * Throws StoreConflictError when it is not.
   */
  saveFenced(state: S, expectedVersion: number): Promise<number>;
}
```

<a id="foldMsgs"></a>

### `foldMsgs`

```ts
function foldMsgs<
  S,
  M extends { type: string },
  C extends Cmd<string, unknown, unknown>,
  U extends Sub<string, unknown>,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  base: S,
  msgs: readonly M[],
): S
```

<a id="FoldRefusal"></a>

### `FoldRefusal`

```ts
interface FoldRefusal<M> {
  /** The underlying cell-lookup failure: msg.type + state name + accepted set. */
  readonly error: NoCellError;
  /** Index into the `msgs` array the fold was given. */
  readonly index: number;
  /** The offending Msg itself — so the caller can print it, not just point. */
  readonly msg: M;
}
```

<a id="foldUpdates"></a>

### `foldUpdates`

```ts
function foldUpdates<
  S,
  M extends { type: string },
  C extends Cmd<string, unknown, unknown>,
>(
  machine: { __form?: UpdateForm; update: object },
  initialState: S,
  msgs: readonly M[],
): { cmds: C[]; state: S }
```

<a id="formOf"></a>

### `formOf`

```ts
function formOf(machine: { __form?: UpdateForm; update: object }): UpdateForm
```

<a id="fromBroadcastChannel"></a>

### `fromBroadcastChannel`

```ts
function fromBroadcastChannel<S extends Sub<string, BroadcastSubData>, M>(
  msgFn: (event: MinimalMessageEvent, sub: S) => M | null,
): SubscribeHandler<S, M, unknown>
```

<a id="fromEventSource"></a>

### `fromEventSource`

```ts
function fromEventSource<S extends Sub<string, EventSourceSubData>, M>(
  opts: EventSourceFactoryOpts<S, M>,
): SubscribeHandler<S, M, unknown>
```

<a id="fromEventTarget"></a>

### `fromEventTarget`

```ts
function fromEventTarget<S extends Sub, M>(
  getTarget: () => MinimalEventTarget,
  eventName: string,
  msgFn: (event: MinimalEvent, sub: S) => M | null,
): SubscribeHandler<S, M, unknown>
```

<a id="fromInterval"></a>

### `fromInterval`

```ts
function fromInterval<S extends Sub<string, IntervalSubData>, M>(
  msgFn: (sub: S) => M,
): SubscribeHandler<S, M, unknown>
```

<a id="fromPort"></a>

### `fromPort`

```ts
function fromPort<
  S extends Sub,
  M,
  Ctx,
  T,
  RS = unknown,
  RM extends { type: string } = { type: string },
>(
  selectRuntime: (ctx: Ctx) => Runtime<RS, RM>,
  port: Port<T>,
  msgFn: (value: T, sub: S) => M | null,
): SubscribeHandler<S, M, Ctx>
```

<a id="fromReconnectingWebSocket"></a>

### `fromReconnectingWebSocket`

```ts
function fromReconnectingWebSocket<S extends Sub<string, WebSocketSubData>, M>(
  opts: ReconnectingWebSocketFactoryOpts<S, M>,
): SubscribeHandler<S, M, unknown>
```

<a id="fromTimeout"></a>

### `fromTimeout`

```ts
function fromTimeout<S extends Sub<string, TimeoutSubData>, M>(
  msgFn: (sub: S) => M,
): SubscribeHandler<S, M, unknown>
```

<a id="fromTransport"></a>

### `fromTransport`

```ts
function fromTransport<N extends string, TKey, Inbound, Outbound, M, Ctx>(
  opts: FromTransportOpts<N, TKey, Inbound, Outbound, M, Ctx>,
): TransportBattery<N, TKey, Outbound, M, Ctx>
```

<a id="FromTransportOpts"></a>

### `FromTransportOpts`

```ts
interface FromTransportOpts<N extends string, TKey, Inbound, Outbound, M, Ctx> {
  /**
   * The Msg dispatched when the transport closes (peer gone, network
   * dropped, normal close). ONE Msg arm, not a Sub, not a heartbeat-derived
   * deadline — the transport's own close signal is the truth.
   */
  readonly lostMsg: (key: TKey) => M;
  /**
   * A short, stable name for this seam — and its Sub `type`. The machine's
   * `subscribe` table holds the seam's runner under it, so it must be unique
   * among the machine's Sub types.
   */
  readonly name: N;
  /**
   * Map a parsed inbound to a domain Msg. Returning `null` drops the
   * dispatch (e.g. a transport-level pong that doesn't change domain state).
   */
  readonly onInbound: (inbound: Inbound, key: TKey) => M | null;
  /**
   * Build the transport. The battery owns the lifetime; the factory is the
   * platform-specific constructor (`new WebSocket(...)` adapter on a DO,
   * `MessagePort` adapter in a worker, in-memory stub in tests).
   */
  readonly openTransport: (key: TKey, ctx: Ctx) => Transport;
  /**
   * Parse one inbound frame. The battery hands `unknown` through (boundary
   * parse is the consumer's responsibility per invariant 8). Returning
   * `null` drops the frame silently — useful for frames the seam doesn't
   * recognize at this layer (e.g. transport-level keepalive).
   */
  readonly parseInbound: (raw: string, key: TKey) => Inbound | null;
  /**
   * Serialize an outbound. Called by the Cmd handler the battery wires.
   * Pure data → string at the seam boundary.
   */
  readonly serializeOutbound: (outbound: Outbound) => string;
}
```

<a id="fromWebSocket"></a>

### `fromWebSocket`

```ts
function fromWebSocket<S extends Sub<string, WebSocketSubData>, M>(
  opts: WebSocketFactoryOpts<S, M>,
): SubscribeHandler<S, M, unknown>
```

<a id="historyTracker"></a>

### `historyTracker`

```ts
function historyTracker<S, M extends { type: string }>(
  runtime: BootingRuntime<S, M>,
  size: number,
): HistoryTracker<S, M>
```

<a id="HistoryTracker"></a>

### `HistoryTracker`

```ts
interface HistoryTracker<S, M extends { type: string }> {
  /**
   * Snapshot of recorded transitions, oldest first. Each entry is
   * `{ msg, state }`: `msg` is `null` for the boot transition (recorded via
   * `onBoot`) and the applied Msg for every other (recorded via `observe`).
   *
   * Returns a shallow copy: the array is fresh on every call (callers may
   * iterate, slice, or replay without affecting the tracker's buffer).
   * Entry values are references to the originals (TEA states/msgs are
   * conventionally immutable; do not mutate them if your S/M is not).
   */
  snapshot(): readonly { readonly msg: M | null; readonly state: S }[];
  /**
   * Detach the underlying observer. After `stop()`:
   *   - No new transitions are recorded.
   *   - `snapshot()` continues to work and returns the buffer's contents
   *     at the moment of stop (useful for post-hoc inspection in tests).
   *   - The tracker holds no references that would prevent GC of the
   *     `runtime` argument other than the entries already buffered.
   *
   * Idempotent — subsequent calls are no-ops.
   */
  stop(): void;
}
```

<a id="Identity"></a>

### `Identity`

```ts
interface Identity<S, M> {
  /**
   * The identity a message is addressed to, or `undefined` when the message
   * carries no identity (lifecycle / pre-identity messages — never dropped).
   * Pure (invariant 2); plain value when defined.
   */
  readonly ofMsg: (msg: M) => unknown;
  /** The identity THIS instance owns. Pure (invariant 2); plain value. */
  readonly ofState: (state: S) => unknown;
}
```

<a id="IdentityDropNotice"></a>

### `IdentityDropNotice`

```ts
class IdentityDropNotice extends RuntimeDiscardNotice {
  constructor(msgType: string);
  readonly _tag: "IdentityDropNotice";
  readonly msgType: string;
  readonly name: "IdentityDropNotice";
}
```

<a id="initAck"></a>

### `initAck`

```ts
function initAck(): Ack
```

<a id="Interpret"></a>

### `Interpret`

```ts
type Interpret<M extends { type: string }, C extends Cmd, Ctx> = { [K in C["type"]]: InterpretCell<M, Extract<C, { type: K }>, Ctx> }
```

<a id="InterpretArg"></a>

### `InterpretArg`

```ts
type InterpretArg<M extends { type: string }, C extends Cmd, Ctx> = [C] extends [Cmd<never>] ? { interpret?: Interpret<M, C, Ctx> } : { interpret: Interpret<M, C, Ctx> }
```

<a id="InterpretCell"></a>

### `InterpretCell`

```ts
type InterpretCell<M extends { type: string }, C extends Cmd, Ctx> = unknown extends ErrorsOf<C> ? (
  cmd: C,
  ctx: HandlerCtx<Ctx>,
  dispatch?: (msg: M) => void,
) => Promise<M | readonly M[] | void> : (
  cmd: C,
  ctx: HandlerCtx<Ctx> & OutcomeHelpers<OkOfCmd<C>, DeclaredErrorsOf<C>>,
  dispatch?: (msg: M) => void,
) => Promise<Outcome<OkOfCmd<C>, DeclaredErrorsOf<C>> | void>
```

<a id="InterpretDetached"></a>

### `InterpretDetached`

```ts
type InterpretDetached<C extends Cmd, Allowed extends { type: string }, Ctx> = (
  cmd: C,
  ctx: HandlerCtx<Ctx>,
  dispatch: (msg: Allowed) => void,
) => Promise<void>
```

<a id="isFencedStore"></a>

### `isFencedStore`

```ts
function isFencedStore<S>(store: Store<S>): store is FencedStore<S>
```

<a id="liftSlice"></a>

### `liftSlice`

```ts
function liftSlice<S, K extends string | number | symbol, C>(
  key: K,
  state: S,
  __namedParameters: readonly [S[K], readonly C[]],
): readonly [S, readonly C[]]
```

<a id="ListenerTarget"></a>

### `ListenerTarget`

```ts
interface ListenerTarget<Args extends readonly unknown[], S extends Sub, Ctx> {
  add: (listener: (...args: Args) => void, sub: S, ctx: Ctx) => void;
  remove: (listener: (...args: Args) => void, sub: S, ctx: Ctx) => void;
}
```

<a id="Machine"></a>

### `Machine`

```ts
type Machine<S, M extends { type: string }, C extends Cmd, U extends Sub, Ctx> = {
  /**
   * The update form ("reducer" | "transitions"), stamped non-enumerably by
   * `defineMachine` at construction (see `UpdateForm` / `formOf`). Optional in
   * the type so the structural `Machine` annotation form keeps accepting plain
   * object literals; readers go through `formOf`, which falls back to
   * `detectUpdateForm` when the tag is absent. Never written by hand.
   */
  readonly __form?: UpdateForm;
  /**
   * Phantom — never assigned, never read. `subs` reaches `U` only through a
   * conditional type, which is no inference site, so this is the slot a caller
   * like `run(machine, …)` infers the Sub union from (and so what types its
   * `subscribe` runners). Same device as `Cmd`'s `__ok`. Tuple-wrapped so an
   * empty union (`never`) is still a candidate rather than `undefined`.
   */
  readonly __sub?: readonly [U];
  /**
   * The typed Cmd constructors this machine emits (`Cmd.define`). Declared
   * through `defineMachine({ cmds })`, which derives `C` and the settled half
   * of `M` from them; the runtime reads the list to parse each handler's
   * `_ok` value against its `ok` schema and stamp `at` at the interpret edge.
   * A machine of hand-written Cmds omits it and runs exactly as before.
   */
  readonly cmds?: readonly AnyCmdDef[];
  /**
   * Instance-identity filter. Declares THIS instance's identity once; the
   * substrate drops any message addressed to a DIFFERENT identity before it
   * reaches `update`. Replaces the per-cell `if (msg.runId !== state.runId)`
   * guard entirely — the reducer never sees a foreign-instance message, so no
   * cell needs to check.
   *
   * Opt-in: a machine that omits `identity` skips the filter (every message
   * reaches `update`, exactly as before). A message whose `ofMsg` returns
   * `undefined` is identity-agnostic and always reaches `update` (lifecycle /
   * pre-identity messages).
   *
   * Strengthens invariant 7 (identity is explicit — declared once, enforced by
   * the substrate) and invariant 6 (mis-addressed messages dropped at one
   * observable point, not per cell).
   */
  identity?: Identity<S, M>;
  /**
   * Boot the runtime. Called once by `run(...)` with whatever `Store.load()`
   * returned: `null` on fresh boot, the persisted state on rehydrate.
   *
   * **Contract:** when `loaded !== null`, init MUST return `[loaded, []]` —
   * no Cmds. Init's rehydrate branch is the migration / parse boundary, not
   * the boot-effect hook. See Invariant 2 in `.patterns/tea/tea-invariants.md`.
   *
   * Boot effects routes:
   *   - Stateless infrastructure → host module top, outside TEA.
   *   - State-conditional resume → a `boot` Msg the host dispatches once
   *     after `run(...)` returns.
   *
   * Violations are caught at runtime by `replay` (which throws with a
   * pointer to the alternatives).
   */
  init: (loaded: S | null, ctx: Ctx) => readonly [S, readonly C[]];
  /**
   * The machine's Subs, as data: each entry names a Sub `type` and the state
   * slice it depends on (`deps`). The engine derives the id
   * (`structuralHash({ type, deps })`) and the gate (`deps` non-null), starts
   * the runner for `type` when an entry turns on, leaves it alone while the id
   * holds, restarts it when the id changes, and stops it on `null` or `stop()`.
   *
   * `U` is the machine's own Sub union (`types.sub`); the built-in `timer`
   * (`{ type: "timer", deps: (s) => ({ ms, msg }) }`) is always available.
   *
   * Strengthens invariant 4 (lifecycle owned by the substrate) and invariant 7
   * (identity derived, not hand-authored).
   */
  readonly subs?: ReadonlyArray<DepKeyedSub<S, U | BuiltinSub<M>>>;
  update: Reducer<S, M, C> | ([S] extends [{ type: string }] ? Transitions<S, M, C> : never);
}
```

<a id="MachineShape"></a>

### `MachineShape`

```ts
type MachineShape =
  | {
    readonly form: "reducer";
    /** Every `Msg.type` the flat reducer has a cell for. */
    readonly msgs: readonly string[];
  }
  | {
    /** `state.type` → the `Msg.type`s that state has a cell for. */
    readonly accepts: Readonly<Record<string, readonly string[]>>;
    readonly form: "transitions";
    /** The union of every row's `Msg.type` keys (see `msgKeysOf`). */
    readonly msgs: readonly string[];
    /** Every `state.type` the table has a row for, in table order. */
    readonly states: readonly string[];
  }
```

<a id="MachineTypes"></a>

### `MachineTypes`

```ts
type MachineTypes<S, M extends { type: string }, C extends Cmd, U extends Sub, Ctx> = {
  readonly cmd?: C;
  readonly ctx?: Ctx;
  readonly model: S;
  readonly msg: M;
  readonly sub?: U;
}
```

<a id="MalformedResult"></a>

### `MalformedResult`

```ts
type MalformedResult = {
  readonly _tag: "malformed_result";
  readonly issues: ReadonlyArray<{
    readonly message: string;
    readonly path: string;
  }>;
}
```

<a id="ManagedResourceBattery"></a>

### `ManagedResourceBattery`

```ts
interface ManagedResourceBattery<N extends string, TKey, Handle, Ctx> {
  /**
   * The `subs` entry. `when(state)` returns the resource's KEY when it should
   * be held, or `null` when it should be torn down. The key is the Sub's
   * `deps`, so the engine derives the id from it: an unchanged key leaves the
   * resource alone, a changed key releases the old one and acquires anew.
   * Plain JSON-compatible data only — the id hash throws on anything else.
   */
  readonly depKeyed: <S>(
    when: (state: S) => TKey | null,
  ) => {
    /**
     * The slice of state this Sub depends on. `null` or `undefined` ⇒ off in
     * this state (see `depsInactive`), so `(s) => s.optionalRunId` gates
     * correctly. Pure (invariant 2). Plain JSON-compatible data only
     * (invariant 1): the structural hash THROWS on a `Date`, `Map`, `Set`,
     * `Error` or class instance rather than collapsing them onto one id.
     */
    readonly deps: (state: S) => TKey | null | undefined;
    readonly type: N;
  };
  /**
   * Accessor for the live Handle, keyed on `key` (the author's key, never the
   * derived Sub id). Returns `undefined` when the resource is not currently
   * held — the caller decides whether that is an error. A Cmd handler wires
   * its `ctx.getX(key)` through this, so the handler reads the SAME owner the
   * reconciler holds, never a hand-built duplicate.
   */
  readonly get: (key: TKey) => Handle | undefined;
  /**
   * The runner for this battery's Sub type — hand it to `run` as
   * `subscribe: { [battery.type]: battery.subscribe }`. Runs `acquire` on
   * start, holds the Handle in the battery's handle table, and returns a
   * cleanup that runs `release` (and forgets the Handle) on stop.
   */
  readonly subscribe: (
    sub: ManagedResourceSub<N, TKey>,
    ctx: Ctx,
    dispatch: (msg: never) => void,
  ) => Dispose;
  /** The battery's Sub type — its `name`. */
  readonly type: N;
}
```

<a id="ManagedResourceSub"></a>

### `ManagedResourceSub`

```ts
type ManagedResourceSub<N extends string, TKey> = Sub<N, TKey>
```

<a id="Migrated"></a>

### `Migrated`

```ts
type Migrated<S> = S | null | Refusal
```

<a id="msgKeysOf"></a>

### `msgKeysOf`

```ts
function msgKeysOf(
  machine: { __form?: UpdateForm; update: object },
): readonly string[]
```

<a id="nextSeq"></a>

### `nextSeq`

```ts
function nextSeq<T>(buffer: readonly SeqTagged<T>[]): number
```

<a id="NO_ACK"></a>

### `NO_ACK`

```ts
const NO_ACK: Seq
```

<a id="NoCellError"></a>

### `NoCellError`

```ts
class NoCellError extends Error {
  constructor(msgType: string, stateName: string, acceptedTypes: readonly string[]);
  readonly _tag: "NoCellError";
  /** The Msg types the refusing state has cells for; empty when it has none. */
  readonly acceptedTypes: readonly string[];
  readonly msgType: string;
  readonly name: "NoCellError";
  readonly stateName: string;
}
```

<a id="NoCtx"></a>

### `NoCtx`

```ts
type NoCtx = Readonly<Record<never, never>>
```

<a id="noop"></a>

### `noop`

```ts
function noop<S, M, C extends Cmd>(
  state: S,
  _msg: M,
): readonly [S, readonly C[]]
```

<a id="OkOf"></a>

### `OkOf`

```ts
type OkOf<D extends AnyCmdDef> = D extends CmdDef<infer _Name, infer _Input, infer Ok, infer _E> ? Ok : never
```

<a id="OkOfCmd"></a>

### `OkOfCmd`

```ts
type OkOfCmd<C> = C extends { readonly __ok?: infer Ok } ? Ok : unknown
```

<a id="OnError"></a>

### `OnError`

```ts
type OnError = (error: unknown, context: RuntimeErrorContext) => void
```

<a id="Outcome"></a>

### `Outcome`

```ts
type Outcome<Ok, E> =
  | { readonly _tag: "Ok"; readonly value: Ok }
  | { readonly _tag: "Err"; readonly error: E }

const Outcome: {
  readonly err: <E>(error: E) => Outcome<never, E>;
  readonly ok: <Ok>(value: Ok) => Outcome<Ok, never>;
}
```

<a id="OutcomeContractError"></a>

### `OutcomeContractError`

```ts
class OutcomeContractError extends Error {
  constructor(cmdType: string, detail: string);
  readonly _tag: "OutcomeContractError";
  readonly cmdType: string;
  readonly name: "OutcomeContractError";
}
```

<a id="OutcomeHelpers"></a>

### `OutcomeHelpers`

```ts
interface OutcomeHelpers<Ok, E> {
  readonly err: (error: E) => Outcome<never, E>;
  readonly ok: (value: Ok) => Outcome<Ok, never>;
}
```

<a id="partitionByAck"></a>

### `partitionByAck`

```ts
function partitionByAck<T>(
  buffer: readonly SeqTagged<T>[],
  ackOrSeq: number | Ack,
): AckPartition<T>
```

<a id="Port"></a>

### `Port`

```ts
interface Port<T> {
  readonly __brand: "port";
  readonly __t?: T;
  readonly name: string;
}
```

<a id="PortEmitter"></a>

### `PortEmitter`

```ts
interface PortEmitter {
  emit<T>(port: Port<T>, value: T): void;
}
```

<a id="PortNameCollisionError"></a>

### `PortNameCollisionError`

```ts
class PortNameCollisionError extends Error {
  constructor(portName: string);
  readonly _tag: "PortNameCollisionError";
  readonly name: "PortNameCollisionError";
}
```

<a id="QuiescenceTimeoutError"></a>

### `QuiescenceTimeoutError`

```ts
class QuiescenceTimeoutError extends Error {
  constructor(iterations: number);
  readonly _tag: "QuiescenceTimeoutError";
  readonly iterations: number;
  readonly name: "QuiescenceTimeoutError";
}
```

<a id="readInOrder"></a>

### `readInOrder`

```ts
function readInOrder<In, Out>(
  input: In,
  order: readonly ReadStep<In, Out>[],
  absent: Out,
): Out
```

<a id="ReadStep"></a>

### `ReadStep`

```ts
interface ReadStep<In, Out> {
  /** The slice this step consults — `"cache"`, `"failed"`, `"inFlight"`. */
  readonly name: string;
  /** What this slice says about `input`, or `undefined` to defer. */
  readonly read: (input: In) => Out | undefined;
}
```

<a id="reconcile"></a>

### `reconcile`

```ts
function reconcile<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  authoritativeState: S,
  lastAppliedSeq: number | Ack,
  pending: readonly SeqTagged<M>[],
): S
```

<a id="ReconnectingWebSocketFactoryOpts"></a>

### `ReconnectingWebSocketFactoryOpts`

```ts
interface ReconnectingWebSocketFactoryOpts<S, M> {
  /** First backoff delay in ms (doubles each failed attempt). Default 250. */
  backoffBaseMs?: number;
  /** Backoff ceiling in ms. Default 5000. */
  backoffMaxMs?: number;
  /** Inject the socket constructor (defaults to the global `WebSocket`); the test seam. */
  connect?: (url: string) => MinimalWebSocket;
  onClose?: (code: number, reason: string, sub: S) => M | null;
  onError?: (event: MinimalEvent, sub: S) => M | null;
  onMessage: (data: unknown, sub: S) => M | null;
  onOpen?: (sub: S) => M | null;
  /**
   * Fires when a reconnection (any open after the first) succeeds, carrying the
   * 1-based reconnect count — the resync hook. Omitting drops reconnect events
   * silently.
   */
  onReconnect?: (attempt: number, sub: S) => M | null;
  /** Inject the timer (defaults to `setTimeout`/`clearTimeout`); the test seam. */
  schedule?: (fn: () => void, ms: number) => CancelTimer;
}
```

<a id="Reducer"></a>

### `Reducer`

```ts
type Reducer<S, M extends { type: string }, C extends Cmd> = { [K in M["type"]]: (state: S, msg: Extract<M, { type: K }>) => SyncReturn<S, C> }
```

<a id="Refusal"></a>

### `Refusal`

```ts
class Refusal {
  constructor(reason: string);
  readonly _tag: "refusal";
  readonly reason: string;
}
```

<a id="refuse"></a>

### `refuse`

```ts
function refuse(reason: string): Refusal
```

<a id="replay"></a>

### `replay`

```ts
function replay<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  opts: {
    ctx: Ctx;
    loaded?: S | null;
    msgs: readonly M[];
  },
): {
  cmds: C[];
  state: S;
  subs: (U | BuiltinSub<M>)[];
}
```

<a id="RunHandle"></a>

### `RunHandle`

```ts
interface RunHandle<S, M extends { type: string }, E extends { type: string } = never> {
  /** Resolves to the booted handle once boot completes. */
  readonly ready: Promise<BootedRunHandle<S, M, E>>;
  /** Put a Msg in the inbox; resolves once the engine has processed it. */
  dispatch(msg: M): Promise<void>;
  /** A `(msg, state)` hook, fired after each applied transition. */
  observe(observer: (msg: M, state: S) => void): () => void;
  /** Subscribe to the semantic event of `type` the run's `events` projects. */
  on<K extends string>(
    type: K,
    handler: (event: Extract<E, { type: K }>) => void,
  ): () => void;
  /** Fires once with the initial State — at once if boot already ran. */
  onBoot(handler: (state: S) => void): () => void;
  /** Stop the run; resolves once the engine has torn it down. */
  stop(): Promise<void>;
  /** A zero-arg change notifier, fired after each applied transition. */
  subscribe(listener: () => void): () => void;
}
```

<a id="RunHandlers"></a>

### `RunHandlers`

```ts
type RunHandlers<M extends { type: string }, C extends Cmd, U extends Sub, Ctx> = InterpretArg<M, C, Ctx> & SubscribeArg<M, U, Ctx>
```

<a id="RunOptions"></a>

### `RunOptions`

```ts
type RunOptions<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
  E extends { type: string } = never,
> = CtxArg<Ctx> & RunHandlers<M, C, U, Ctx> & {
  readonly events?: (msg: M, state: S) => readonly E[];
  readonly store?: Store<S>;
}
```

<a id="Runtime"></a>

### `Runtime`

```ts
interface Runtime<S, M extends { type: string }, E extends { type: string } = never> extends BootingRuntime<S, M, E> {
  /** Resolves to this same `Runtime` once boot completes. Idempotent. */
  ready: Promise<Runtime<S, M, E>>;
  /**
   * Resolves with the terminal State the first time the run reaches one (per the
   * `terminal` predicate). If ALREADY terminal, resolves immediately; otherwise
   * on the transition that first makes `terminal` hold. The awaitable companion
   * to `result()`. With no predicate this never resolves. Idempotent and
   * multi-caller safe.
   */
  done(): Promise<S>;
  /**
   * The current State. TOTAL — never throws. Obtaining a `Runtime` requires
   * awaiting `ready`, which only resolves AFTER boot has run `init` and set the
   * initial State.
   */
  getState(): S;
  /**
   * Resolves once the runtime has reached QUIESCENCE — every dispatched Msg AND
   * every transitive interpret follow-up has been processed, with no further step
   * pending on the tail. Since plain `dispatch` already runs to quiescence, this
   * is mainly for follow-ups left by a `dispatchOnce` single step, or a chain
   * kicked off by a Sub / boot `init` cmds with no `dispatch` to await.
   *
   * Idempotent and re-entrant-safe. Tail rejections are NOT surfaced here (a
   * failing dispatch surfaces on its OWN promise; follow-up rejections route to
   * `onError`). The one rejection `idle()` produces is `QuiescenceTimeoutError`
   * on hitting the iteration cap — so a livelock stays distinguishable from a
   * genuine quiesce (invariant 6). A poll is still correct when waiting on an
   * EXTERNAL event the runtime cannot enqueue itself.
   */
  idle(): Promise<void>;
  /**
   * The terminal State of the run, or `undefined` while in flight — "terminal"
   * per the `terminal` predicate passed to `run()` (no predicate → never
   * terminal → always `undefined`). The first-class result read: the run's
   * product off the State the machine already owns, NOT scraped off the `observe`
   * firehose by matching an internal Msg name. Total — never throws.
   */
  result(): S | undefined;
}
```

<a id="RuntimeDiscardedError"></a>

### `RuntimeDiscardedError`

```ts
class RuntimeDiscardedError extends RuntimeDiscardNotice {
  constructor(pendingCmds: number);
  readonly _tag: "RuntimeDiscardedError";
  readonly name: "RuntimeDiscardedError";
  readonly pendingCmds: number;
}
```

<a id="RuntimeDiscardNotice"></a>

### `RuntimeDiscardNotice`

```ts
abstract class RuntimeDiscardNotice extends Error {}
```

<a id="RuntimeErrorContext"></a>

### `RuntimeErrorContext`

```ts
interface RuntimeErrorContext {
  readonly phase: RuntimeErrorPhase;
}
```

<a id="RuntimeErrorPhase"></a>

### `RuntimeErrorPhase`

```ts
type RuntimeErrorPhase =
  | "follow-up"
  | "interpret"
  | "stop-save"
  | "reduce"
  | "listener"
  | "observer"
  | "event"
  | "boot"
  | "port-emit"
  | "sub-cleanup"
  | "sub"
  | "discard"
  | "identity-drop"
```

<a id="RuntimeRef"></a>

### `RuntimeRef`

```ts
interface RuntimeRef<M extends { type: string }> {
  /**
   * Put a Msg in the runtime's inbox and resolve once processed. Runs to
   * QUIESCENCE by default: settles only after the dispatched Msg AND every
   * transitive interpret follow-up has drained. Pass `{ settle: "once" }` (or
   * call `dispatchOnce`) for the single-step case.
   *
   * Rejection ordering: the ONE dispatched transition's own failure surfaces
   * first, here. If it succeeds but the follow-up chain never stabilizes, the
   * quiescent drain rejects with `QuiescenceTimeoutError`. Follow-up Msg
   * rejections themselves route to the `onError` sink, never here.
   */
  dispatch(msg: M, opts?: { readonly settle?: DispatchSettle }): Promise<void>;
  /**
   * Dispatch `msg` and resolve after exactly ONE transition's effects settle,
   * WITHOUT draining the follow-up chain — equivalent to
   * `dispatch(msg, { settle: "once" })`. Prefer plain `dispatch` unless you will
   * `await runtime.idle()` yourself; the un-awaited follow-up chain is the
   * footgun the quiescent default removed.
   */
  dispatchOnce(msg: M): Promise<void>;
}
```

<a id="Schema"></a>

### `Schema`

```ts
interface Schema<S> {
  safeParse(raw: unknown): { data: S; success: true } | { success: false };
}
```

<a id="schemaMigrate"></a>

### `schemaMigrate`

```ts
function schemaMigrate<S>(
  schema: Schema<S>,
  upcast?: (raw: unknown) => unknown,
): (raw: unknown) => Migrated<S>
```

<a id="Seq"></a>

### `Seq`

```ts
type Seq = number
```

<a id="SeqTagged"></a>

### `SeqTagged`

```ts
interface SeqTagged<T> {
  readonly seq: number;
  readonly value: T;
}
```

<a id="Settled"></a>

### `Settled`

```ts
type Settled<D extends AnyCmdDef> = D extends CmdDef<infer Name, infer Input, infer Ok, infer E> ? SettledOk<Name, CmdValue<Name, Input, Ok, E>, Ok> | SettledErr<Name, CmdValue<Name, Input, Ok, E>, E> : never
```

<a id="SettledErr"></a>

### `SettledErr`

```ts
type SettledErr<Name extends string, C, E extends Tagged> = {
  /** Stamped by the runtime at the interpret edge (`run`'s `clock`). */
  readonly at: number;
  readonly cmd: C;
  readonly error: E | MalformedResult;
  readonly type: `${Name}_err`;
}
```

<a id="SettledOk"></a>

### `SettledOk`

```ts
type SettledOk<Name extends string, C, Ok> = {
  /** Stamped by the runtime at the interpret edge (`run`'s `clock`). */
  readonly at: number;
  readonly cmd: C;
  readonly type: `${Name}_ok`;
  readonly value: Ok;
}
```

<a id="Store"></a>

### `Store`

```ts
interface Store<S> {
  load(): Promise<unknown>;
  migrate(raw: unknown): Migrated<S>;
  save(state: S): Promise<void>;
}
```

<a id="StoreConflictError"></a>

### `StoreConflictError`

```ts
class StoreConflictError extends Error {
  constructor(expectedVersion: number, actualVersion: number);
  readonly _tag: "store_conflict";
  readonly actualVersion: number;
  readonly expectedVersion: number;
  readonly name: "StoreConflictError";
}
```

<a id="StoreRefusedError"></a>

### `StoreRefusedError`

```ts
class StoreRefusedError extends Error {
  constructor(reason: string, options?: { readonly cause?: unknown });
  readonly _tag: "store_refused";
  readonly name: "StoreRefusedError";
  readonly reason: string;
}
```

<a id="structuralHash"></a>

### `structuralHash`

```ts
function structuralHash(deps: unknown): string
```

<a id="Sub"></a>

### `Sub`

```ts
type Sub<T extends string = string, D = unknown> = {
  readonly deps: D;
  readonly id: SubId;
  readonly type: T;
}
```

<a id="subId"></a>

### `subId`

```ts
function subId(s: string): SubId
```

<a id="SubId"></a>

### `SubId`

```ts
type SubId = string & { readonly __brand: "SubId" }
```

<a id="subIdOf"></a>

### `subIdOf`

```ts
function subIdOf(type: string, deps: unknown): SubId
```

<a id="Subscribe"></a>

### `Subscribe`

```ts
type Subscribe<M extends { type: string }, U extends Sub, Ctx> = { [K in U["type"]]: (sub: Extract<U, { type: K }>, ctx: Ctx, dispatch: (msg: M) => void) => Dispose }
```

<a id="SubscribeArg"></a>

### `SubscribeArg`

```ts
type SubscribeArg<M extends { type: string }, U extends Sub, Ctx> = [Exclude<U["type"], BuiltinSubType>] extends [never] ? {
  readonly subscribe?: Partial<Subscribe<M, Exclude<U, Sub<never>> | BuiltinSub<M>, Ctx>>;
} : {
  readonly subscribe: Subscribe<M, Exclude<U, { readonly type: BuiltinSubType }>, Ctx> & Partial<Subscribe<M, BuiltinSub<M>, Ctx>>;
}
```

<a id="SubscribeHandler"></a>

### `SubscribeHandler`

```ts
type SubscribeHandler<S extends Sub, M, Ctx> = (sub: S, ctx: Ctx, dispatch: (msg: M) => void) => Dispose
```

<a id="Supervision"></a>

### `Supervision`

```ts
type Supervision<S, M extends { type: string }> =
  | "stop"
  | "escalate"
  | { readonly strategy: "stop" }
  | { readonly strategy: "escalate" }
  | {
    /**
     * Host-provided rehydration to last-known-good state. Invoked when the
     * reducer throws; its return value becomes the new state and the transition
     * continues from there. Receives the pre-throw `state`, the `msg` that
     * triggered the throw, and the thrown `error` so the host can route by
     * cause.
     */
    readonly rehydrate: (state: S, msg: M, error: unknown) => S;
    readonly strategy: "restart";
  }
```

<a id="SupervisionStrategy"></a>

### `SupervisionStrategy`

```ts
type SupervisionStrategy = "stop" | "escalate" | "restart"
```

<a id="SyncReturn"></a>

### `SyncReturn`

```ts
type SyncReturn<S, C extends Cmd> = readonly [S, readonly C[]] & { readonly then?: never }
```

<a id="Tagged"></a>

### `Tagged`

```ts
type Tagged = {
  readonly _tag: string;
}
```

<a id="TaggedError"></a>

### `TaggedError`

```ts
type TaggedError<Tag extends string> = Tag extends string ? {
  readonly [detail: string]: unknown;
  readonly _tag: Tag;
} : never
```

<a id="tagSeq"></a>

### `tagSeq`

```ts
function tagSeq<T>(seq: number, value: T): SeqTagged<T>
```

<a id="TelemetryEvent"></a>

### `TelemetryEvent`

```ts
interface TelemetryEvent {
  /** When the transition committed, read off `run`'s `clock` (ms since epoch). */
  readonly at: number;
  /** The `Msg.type` that drove the transition. */
  readonly msgType: string;
  /** This run's applied transitions so far, counted from 1. Boot is not one. */
  readonly seq: number;
}
```

<a id="TelemetrySink"></a>

### `TelemetrySink`

```ts
type TelemetrySink = (event: TelemetryEvent) => void | Promise<void>
```

<a id="TimerDeps"></a>

### `TimerDeps`

```ts
type TimerDeps<M> = {
  readonly ms: number;
  readonly msg: M;
}
```

<a id="TimerSub"></a>

### `TimerSub`

```ts
type TimerSub<M> = Sub<"timer", TimerDeps<M>>
```

<a id="Transitions"></a>

### `Transitions`

```ts
type Transitions<S extends { type: string }, M extends { type: string }, C extends Cmd> = { [P in S["type"]]: Partial<ExhaustiveTransitions<S, M, C>[P]> }
```

<a id="Transport"></a>

### `Transport`

```ts
interface Transport {
  /** Close the underlying channel cleanly. Called by the Sub cleanup. */
  close(): void;
  /**
   * Subscribe to a one-shot close. Returns a cleanup that removes the
   * listener. The battery dispatches `lostMsg` on close.
   */
  onClose(listener: () => void): () => void;
  /**
   * Subscribe to inbound frames. Returns a cleanup that removes the listener.
   * The battery wires this in its runner; cleanup runs when the seam's key
   * goes null or changes.
   */
  onMessage(listener: (data: string) => void): () => void;
  /** Send a string frame. Best-effort; failures are logged at the boundary. */
  send(data: string): void;
}
```

<a id="TransportBattery"></a>

### `TransportBattery`

```ts
interface TransportBattery<N extends string, TKey, Outbound, M, Ctx> {
  /**
   * The `subs` entry. `when(state)` returns the seam's KEY when it should be
   * open, or `null` when it should be torn down. The key is the Sub's `deps`,
   * so the engine derives the id from it: an unchanged key leaves the seam
   * open, a changed key closes it and opens a fresh one. Plain
   * JSON-compatible data only — the id hash throws on anything else.
   */
  readonly depKeyed: <S>(
    when: (state: S) => TKey | null,
  ) => {
    /**
     * The slice of state this Sub depends on. `null` or `undefined` ⇒ off in
     * this state (see `depsInactive`), so `(s) => s.optionalRunId` gates
     * correctly. Pure (invariant 2). Plain JSON-compatible data only
     * (invariant 1): the structural hash THROWS on a `Date`, `Map`, `Set`,
     * `Error` or class instance rather than collapsing them onto one id.
     */
    readonly deps: (state: S) => TKey | null | undefined;
    readonly type: N;
  };
  /**
   * Outbound send, addressed by the seam's key (never the derived Sub id,
   * which the caller cannot know). The Cmd handler calls this; the battery's
   * handle table (built when the runner started) routes to the live
   * transport. If the seam is closed (no running Sub), the send is dropped
   * honestly (logged, not thrown — the reducer already moved past caring,
   * same shape as Rule 2 fire-and-forget Cmds).
   */
  readonly send: (key: TKey, outbound: Outbound) => void;
  /**
   * The runner for this seam's Sub type — hand it to `run` as
   * `subscribe: { [seam.type]: seam.subscribe }`. Wires inbound + close in
   * one shot and publishes the live transport to the outbound handle table.
   */
  readonly subscribe: (sub: TransportSub<N, TKey>, ctx: Ctx, dispatch: (msg: M) => void) => Dispose;
  /** The seam's Sub type — its `name`. */
  readonly type: N;
}
```

<a id="TransportFactory"></a>

### `TransportFactory`

```ts
type TransportFactory<K> = (key: K) => Transport
```

<a id="TransportSub"></a>

### `TransportSub`

```ts
type TransportSub<N extends string, TKey> = Sub<N, TKey>
```

<a id="tryApplyCell"></a>

### `tryApplyCell`

```ts
function tryApplyCell<S, M extends { type: string }, C extends Cmd>(
  machine: { __form?: UpdateForm; update: object },
  state: S,
  msg: M,
): Outcome<readonly [S, readonly C[]], NoCellError>
```

<a id="tryFoldMsgs"></a>

### `tryFoldMsgs`

```ts
function tryFoldMsgs<S, M extends { type: string }, C extends Cmd>(
  machine: { __form?: UpdateForm; update: object },
  base: S,
  msgs: readonly M[],
): Outcome<S, FoldRefusal<M>>
```

<a id="tryInterpret"></a>

### `tryInterpret`

```ts
function tryInterpret<C extends Cmd, Ok, M, Ctx>(
  work: (cmd: C, ctx: Ctx) => Promise<Ok>,
  onOk: (value: Ok, cmd: C) => M,
  onErr: (error: unknown, cmd: C) => M,
): (cmd: C, ctx: Ctx) => Promise<M>
```

<a id="UndeclaredFailureError"></a>

### `UndeclaredFailureError`

```ts
class UndeclaredFailureError extends Error {
  constructor(cmdType: string, failure: unknown, declared: readonly string[]);
  readonly _tag: "UndeclaredFailureError";
  readonly cmdType: string;
  /** The tags the def declares. */
  readonly declared: readonly string[];
  /** The `error` the handler's `Err` carried, verbatim. */
  readonly failure: unknown;
  readonly name: "UndeclaredFailureError";
}
```

<a id="UpdateForm"></a>

### `UpdateForm`

```ts
type UpdateForm = "reducer" | "transitions"
```

<a id="WebSocketFactoryOpts"></a>

### `WebSocketFactoryOpts`

```ts
interface WebSocketFactoryOpts<S, M> {
  onClose?: (code: number, reason: string, sub: S) => M | null;
  onError?: (event: MinimalEvent, sub: S) => M | null;
  onMessage: (data: unknown, sub: S) => M | null;
  onOpen?: (sub: S) => M | null;
}
```

<a id="WebSocketSubData"></a>

### `WebSocketSubData`

```ts
type WebSocketSubData = {
  readonly wsUrl: string;
}
```

<a id="Wired"></a>

### `Wired`

```ts
type Wired<S, M extends { type: string }, C extends Cmd, U extends Sub, Ctx> = { readonly machine: Machine<S, M, C, U, Ctx> } & RunHandlers<M, C, U, Ctx>
```

<a id="wrapDetached"></a>

### `wrapDetached`

```ts
function wrapDetached<
  C extends Cmd,
  M extends { type: string },
  Allowed extends { type: string },
  Ctx,
>(
  handler: InterpretDetached<C, Allowed, Ctx>,
): (cmd: C, ctx: HandlerCtx<Ctx>, dispatch?: (msg: M) => void) => Promise<void>
```
