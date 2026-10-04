# @demlik/tea

> TEA-faithful state machine substrate.

```ts
import { … } from "@demlik/tea";
```

## Exports (157)

| Symbol | Kind | Summary |
| --- | --- | --- |
| `absurd` | Function | Compile-time exhaustiveness assertion for default branches of switches over discriminated unions narrowed by hand (Sub handlers, message-bridge dispatchers, port fanouts) — TS narrows the operand to `never` only if every variant is covered, so adding one produces a compile error at the `absurd(x)` site. |
| `acceptedTypes` | Function | The Msg types this machine would accept in this state — the same set a `NoCellError` reports, asked before anything is dispatched. |
| `acceptsOf` | Function | List the Msg types a machine accepts in the state named `stateType`. |
| `ack` | Function | Construct an `Ack` for a last-applied sequence number. |
| `Ack` | Interface | The authoritative side's acknowledgement: the highest `seq` it has applied. |
| `AckPartition` | Interface | The result of splitting a seq-tagged buffer against an ack. |
| `AnyCmdDef` | Type | The declaration-erased view the runtime reads: which `type` a def builds, which two Msg types it settles with, the `ok` schema the edge parses against and the tags an `Err` may carry. |
| `applyCell` | Function | Run the one update cell that matches `state` and `msg` and return its `[nextState, cmds]`. |
| `applyCellChecked` | Function | `applyCell` with the development-mode checks that catch an impure cell: the input state is frozen and the result is asserted to be plain data. |
| `asReducer` | Function | Type-check a standalone reducer record and return it branded. |
| `AsyncSchemaError` | Class | A schema whose `validate` returned a Promise where the kernel needs an answer now — the `ok` check at the interpret edge, the `args` check in a reducer. |
| `BootedRunHandle` | Interface | A RunHandle whose boot has completed, so its State exists. |
| `BootingRuntime` | Interface | What the Promise engine's `run` returns, the instant it is called, while boot is still in flight: its RunHandle, widened with Ports and `dispatchOnce`. |
| `Branded` | Type | A `Reducer` or `Transitions` value that went through `asReducer` or `defineMachine`. |
| `BuiltinSub` | Type | The built-in Subs a machine over `M` may declare without declaring them. |
| `BuiltinSubType` | Type | The Sub types every engine ships a runner for. |
| `CancelTimer` | Type | Cancels a scheduled reconnect timer (the inverse of `schedule`). |
| `Cmd` | Type | A tagged-union, one-shot effect — JSON-plain, hashable, replayable. |
| `Cmd` | Variable | The helpers for building Cmds: `Cmd.define` declares a typed Cmd constructor, and `Cmd.none`, `Cmd.batch`, `Cmd.when` and `Cmd.whenDefined` build the Cmd list an update cell returns. |
| `CmdDef` | Interface | What `Cmd.define` returns: the Cmd builder itself (`fetch({ url })`), with the minted Msg builders and the declaration hung on it. |
| `CmdInput` | Type | The payload a constructor accepts: a plain record spread beside `type`. |
| `CmdOf` | Type | The Cmd value a def (or a union of defs) builds. |
| `CmdValue` | Type | The value `Cmd.define("fetch", …)` builds: `{ type: "fetch", ...input }`. |
| `CtxArg` | Type | The `ctx` field of an engine's options: optional when the machine's `Ctx` is empty, required otherwise. |
| `DeclaredErrorsOf` | Type | The failures a `Cmd.define`d Cmd's handler may return: its declared tags. |
| `defineListener` | Function | Build a listener-backed Sub factory whose cleanup is mandatory and derived. |
| `defineMachine` | Function | Define a machine: its `init`, its `update` (a reducer or a transitions table), and optionally its `subs`, `cmds` and `identity`. |
| `defineManagedResource` | Function | Build the battery. |
| `DefineManagedResourceOpts` | Interface | Options for `defineManagedResource`: the resource's `name`, how to `acquire` it for a key, and how to `release` the handle. |
| `definePort` | Function | Define a typed port. |
| `DeletableStore` | Interface | A `Store<S>` that can remove what it saved — how a host forgets a run. |
| `DepKeyedSub` | Type | One entry of a machine's `subs`: a Sub `type` plus `deps(state)`, which returns the data the runner needs, or `null` to keep the Sub off. |
| `describeMachine` | Function | Describe a machine's update table as data: its form, its Msg types, and the per-state accept sets of a transitions machine. |
| `detectUpdateForm` | Function | Work out an `update` record's `UpdateForm` from its shape. |
| `DispatchDiscardedError` | Class | The rejection of a dispatch that arrived DURING `stop()`'s drain — an in-flight interpret handler's follow-up Msg, a detached handler's terminal Msg, or a Sub that is still live because subs are torn down only after the drain. |
| `DispatchSettle` | Type | How long a `dispatch` waits before it resolves: `quiescent`, the default, waits for every follow-up Msg to drain, and `once` waits for the single transition. |
| `Dispose` | Type | The cleanup function a Sub runner returns. |
| `DisposeTimeoutNotice` | Class | Reported to the `OnError` sink under `phase: "discard"` when `stop()`'s wait for async teardown work hits `disposeTimeoutMs`. |
| `DriveFailedError` | Class | Raised by `driveToDone` when the drive ends on a State its `failed` predicate marks as a failure. |
| `DriveStalledError` | Class | Raised by `driveToDone` when `start`'s follow-up chain quiesces on a State that is neither terminal nor `failed` AND nothing in the runtime can still transition it — no live Sub, no in-flight Cmd. |
| `EngineRun` | Type | An engine's `run`, seen from a host adapter: a machine and its RunOptions in, a RunHandle out. |
| `ErrOf` | Type | The DECLARED failure union a def's handler may settle with. |
| `ErrorsOf` | Type | The `E` union one Cmd can settle with; `unknown` for an untyped Cmd. |
| `EventSourceFactoryOpts` | Interface | Options for `fromEventSource`: map each server-sent message, error and open event to a Msg, or to `null` to drop it. |
| `ExhaustiveTransitions` | Type | `Transitions<S, M, C>` with every cell REQUIRED — the opt-in floor for a machine that wants the compiler to force a decision on every (state, message) pair. |
| `FencedRead` | Interface | What a fenced store's `loadFenced` returns: the raw saved value and the version it was written at. |
| `FencedStore` | Interface | A `Store<S>` that can refuse a second live writer. |
| `foldMsgs` | Function | Fold a machine's `update` over a list of Msgs from a base state and return only the final state. |
| `FoldRefusal` | Interface | The refusal `tryFoldMsgs` reports: WHICH msg in the log had no handler, where. |
| `foldUpdates` | Function | Fold a machine's `update` over a list of Msgs from a starting state, and return the final state with every Cmd the cells emitted. |
| `formOf` | Function | Read a machine's `UpdateForm`. |
| `fromBroadcastChannel` | Function | Build a Sub runner that listens on the `BroadcastChannel` named by `sub.deps.channelName` and dispatches `msgFn(event, sub)` for each message. |
| `fromEventSource` | Function | Build a Sub runner that opens an `EventSource` on `sub.deps.url` and dispatches a Msg for each server-sent event. |
| `fromEventTarget` | Function | Build a Sub runner that listens for `eventName` on a DOM-style event target and dispatches `msgFn(event, sub)` for each event. |
| `fromInterval` | Function | Build a Sub runner that dispatches `msgFn(sub)` every `sub.deps.intervalMs` milliseconds while the Sub is on. |
| `fromPort` | Function | Build a Sub runner that listens to a `Port` on another runtime and dispatches `msgFn(value, sub)` for each value emitted. |
| `fromReconnectingWebSocket` | Function | Build a Sub runner that keeps a WebSocket to `sub.deps.wsUrl` open, reconnecting with backoff when it drops. |
| `fromTimeout` | Function | Build a Sub runner that dispatches `msgFn(sub)` once, `sub.deps.delayMs` milliseconds after the Sub turns on. |
| `fromTransport` | Function | Build the battery. |
| `FromTransportOpts` | Interface | Options for `fromTransport`: the seam's `name`, how to open the transport, and how inbound values, outbound values and a dropped connection map to and from Msgs. |
| `fromWebSocket` | Function | Build a Sub runner that opens a WebSocket to `sub.deps.wsUrl` and dispatches a Msg for each socket event. |
| `historyTracker` | Function | Create a bounded history tracker over a Runtime. |
| `HistoryTracker` | Interface | A bounded log of a runtime's recent `(msg, state)` transitions, returned by `historyTracker`. |
| `Identity` | Interface | A machine's optional message filter: `ofState` names the identity this instance owns, and `ofMsg` the identity a Msg is addressed to. |
| `IdentityDropNotice` | Class | Reported to the `OnError` sink under `phase: "identity-drop"` when the `Identity` filter drops a message addressed to a different instance. |
| `initAck` | Function | The `Ack` for a server that has applied nothing yet — `ack(NO_ACK)`. |
| `Interpret` | Type | The Cmd handler table an engine is handed: one async handler per Cmd type. |
| `InterpretArg` | Type | The `interpret` option of an engine's `run`: optional for a machine that emits no Cmd, required — one handler per Cmd variant — for one that does. |
| `InterpretCell` | Type | One cell of Interpret: the outcome-returning form for a `Cmd.define`d Cmd, the form returning a Msg, a list of Msgs or nothing for a hand-written one. |
| `InterpretDetached` | Type | A Cmd handler that reports back through a `dispatch` limited to the Msgs it is allowed to send. |
| `isFencedStore` | Function | Narrow a `Store<S>` to a FencedStore — what `run` uses to decide. |
| `liftSlice` | Function | Lift a battery verb's result into the host state that carries its slice. |
| `ListenerTarget` | Interface | The imperative listener target, expressed as the `add`/`remove` pair the substrate pairs into a reconciled resource. |
| `Machine` | Type | A machine as plain data: `init`, `update`, and optionally `subs`, `cmds` and `identity`. |
| `MachineShape` | Type | What `describeMachine` returns: the Msg types a machine handles and, for a transitions machine, its states and the Msg types each one accepts. |
| `MachineTypes` | Type | The `types` option: the slots of a machine's shape that no value in the object can imply, declared once as phantom values (`{} as Model`). |
| `MalformedResult` | Type | The kernel-minted failure: a handler returned an `Ok` value the Cmd's `ok` schema rejects. |
| `ManagedResourceBattery` | Interface | What the battery returns: a `.depKeyed(when)` entry for the machine's `subs`, the `.subscribe` runner for the `subscribe` table handed to `run`, and a `.get(key)` accessor so Cmd handlers can reach the live Handle while the resource is held. |
| `ManagedResourceSub` | Type | The running Sub of a managed resource named `N`: its `deps` is the lifetime key. |
| `Migrated` | Type | What `Store.migrate` answers: the parsed `S`, `null` when nothing was saved, or a Refusal for saved bytes it cannot read. |
| `msgKeysOf` | Function | List every Msg type a machine has an update cell for, across all of its states. |
| `nextSeq` | Function | The next sequence number to assign: one past the highest `seq` in the buffer, or `0` for an empty buffer. |
| `NO_ACK` | Variable | The "nothing applied yet" cursor — the ack value for a server that has applied no client input at all. |
| `NoCellError` | Class | Thrown when a Msg is dispatched to a state that has no update cell for it. |
| `NoCtx` | Type | The `Ctx` of a machine whose handlers read nothing from context. |
| `noop` | Function | An update cell that ignores its Msg: it returns the state unchanged, with no Cmds. |
| `OkOf` | Type | The `Ok` a def's handler must produce. |
| `OkOfCmd` | Type | The value a Cmd settles with; `unknown` for a hand-written Cmd. |
| `OnError` | Type | Sink for runtime failures that have no caller to reject at. |
| `Outcome` | Type | The result a `Cmd.define`d handler returns: its value, or a declared failure. |
| `Outcome` | Variable | Build an Outcome outside a handler's helpers — in a test that calls a handler directly, or in an adapter converting another result type. |
| `OutcomeContractError` | Class | A `Cmd.define`d handler returned something the engine cannot settle: any Msg (the engine mints the Cmd's `<name>_ok` / `<name>_err`, never the handler — ADR 0021), or any other value that is neither an Outcome nor nothing. |
| `OutcomeHelpers` | Interface | The two builders the Promise engine hands a `Cmd.define`d handler on its ctx: `ok(value)` and `err({ _tag })`, with `err` typed to the def's declared tags. |
| `partitionByAck` | Function | Partition a buffer of seq-tagged commands into ACKED and PENDING against the authoritative `lastAppliedSeq`. |
| `Port` | Interface | A named, typed channel for values leaving the runtime. |
| `PortEmitter` | Interface | Augmentation injected onto `ctx` inside Cmd handlers. |
| `PortNameCollisionError` | Class | Thrown by `definePort` when a name has already been registered in the current process. |
| `QuiescenceTimeoutError` | Class | Raised by `idle()` when the quiescence wait hits its iteration cap without the dispatch tail stabilizing — `idle()` REJECTS rather than silently resolving, so a livelocking machine surfaces instead of masquerading as quiescent. |
| `readInOrder` | Function | Run a composed read through `order` and return the first answer any step gives, or `absent` when every one defers. |
| `ReadStep` | Interface | One step of a composed read: the slice it consults, under the name that slice goes by. |
| `reconcile` | Function | The client prediction/reconciliation helper — the Gambetta/Valve authoritative-server loop's reconcile step, generalized. |
| `ReconnectingWebSocketFactoryOpts` | Interface | Options for `fromReconnectingWebSocket`: the event-to-Msg mappers, the backoff settings, and an injectable `connect` and `schedule` for tests. |
| `Reducer` | Type | The flat form of `update`: a record with one handler per Msg type, each returning `[nextState, cmds]`. |
| `Refusal` | Class | `migrate`'s answer for saved bytes it cannot read. |
| `refuse` | Function | Refuse saved bytes from `Store.migrate`. |
| `replay` | Function | Run a machine's `init` and then its `update` over a list of Msgs, with no engine, store or effects. |
| `RunHandle` | Interface | A running machine's handle: queue a Msg, listen, wait for boot, stop. |
| `RunHandlers` | Type | The handlers an engine is handed beside a machine: the InterpretArg Cmd handlers and the SubscribeArg sub runners. |
| `RunOptions` | Type | The options every engine's `run` accepts: the `ctx`, the handlers the machine runs under, an optional `store`, and the `events` projector that feeds `on`. |
| `Runtime` | Interface | The Promise engine's booted handle — what BootingRuntime's `ready` resolves to once boot completes. |
| `RuntimeDiscardedError` | Class | Reported to the `OnError` sink under `phase: "discard"` when `stop()` is called while `interpret` handlers are still awaiting. |
| `RuntimeDiscardNotice` | Class | Base of the LOSSY-BUT-LEGAL teardown facts: work the host discarded by letting go of a runtime that still had something outstanding. |
| `RuntimeErrorContext` | Interface | Context handed to an `OnError` sink alongside the error itself. |
| `RuntimeErrorPhase` | Type | Which otherwise-unattributable runtime path produced an error. |
| `RuntimeRef` | Interface | The dispatch-only view of a runtime. |
| `Schema` | Interface | The minimal validator shape `schemaMigrate` accepts: an object with `safeParse`. |
| `schemaMigrate` | Function | Build a `Store.migrate` from a schema (job 1) and an optional thin `upcast` (job 2). |
| `Seq` | Type | A monotonic, non-negative sequence number tagging one client-predicted command. |
| `SeqTagged` | Interface | A command (or `Msg`) tagged with the `seq` the client assigned it. |
| `Settled` | Type | The settled-Msg union a def (or a union of defs) mints: `<name>_ok` carrying `value`, `<name>_err` carrying `error`. |
| `SettledErr` | Type | The Msg the engine mints when a `Cmd.define`d Cmd's handler fails: `<name>_err`, carrying the Cmd and the tagged error. |
| `SettledOk` | Type | The Msg the engine mints when a `Cmd.define`d Cmd's handler succeeds: `<name>_ok`, carrying the Cmd and its value. |
| `Store` | Interface | Where an engine loads and saves a machine's state. |
| `StoreConflictError` | Class | Thrown when a fenced save finds a version other than the one it expected — another live writer has this run. |
| `StoreRefusedError` | Class | `ready` rejects with this when the saved state could not be restored: `migrate` returned refuse, or `load` / `migrate` threw (that throw is the `cause`). |
| `structuralHash` | Function | Turn a plain-data value into a stable string that does not depend on object key order. |
| `Sub` | Type | A running subscription as its runner sees it: its `type`, the `deps` value the machine's `subs` entry returned, and an `id` derived from both. |
| `subId` | Function | Construct a `SubId` from a string. |
| `SubId` | Type | The branded string that identifies a running Sub. |
| `subIdOf` | Function | The one `id` of a Sub: a structural hash of its `type` and its `deps` value. |
| `Subscribe` | Type | The Sub runner table an engine is handed: one runner per Sub type. |
| `SubscribeArg` | Type | The `subscribe` option of an engine's `run`: one runner per Sub type the machine declares, except the built-ins (`timer`) the engine already ships. |
| `SubscribeHandler` | Type | A Sub runner: given the Sub, the `ctx` and a `dispatch`, it opens the resource and returns a `Dispose`. |
| `Supervision` | Type | Declared supervision policy for a reducer (`update`) throw, at `run(machine, { supervision })`. |
| `SupervisionStrategy` | Type | The three declared reducer-throw supervision strategies. |
| `SyncReturn` | Type | What an update cell returns: the `[nextState, cmds]` tuple, typed so that a Promise cannot stand in for it. |
| `Tagged` | Type | The shape every settled failure has (ADR 0011): a plain `_tag` record. |
| `TaggedError` | Type | One declared failure per tag. |
| `tagSeq` | Function | Tag a command/`Msg` with its sequence number. |
| `TelemetryEvent` | Interface | What the `telemetry` sink passed to `run` receives, once per APPLIED transition. |
| `TelemetrySink` | Type | The `telemetry` option of `run`: a fire-and-forget sink. |
| `TimerDeps` | Type | The `deps` a `timer` Sub declares: fire `msg` once, `ms` after it starts. |
| `TimerSub` | Type | The built-in `timer` Sub, as its runner sees it. |
| `Transitions` | Type | The state × message table form of `update`. |
| `Transport` | Interface | Duplex transport. |
| `TransportBattery` | Interface | What the battery returns: a `.depKeyed(when)` entry for the machine's `subs`, the `.subscribe` runner for the `subscribe` table handed to `run`, and a `send(key, outbound)` helper the consumer's Cmd handler calls. |
| `TransportFactory` | Type | Factory the consumer wires to a platform-specific transport. |
| `TransportSub` | Type | The running Sub of a seam named `N`: its `deps` is the seam key. |
| `tryApplyCell` | Function | `applyCell`, with "no handler for this Msg" moved into the return type instead of a throw. |
| `tryFoldMsgs` | Function | `foldMsgs`, with the "no handler for this Msg" case in the return type, INCLUDING which message failed. |
| `tryInterpret` | Function | Wrap a function that may throw into a Cmd handler that never rejects: success maps to one Msg through `onOk`, failure to another through `onErr`. |
| `UndeclaredFailureError` | Class | A `Cmd.define`d handler failed outside its declared channel: its `Err` carried no `_tag`, or a tag the def does not declare. |
| `UpdateForm` | Type | Which of the two shapes a machine's `update` takes: a flat `reducer` keyed by Msg type, or a `transitions` table keyed by state type and then Msg type. |
| `WebSocketFactoryOpts` | Interface | Options for `fromWebSocket`: map each message, open, error and close event to a Msg, or to `null` to drop it. |
| `WebSocketSubData` | Type | The `deps` a WebSocket Sub carries: the `wsUrl` to connect to. |
| `Wired` | Type | A machine beside the handlers it runs under — what a wrapper, a battery's `toMachine` or an agent host hands around, and what an engine takes apart: `run(wired.machine, { ...wired, ctx })`. |
| `wrapDetached` | Function | Adapt an `InterpretDetached` handler into an ordinary `interpret` cell. |
