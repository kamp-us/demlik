# @demlik/tea

> TEA-faithful state machine substrate.

```ts
import { … } from "@demlik/tea";
```

## Exports (86)

| Symbol | Kind | Summary |
| --- | --- | --- |
| `absurd` | Function |  |
| `acceptsOf` | Function |  |
| `AnyCmdDef` | Type | The declaration-erased view the runtime reads: which `type` a def builds, which two Msg types it settles with, and the `ok` schema the edge parses against. |
| `applyCell` | Function |  |
| `applyCellChecked` | Function |  |
| `asReducer` | Function |  |
| `BootingRuntime` | Interface |  |
| `Branded` | Type |  |
| `Cmd` | Type |  |
| `Cmd` | Variable |  |
| `CmdDef` | Interface | What `Cmd.define` returns: the Cmd builder itself (`fetch({ url })`), with the minted Msg builders and the declaration hung on it. |
| `CmdInput` | Type | The payload a constructor accepts: a plain record spread beside `type`. |
| `CmdOf` | Type | The Cmd value a def (or a union of defs) builds. |
| `CmdValue` | Type | The value `Cmd.define("fetch", …)` builds: `{ type: "fetch", ...input }`. |
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
| `ErrOf` | Type | The DECLARED failure union a def's handler may settle with. |
| `ErrorsOf` | Type | The `E` union one Cmd can settle with; `unknown` for an untyped Cmd. |
| `foldMsgs` | Function |  |
| `FoldRefusal` | Interface | The refusal `tryFoldMsgs` reports: WHICH msg in the log had no cell, where. |
| `foldUpdates` | Function |  |
| `formOf` | Function |  |
| `historyTracker` | Function |  |
| `HistoryTracker` | Interface |  |
| `Identity` | Interface |  |
| `IdentityDropNotice` | Class | Reported to the `OnError` sink under `phase: "identity-drop"` when the `Identity` filter drops a message addressed to a different instance. |
| `Interpret` | Type |  |
| `InterpretDetached` | Type |  |
| `Machine` | Type |  |
| `MachineShape` | Type |  |
| `MalformedResult` | Type | The kernel-minted failure: a handler returned a `_ok` value the Cmd's `ok` schema rejects. |
| `msgKeysOf` | Function |  |
| `Needs` | Type | Phantom carrier for a Cmd's `R`. |
| `NeedsOf` | Type |  |
| `NoCellError` | Class |  |
| `NoCtx` | Type |  |
| `noop` | Function |  |
| `OkOf` | Type | The `Ok` a def's handler must produce. |
| `OnError` | Type | Sink for runtime failures that have no caller to reject at. |
| `Port` | Interface |  |
| `PortEmitter` | Interface | Augmentation injected onto `ctx` inside Cmd handlers. |
| `PortNameCollisionError` | Class | Thrown by `definePort` when a name has already been registered in the current process. |
| `QuiescenceTimeoutError` | Class | Raised by `idle()` when the quiescence wait hits its iteration cap without the dispatch tail stabilizing — `idle()` REJECTS rather than silently resolving, so a livelocking machine surfaces instead of masquerading as quiescent. |
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
| `Supervision` | Type | Declared supervision policy for a reducer (`update`) throw, at `run(machine, { supervision })`. |
| `SupervisionStrategy` | Type | The three declared reducer-throw supervision strategies. |
| `SyncReturn` | Type |  |
| `Tagged` | Type | The shape every settled failure has (ADR 0011): a plain `_tag` record. |
| `TaggedError` | Type | One declared failure per tag. |
| `Transitions` | Type |  |
| `tryApplyCell` | Function |  |
| `tryFoldMsgs` | Function |  |
| `tryInterpret` | Function |  |
| `UpdateForm` | Type |  |
| `wrapDetached` | Function |  |
