# @demlik/tea

> TEA-faithful state machine substrate.

```ts
import { … } from "@demlik/tea";
```

## Exports (47)

| Symbol | Kind | Summary |
| --- | --- | --- |
| `absurd` | Function |  |
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
| `detectUpdateForm` | Function |  |
| `DispatchSettle` | Type |  |
| `foldMsgs` | Function |  |
| `formOf` | Function |  |
| `historyTracker` | Function |  |
| `HistoryTracker` | Interface |  |
| `Interpret` | Type |  |
| `Machine` | Type |  |
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
| `RuntimeErrorContext` | Interface | Context handed to an `OnError` sink alongside the error itself. |
| `RuntimeErrorPhase` | Type | Which otherwise-unattributable runtime path produced an error. |
| `RuntimeRef` | Interface |  |
| `Store` | Interface |  |
| `Sub` | Type |  |
| `subId` | Function |  |
| `SubId` | Type |  |
| `SubIdCollisionError` | Class | Thrown by `reconcileSubs` when, within ONE desired subscription set, two subs share an `id` but declare different `type`s — a silent bug class the type system cannot reach (ids are strings compared at runtime). |
| `Subscribe` | Type |  |
| `Supervision` | Type | Declared supervision policy for a reducer (`update`) throw, at `run(machine, { supervision })`. |
| `SupervisionStrategy` | Type | The three declared reducer-throw supervision strategies. |
| `SyncReturn` | Type |  |
| `Transitions` | Type |  |
| `tryInterpret` | Function |  |
| `UpdateForm` | Type |  |
