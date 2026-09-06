# @demlik/tea

> TEA-faithful state machine substrate.

```ts
import { … } from "@demlik/tea";
```

## Exports (129)

| Symbol | Kind | Summary |
| --- | --- | --- |
| `absurd` | Function |  |
| `acceptsOf` | Function |  |
| `ack` | Function |  |
| `Ack` | Interface | The authoritative side's acknowledgement: the highest `seq` it has applied. |
| `AckPartition` | Interface | The result of splitting a seq-tagged buffer against an ack. |
| `AnyCmdDef` | Type | The declaration-erased view the runtime reads: which `type` a def builds, which two Msg types it settles with, and the `ok` schema the edge parses against. |
| `applyCell` | Function |  |
| `applyCellChecked` | Function |  |
| `asReducer` | Function |  |
| `BootingRuntime` | Interface |  |
| `Branded` | Type |  |
| `CancelTimer` | Type | Cancels a scheduled reconnect timer (the inverse of `schedule`). |
| `Cmd` | Type |  |
| `Cmd` | Variable |  |
| `CmdDef` | Interface | What `Cmd.define` returns: the Cmd builder itself (`fetch({ url })`), with the minted Msg builders and the declaration hung on it. |
| `CmdInput` | Type | The payload a constructor accepts: a plain record spread beside `type`. |
| `CmdOf` | Type | The Cmd value a def (or a union of defs) builds. |
| `CmdValue` | Type | The value `Cmd.define("fetch", …)` builds: `{ type: "fetch", ...input }`. |
| `CombinedManagedResources` | Interface | What `combineManagedResources` returns: the single managed-resource `subscribe` cell for the machine's `subscribe` record, and a `subs(state)` builder for `subscriptions(state)`. |
| `combineManagedResources` | Function |  |
| `CtxArg` | Type |  |
| `defineListener` | Function |  |
| `defineMachine` | Function |  |
| `defineManagedResource` | Function |  |
| `DefineManagedResourceOpts` | Interface |  |
| `definePort` | Function |  |
| `DepKeyedSub` | Interface |  |
| `describeMachine` | Function |  |
| `detectUpdateForm` | Function |  |
| `DispatchDiscardedError` | Class | The rejection of a dispatch that arrived DURING `stop()`'s drain — an in-flight interpret handler's follow-up Msg, a detached handler's terminal Msg, or a Sub that is still live because subs are torn down only after the drain. |
| `DispatchSettle` | Type |  |
| `Dispose` | Type |  |
| `DisposeTimeoutNotice` | Class | Reported to the `OnError` sink under `phase: "discard"` when `stop()`'s wait for async teardown work hits `disposeTimeoutMs`. |
| `DriveFailedError` | Class | Raised by `driveToDone` when the drive ends on a State its `failed` predicate marks as a failure. |
| `DriveStalledError` | Class | Raised by `driveToDone` when `start`'s follow-up chain quiesces on a State that is neither terminal nor `failed` AND nothing in the runtime can still transition it — no live Sub (manual or dep-keyed), no in-flight Cmd. |
| `driveToDone` | Function |  |
| `DriveToDoneOptions` | Interface | Options for `driveToDone`. |
| `ErrOf` | Type | The DECLARED failure union a def's handler may settle with. |
| `ErrorsOf` | Type | The `E` union one Cmd can settle with; `unknown` for an untyped Cmd. |
| `EventSourceFactoryOpts` | Interface |  |
| `foldMsgs` | Function |  |
| `FoldRefusal` | Interface | The refusal `tryFoldMsgs` reports: WHICH msg in the log had no cell, where. |
| `foldUpdates` | Function |  |
| `formOf` | Function |  |
| `fromBroadcastChannel` | Function |  |
| `fromEventSource` | Function |  |
| `fromEventTarget` | Function |  |
| `fromInterval` | Function |  |
| `fromPort` | Function |  |
| `fromReconnectingWebSocket` | Function |  |
| `fromTimeout` | Function |  |
| `fromTransport` | Function |  |
| `FromTransportOpts` | Interface |  |
| `fromWebSocket` | Function |  |
| `GatedManagedResource` | Interface | A battery paired with a state-gate. |
| `historyTracker` | Function |  |
| `HistoryTracker` | Interface |  |
| `Identity` | Interface |  |
| `IdentityDropNotice` | Class | Reported to the `OnError` sink under `phase: "identity-drop"` when the `Identity` filter drops a message addressed to a different instance. |
| `initAck` | Function |  |
| `Interpret` | Type |  |
| `InterpretDetached` | Type |  |
| `ListenerTarget` | Interface | The imperative listener target, expressed as the `add`/`remove` pair the substrate pairs into a reconciled resource. |
| `Machine` | Type |  |
| `MachineShape` | Type |  |
| `MalformedResult` | Type | The kernel-minted failure: a handler returned a `_ok` value the Cmd's `ok` schema rejects. |
| `ManagedResourceBattery` | Interface | What the battery returns: a `.sub(key)` builder for `subscriptions`, the `.subscribe` handler for the machine's `subscribe` record, a `.get(key)` accessor so Cmd handlers can reach the live Handle while the resource is held, and a `.subIdFor(key)` for tests. |
| `ManagedResourceSub` | Interface | The Sub the battery builds. |
| `msgKeysOf` | Function |  |
| `Needs` | Type | Phantom carrier for a Cmd's `R`. |
| `NeedsOf` | Type |  |
| `nextSeq` | Function |  |
| `NO_ACK` | Variable | The "nothing applied yet" cursor — the ack value for a server that has applied no client input at all. |
| `NoCellError` | Class |  |
| `NoCtx` | Type |  |
| `noop` | Function |  |
| `OkOf` | Type | The `Ok` a def's handler must produce. |
| `OnError` | Type | Sink for runtime failures that have no caller to reject at. |
| `partitionByAck` | Function |  |
| `Port` | Interface |  |
| `PortEmitter` | Interface | Augmentation injected onto `ctx` inside Cmd handlers. |
| `PortNameCollisionError` | Class | Thrown by `definePort` when a name has already been registered in the current process. |
| `QuiescenceTimeoutError` | Class | Raised by `idle()` when the quiescence wait hits its iteration cap without the dispatch tail stabilizing — `idle()` REJECTS rather than silently resolving, so a livelocking machine surfaces instead of masquerading as quiescent. |
| `reconcile` | Function |  |
| `ReconnectingWebSocketFactoryOpts` | Interface |  |
| `Reducer` | Type |  |
| `replay` | Function |  |
| `RequiredCtx` | Type | The `ctx` a machine's whole Cmd union requires: every Cmd's `R`, intersected. |
| `run` | Function |  |
| `Runtime` | Interface |  |
| `RuntimeDiscardedError` | Class | Reported to the `OnError` sink under `phase: "discard"` when `stop()` is called while `interpret` handlers are still awaiting. |
| `RuntimeDiscardNotice` | Class | Base of the LOSSY-BUT-LEGAL teardown facts: work the host discarded by letting go of a runtime that still had something outstanding. |
| `RuntimeErrorContext` | Interface | Context handed to an `OnError` sink alongside the error itself. |
| `RuntimeErrorPhase` | Type | Which otherwise-unattributable runtime path produced an error. |
| `RuntimeRef` | Interface |  |
| `Schema` | Interface |  |
| `schemaMigrate` | Function |  |
| `Seq` | Type | A monotonic, non-negative sequence number tagging one client-predicted command. |
| `SeqTagged` | Interface | A command (or `Msg`) tagged with the `seq` the client assigned it. |
| `settle` | Function |  |
| `Settled` | Type | The settled-Msg union a def (or a union of defs) mints: `<name>_ok` carrying `value`, `<name>_err` carrying `error`. |
| `SettledErr` | Type |  |
| `SettledOk` | Type |  |
| `Store` | Interface |  |
| `structuralHash` | Function |  |
| `Sub` | Type |  |
| `subId` | Function |  |
| `SubId` | Type |  |
| `SubIdCollisionError` | Class | Thrown by `reconcileSubs` when, within ONE desired subscription set, two subs share an `id` but declare different `type`s — a silent bug class the type system cannot reach (ids are strings compared at runtime). |
| `Subscribe` | Type |  |
| `SubscribeHandler` | Type |  |
| `Supervision` | Type | Declared supervision policy for a reducer (`update`) throw, at `run(machine, { supervision })`. |
| `SupervisionStrategy` | Type | The three declared reducer-throw supervision strategies. |
| `SyncReturn` | Type |  |
| `Tagged` | Type | The shape every settled failure has (ADR 0011): a plain `_tag` record. |
| `TaggedError` | Type | One declared failure per tag. |
| `tagSeq` | Function |  |
| `Transitions` | Type |  |
| `Transport` | Interface | Duplex transport. |
| `TransportBattery` | Interface | What the battery returns: a Sub builder (for `subscriptions`), the Sub's `subscribe` handler (for `subscribe.transport`), and a `send(key, outbound)` helper the consumer's Cmd handler calls. |
| `TransportFactory` | Type | Factory the consumer wires to a platform-specific transport. |
| `TransportSub` | Interface | The Sub the battery builds. |
| `tryApplyCell` | Function |  |
| `tryFoldMsgs` | Function |  |
| `tryInterpret` | Function |  |
| `UpdateForm` | Type |  |
| `WebSocketFactoryOpts` | Interface |  |
| `WebSocketSubData` | Type |  |
| `wrapDetached` | Function |  |
