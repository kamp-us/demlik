# @demlik/tea

> TEA-faithful state machine substrate.

```ts
import { … } from "@demlik/tea";
```

## Exports (66)

| Symbol | Kind | Summary |
| --- | --- | --- |
| `absurd` | Function |  |
| `acceptsOf` | Function |  |
| `applyCell` | Function |  |
| `asReducer` | Function |  |
| `BootingRuntime` | Interface |  |
| `Branded` | Type |  |
| `Cmd` | Type |  |
| `Cmd` | Variable |  |
| `ContextFree` | Type | Spelled-out alias for `NoCtx`. |
| `CtxArg` | Type |  |
| `defineMachine` | Function |  |
| `definePort` | Function |  |
| `DepKeyedSub` | Interface |  |
| `describeMachine` | Function |  |
| `detectUpdateForm` | Function |  |
| `DispatchDiscardedError` | Class | The rejection of a dispatch that arrived DURING `stop()`'s drain — an in-flight interpret handler's follow-up Msg, a detached handler's terminal Msg, or a Sub that is still live because subs are torn down only after the drain. |
| `DispatchSettle` | Type |  |
| `Dispose` | Type |  |
| `DisposeTimeoutNotice` | Class | Reported to the `OnError` sink under `phase: "discard"` when `stop()`'s wait for async teardown work hits `disposeTimeoutMs`. |
| `foldMsgs` | Function |  |
| `FoldRefusal` | Interface | The refusal `tryFoldMsgs` reports: WHICH msg in the log had no cell, where. |
| `formOf` | Function |  |
| `historyTracker` | Function |  |
| `HistoryTracker` | Interface |  |
| `Identity` | Interface |  |
| `IdentityDropNotice` | Class | Reported to the `OnError` sink under `phase: "identity-drop"` when the `Identity` filter drops a message addressed to a different instance. |
| `Interpret` | Type |  |
| `InterpretDetached` | Type |  |
| `Machine` | Type |  |
| `MachineShape` | Type |  |
| `msgKeysOf` | Function |  |
| `NoCellError` | Class |  |
| `NoCtx` | Type |  |
| `noop` | Function |  |
| `OnError` | Type | Sink for runtime failures that have no caller to reject at. |
| `Port` | Interface |  |
| `PortEmitter` | Interface | Augmentation injected onto `ctx` inside Cmd handlers. |
| `PortNameCollisionError` | Class | Thrown by `definePort` when a name has already been registered in the current process. |
| `QuiescenceTimeoutError` | Class | Raised by `idle()` when the quiescence wait hits its iteration cap without the dispatch tail stabilizing — `idle()` REJECTS rather than silently resolving, so a livelocking machine surfaces instead of masquerading as quiescent. |
| `Reducer` | Type |  |
| `replay` | Function |  |
| `run` | Function |  |
| `Runtime` | Interface |  |
| `RuntimeDiscardedError` | Class | Reported to the `OnError` sink under `phase: "discard"` when `stop()` is called while `interpret` handlers are still awaiting. |
| `RuntimeDiscardNotice` | Class | Base of the LOSSY-BUT-LEGAL teardown facts: work the host discarded by letting go of a runtime that still had something outstanding. |
| `RuntimeErrorContext` | Interface | Context handed to an `OnError` sink alongside the error itself. |
| `RuntimeErrorPhase` | Type | Which otherwise-unattributable runtime path produced an error. |
| `RuntimeRef` | Interface |  |
| `Schema` | Interface |  |
| `schemaMigrate` | Function |  |
| `Store` | Interface |  |
| `structuralHash` | Function |  |
| `Sub` | Type |  |
| `subId` | Function |  |
| `SubId` | Type |  |
| `SubIdCollisionError` | Class | Thrown by `reconcileSubs` when, within ONE desired subscription set, two subs share an `id` but declare different `type`s — a silent bug class the type system cannot reach (ids are strings compared at runtime). |
| `Subscribe` | Type |  |
| `Supervision` | Type | Declared supervision policy for a reducer (`update`) throw, at `run(machine, { supervision })`. |
| `SupervisionStrategy` | Type | The three declared reducer-throw supervision strategies. |
| `SyncReturn` | Type |  |
| `Transitions` | Type |  |
| `tryApplyCell` | Function |  |
| `tryFoldMsgs` | Function |  |
| `tryInterpret` | Function |  |
| `UpdateForm` | Type |  |
| `wrapDetached` | Function |  |
