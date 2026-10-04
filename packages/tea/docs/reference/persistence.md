# @demlik/tea/persistence

> the durability batteries: record a run to a trace, replay that trace back, and checkpoint a long-running machine to a host store between evictions.

Tier: `battery`

```ts
import { … } from "@demlik/tea/persistence";
```

## Exports (25)

| Symbol | Kind | Tier | Summary |
| --- | --- | --- | --- |
| [`breadcrumbsFromTrace`](#breadcrumbsFromTrace) | Function | battery | Project a Trace's recorded msgs into Sentry-shaped breadcrumbs — a human-readable timeline of "what happened before the crash". |
| [`BreadcrumbsOptions`](#BreadcrumbsOptions) | Interface | battery | Options for breadcrumbsFromTrace. |
| [`createSnapshot`](#createSnapshot) | Function | battery | Create a snapshot knob from a `SnapshotConfig`. |
| [`deepEqual`](#deepEqual) | Function | battery | Order-insensitive structural deep-equality — the comparator the record/replay lane owns, exposed so consumers (e.g. |
| [`parseJSONL`](#parseJSONL) | Function | battery | Re-hydrate a Trace from the JSONL produced by Recorder.toJSONL. |
| [`recorder`](#recorder) | Function | battery | Attach a recorder to a Runtime. |
| [`Recorder`](#Recorder) | Interface | battery | A live recorder attached to a Runtime. |
| [`RecorderOptions`](#RecorderOptions) | Interface | battery | Options for recorder. |
| [`ReplayResult`](#ReplayResult) | Interface | battery | The outcome of replayTrace. |
| [`replayTrace`](#replayTrace) | Function | battery | Replay a recorded Trace against `machine` and diff the recomputed final state against the recorded one. |
| [`SnapshotConfig`](#SnapshotConfig) | Interface | battery | The snapshot knob. |
| [`SnapshotFailedMsg`](#SnapshotFailedMsg) | Type | battery | The Msg the engine mints when a write fails. |
| [`SnapshotKnob`](#SnapshotKnob) | Interface | battery | The bundle `createSnapshot` returns: plain functions plus the two Cmd defs to list in `cmds`. |
| [`SnapshotLoadCmd`](#SnapshotLoadCmd) | Type | battery | The Cmd `requestLoad` emits to read the checkpoint saved under `key`. |
| [`snapshotLoadDef`](#snapshotLoadDef) | Function | battery | The checkpoint-READ Cmd a `requestLoad` decision emits — the recovery half of the module. |
| [`SnapshotLoadedMsg`](#SnapshotLoadedMsg) | Type | battery | The Msg the engine mints when a read resolves. |
| [`SnapshotLoadFailedMsg`](#SnapshotLoadFailedMsg) | Type | battery | The Msg the engine mints when a read fails. |
| [`SnapshotSavedMsg`](#SnapshotSavedMsg) | Type | battery | The Msg the engine mints when a write lands. |
| [`SnapshotState`](#SnapshotState) | Interface | battery | The snapshot bookkeeping slice. |
| [`SnapshotWriteCmd`](#SnapshotWriteCmd) | Type | battery | The Cmd a snapshot decision emits to write a checkpoint: `payload` under `key`, at sequence `seq`. |
| [`snapshotWriteDef`](#snapshotWriteDef) | Function | battery | The checkpoint-write Cmd a `record` / `force` decision emits. |
| [`Trace`](#Trace) | Interface | battery | A recorded run, sufficient to reproduce it via `../trace-replay`. |
| [`traceAttachment`](#traceAttachment) | Function | battery | Serialize a Trace into a Sentry-shaped attachment so a crash event carries the full, replayable run. |
| [`TraceAttachment`](#TraceAttachment) | Interface | battery | A Sentry-shaped attachment carrying the full Trace as JSONL. |
| [`TraceBreadcrumb`](#TraceBreadcrumb) | Interface | battery | A Sentry-shaped breadcrumb. |

## Declarations

<a id="breadcrumbsFromTrace"></a>

### `breadcrumbsFromTrace`

```ts
function breadcrumbsFromTrace<S, M extends { type: string }>(
  trace: Trace<S, M>,
  opts?: BreadcrumbsOptions<M>,
): TraceBreadcrumb[]
```

<a id="BreadcrumbsOptions"></a>

### `BreadcrumbsOptions`

```ts
interface BreadcrumbsOptions<M> {
  readonly limit?: number;
  readonly serialize?: (msg: M) => string;
}
```

<a id="createSnapshot"></a>

### `createSnapshot`

```ts
function createSnapshot<V>(config: SnapshotConfig): SnapshotKnob<V>
```

<a id="deepEqual"></a>

### `deepEqual`

```ts
function deepEqual(a: unknown, b: unknown): boolean
```

<a id="parseJSONL"></a>

### `parseJSONL`

```ts
function parseJSONL<S, M>(jsonl: string): Trace<S, M>
```

<a id="recorder"></a>

### `recorder`

```ts
function recorder<S, M extends { type: string }>(
  runtime: BootingRuntime<S, M>,
  opts?: RecorderOptions,
): Recorder<S, M>
```

<a id="Recorder"></a>

### `Recorder`

```ts
interface Recorder<S, M> {
  dump(): Trace<S, M>;
  stop(): void;
  toJSONL(): string;
}
```

<a id="RecorderOptions"></a>

### `RecorderOptions`

```ts
interface RecorderOptions {
  readonly captureSteps?: boolean;
  readonly sampleRate?: number;
}
```

<a id="ReplayResult"></a>

### `ReplayResult`

```ts
interface ReplayResult<S> {
  actual: S;
  divergence?: {
    actual: unknown;
    expected: unknown;
    path: string;
  };
  expected: S;
  matches: boolean;
}
```

<a id="replayTrace"></a>

### `replayTrace`

```ts
function replayTrace<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  trace: Trace<S, M>,
  ctx: Ctx,
): ReplayResult<S>
```

<a id="SnapshotConfig"></a>

### `SnapshotConfig`

```ts
interface SnapshotConfig {
  readonly every: number;
  readonly key?: string;
}
```

<a id="SnapshotFailedMsg"></a>

### `SnapshotFailedMsg`

```ts
type SnapshotFailedMsg<V = unknown> = SettledErr<"snapshot_write", SnapshotWriteCmd<V>, TaggedError<"snapshot_write_failed">>
```

<a id="SnapshotKnob"></a>

### `SnapshotKnob`

```ts
interface SnapshotKnob<V> {
  readonly load: CmdDef<"snapshot_load">;
  readonly write: CmdDef<"snapshot_write">;
  boot(state: SnapshotState): readonly [SnapshotState, readonly Cmd[]];
  confirm(
    state: SnapshotState,
    msg: SnapshotSavedMsg<V>,
  ): readonly [SnapshotState, readonly Cmd[]];
  force(
    state: SnapshotState,
    payload: V,
    at: number,
  ): readonly [SnapshotState, readonly CmdValue<"snapshot_write", {
    readonly at: number;
    readonly key: string;
    readonly payload: V;
    readonly seq: number;
  }, undefined, {
    readonly [detail: string]: unknown;
    readonly _tag: "snapshot_write_failed";
  }>[]];
  init(): SnapshotState;
  record(
    state: SnapshotState,
    payload: V,
    at: number,
  ): readonly [SnapshotState, readonly CmdValue<"snapshot_write", {
    readonly at: number;
    readonly key: string;
    readonly payload: V;
    readonly seq: number;
  }, undefined, {
    readonly [detail: string]: unknown;
    readonly _tag: "snapshot_write_failed";
  }>[]];
  requestLoad(
    state: SnapshotState,
  ): readonly [SnapshotState, readonly CmdValue<"snapshot_load", { readonly key: string }, V | null, {
    readonly [detail: string]: unknown;
    readonly _tag: "snapshot_load_failed";
  }>[]];
}
```

<a id="SnapshotLoadCmd"></a>

### `SnapshotLoadCmd`

```ts
type SnapshotLoadCmd<V = unknown> = CmdOf<ReturnType<typeof snapshotLoadDef>>
```

<a id="snapshotLoadDef"></a>

### `snapshotLoadDef`

```ts
function snapshotLoadDef<V>(): CmdDef<"snapshot_load", { readonly key: string }, V | null, {
  readonly [detail: string]: unknown;
  readonly _tag: "snapshot_load_failed";
}>
```

<a id="SnapshotLoadedMsg"></a>

### `SnapshotLoadedMsg`

```ts
type SnapshotLoadedMsg<V> = SettledOk<"snapshot_load", SnapshotLoadCmd<V>, V | null>
```

<a id="SnapshotLoadFailedMsg"></a>

### `SnapshotLoadFailedMsg`

```ts
type SnapshotLoadFailedMsg<V = unknown> = SettledErr<"snapshot_load", SnapshotLoadCmd<V>, TaggedError<"snapshot_load_failed">>
```

<a id="SnapshotSavedMsg"></a>

### `SnapshotSavedMsg`

```ts
type SnapshotSavedMsg<V = unknown> = SettledOk<"snapshot_write", SnapshotWriteCmd<V>, undefined>
```

<a id="SnapshotState"></a>

### `SnapshotState`

```ts
interface SnapshotState {
  readonly lastSavedAt: number | null;
  readonly lastSavedSeq: number | null;
  readonly seq: number;
  readonly sinceLast: number;
}
```

<a id="SnapshotWriteCmd"></a>

### `SnapshotWriteCmd`

```ts
type SnapshotWriteCmd<V> = CmdOf<ReturnType<typeof snapshotWriteDef>>
```

<a id="snapshotWriteDef"></a>

### `snapshotWriteDef`

```ts
function snapshotWriteDef<V>(): CmdDef<"snapshot_write", {
  readonly at: number;
  readonly key: string;
  readonly payload: V;
  readonly seq: number;
}, undefined, {
  readonly [detail: string]: unknown;
  readonly _tag: "snapshot_write_failed";
}>
```

<a id="Trace"></a>

### `Trace`

```ts
interface Trace<S, M> {
  readonly finalState: S;
  readonly loaded: S | null;
  readonly msgs: readonly M[];
  readonly steps?: readonly { readonly msg: M; readonly state: S }[];
}
```

<a id="traceAttachment"></a>

### `traceAttachment`

```ts
function traceAttachment<S, M extends { type: string }>(
  trace: Trace<S, M>,
): TraceAttachment
```

<a id="TraceAttachment"></a>

### `TraceAttachment`

```ts
interface TraceAttachment {
  readonly contentType: string;
  readonly data: string;
  readonly filename: string;
}
```

<a id="TraceBreadcrumb"></a>

### `TraceBreadcrumb`

```ts
interface TraceBreadcrumb {
  readonly category: string;
  readonly data?: Record<string, unknown>;
  readonly level: string;
  readonly message: string;
  readonly type: string;
}
```
