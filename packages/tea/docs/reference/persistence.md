# @demlik/tea/persistence

> the durability batteries: record a run to a trace, replay that trace back, and checkpoint a long-running machine to a host store between evictions.

```ts
import { … } from "@demlik/tea/persistence";
```

## Exports (25)

| Symbol | Kind | Summary |
| --- | --- | --- |
| `breadcrumbsFromTrace` | Function | Project a Trace's recorded msgs into Sentry-shaped breadcrumbs — a human-readable timeline of "what happened before the crash". |
| `BreadcrumbsOptions` | Interface | Options for breadcrumbsFromTrace. |
| `createSnapshot` | Function | Create a snapshot knob from a `SnapshotConfig`. |
| `deepEqual` | Function | Order-insensitive structural deep-equality — the comparator the record/replay lane owns, exposed so consumers (e.g. |
| `parseJSONL` | Function | Re-hydrate a Trace from the JSONL produced by Recorder.toJSONL. |
| `recorder` | Function | Attach a recorder to a Runtime. |
| `Recorder` | Interface | A live recorder attached to a Runtime. |
| `RecorderOptions` | Interface | Options for recorder. |
| `ReplayResult` | Interface | The outcome of replayTrace. |
| `replayTrace` | Function | Replay a recorded Trace against `machine` and diff the recomputed final state against the recorded one. |
| `SnapshotConfig` | Interface | The snapshot knob. |
| `SnapshotFailedMsg` | Type | The Msg the engine mints when a write fails. |
| `SnapshotKnob` | Interface | The bundle `createSnapshot` returns: plain functions plus the two Cmd defs to list in `cmds`. |
| `SnapshotLoadCmd` | Type |  |
| `snapshotLoadDef` | Function | The checkpoint-READ Cmd a `requestLoad` decision emits — the recovery half of the module. |
| `SnapshotLoadedMsg` | Type | The Msg the engine mints when a read resolves. |
| `SnapshotLoadFailedMsg` | Type | The Msg the engine mints when a read fails. |
| `SnapshotSavedMsg` | Type | The Msg the engine mints when a write lands. |
| `SnapshotState` | Interface | The snapshot bookkeeping slice. |
| `SnapshotWriteCmd` | Type |  |
| `snapshotWriteDef` | Function | The checkpoint-write Cmd a `record` / `force` decision emits. |
| `Trace` | Interface | A recorded run, sufficient to reproduce it via `../trace-replay`. |
| `traceAttachment` | Function | Serialize a Trace into a Sentry-shaped attachment so a crash event carries the full, replayable run. |
| `TraceAttachment` | Interface | A Sentry-shaped attachment carrying the full Trace as JSONL. |
| `TraceBreadcrumb` | Interface | A Sentry-shaped breadcrumb. |
