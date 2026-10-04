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
  /**
   * Max breadcrumbs to emit. Default `100` (Sentry's own default breadcrumb
   * cap). When the trace has more msgs than `limit`, the OLDEST are dropped —
   * the returned list is the newest-last tail, matching how a Sentry
   * breadcrumb ring buffer behaves (the crash context is the recent past).
   */
  readonly limit?: number;
  /**
   * Customize each breadcrumb's `message`. Default uses `msg.type`. Provide a
   * serializer to surface a richer one-liner (e.g. include an id). The msg is
   * ALSO always attached verbatim under `data.msg` regardless of this option,
   * so the structured payload is never lost to the string rendering.
   */
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
  /**
   * Snapshot the recording so far as a Trace. Returns a fresh object
   * with copied arrays on every call (callers may slice/replay without
   * affecting the recorder's buffers). Entry values are references to the
   * originals (TEA states/msgs are conventionally immutable).
   *
   * Throws only if called before the boot observe has fired AND no msgs have
   * been recorded — i.e. there is no `finalState` yet. In practice callers
   * `await runtime.ready` before `dump()`, after which boot has fired.
   */
  dump(): Trace<S, M>;
  /**
   * Detach the underlying observer. After `stop()`:
   *   - no new transitions are recorded;
   *   - `dump()` / `toJSONL()` keep working against the buffered contents;
   *   - the recorder holds no observer reference into the runtime.
   *
   * Idempotent — subsequent calls are no-ops.
   */
  stop(): void;
  /**
   * Serialize the recording as JSONL (one JSON object per line) — a streamable
   * format that appends cleanly and survives truncation (a partial tail line
   * is the only loss). The first line is the boot header
   * `{ kind: "boot", state }`; each subsequent line is
   * `{ kind: "step", msg, state }` for one recorded transition.
   *
   * Re-hydrate with parseJSONL.
   *
   * Round-trip fidelity depends on `captureSteps`:
   *   - `captureSteps: true` — every step line carries its non-null
   *     post-state, so `parseJSONL(rec.toJSONL())` reconstructs `steps`
   *     EXACTLY and deep-equals `rec.dump()` (which also has `steps`). Full
   *     per-step fidelity round-trips.
   *   - `captureSteps: false` (default) — interior step lines carry
   *     `state: null` (those post-states were never retained); only the last
   *     step line carries `finalState`. `parseJSONL` then populates `steps`
   *     with just the entries that had a non-null state (the final one), so
   *     the re-hydrated Trace is NOT deep-equal to `rec.dump()` (which has no
   *     `steps`). It is still fully replay-faithful: `loaded`, `msgs`, and
   *     `finalState` are intact. Record with `captureSteps: true` if you need
   *     interior states to survive the round-trip.
   */
  toJSONL(): string;
}
```

<a id="RecorderOptions"></a>

### `RecorderOptions`

```ts
interface RecorderOptions {
  /**
   * When `true`, retain a per-transition `(msg, post-state)` pair in
   * Trace.steps for EVERY recorded transition. Default `false`.
   *
   * Size vs. fidelity — the precise trade-off:
   *
   *   - `captureSteps: false` (default) — the MINIMAL replay-faithful trace.
   *     The recorder keeps `loaded` (boot state), the ordered `msgs`, and
   *     `finalState`. That is exactly what `../trace-replay` needs to refold
   *     the run and diff the result. Memory is O(msgs) — one msg ref each, no
   *     per-step state snapshot. `dump().steps` is `undefined`; in JSONL,
   *     interior step lines carry `state: null` (the post-states were never
   *     retained) and only the LAST step line carries `finalState`. A trace
   *     dumped this way REPLAYS correctly but cannot answer "what was the
   *     state after step 3?".
   *
   *   - `captureSteps: true` — the FULL-fidelity trace. The recorder also
   *     snapshots the post-transition state for every msg, so `dump().steps`
   *     holds `{ msg, state }` for every transition (post-state) and
   *     `toJSONL()` emits a non-null `state` on every step line. Memory is
   *     O(msgs × |state|) — a state ref per transition (refs, not deep
   *     copies; TEA states are conventionally immutable, so the runtime's
   *     post-transition state object is retained by reference). This is the
   *     mode for per-step inspection and for a JSONL file that round-trips
   *     `steps` exactly via parseJSONL.
   *
   * Replay fidelity is identical in both modes — `../trace-replay` reads
   * `loaded` + `msgs` + `finalState` only and never touches `steps`. The
   * choice is purely "do I also want to inspect intermediate states?".
   */
  readonly captureSteps?: boolean;
  /**
   * Fraction of msgs to record, in `(0, 1]`. Default `1` (record everything).
   *
   * IMPORTANT — sampling breaks replay fidelity. A sampled trace DROPS msgs,
   * so its `msgs` array is no longer the complete input sequence and
   * `replayTrace` will NOT reproduce `finalState`. Sampling exists for
   * VOLUME STATISTICS (how much traffic, msg-type distribution), not for
   * faithful replay. Use the default `1` for any trace you intend to replay.
   *
   * The boot observe (`msg === null`) is ALWAYS recorded regardless of
   * `sampleRate` — `loaded` and `finalState` are anchors, not samples.
   */
  readonly sampleRate?: number;
}
```

<a id="ReplayResult"></a>

### `ReplayResult`

```ts
interface ReplayResult<S> {
  /** The state the current reducer produced for the same input. */
  actual: S;
  /**
   * Present iff `matches` is `false`. The FIRST point of divergence found by
   * a deterministic pre-order walk:
   *   - `path`     — a dotted/indexed access path from the state root, e.g.
   *                  `state.queue[2].status` or `state` for a root-level
   *                  scalar mismatch.
   *   - `expected` — the recorded value at that path.
   *   - `actual`   — the recomputed value at that path.
   */
  divergence?: {
    actual: unknown;
    expected: unknown;
    path: string;
  };
  /** The trace's recorded `finalState` — what the run originally produced. */
  expected: S;
  /** `true` iff the recomputed final state deep-equals the trace's `finalState`. */
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
  /**
   * Write a checkpoint once this many progress units have accumulated since the
   * last write. `every: 1` checkpoints on every `record`; a value `<= 0` is
   * treated as `1` (every progress unit triggers a write) — a non-positive
   * cadence has no other sensible meaning, and clamping keeps `record` from
   * never checkpointing on a misconfigured `0`.
   */
  readonly every: number;
  /** Store key the rolling checkpoint is written under. Defaults to `"@@snapshot"`. */
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
  /** The `snapshot_load` Cmd def — list it in the machine's `cmds`. */
  readonly load: CmdDef<"snapshot_load">;
  /** The `snapshot_write` Cmd def — list it in the machine's `cmds`. */
  readonly write: CmdDef<"snapshot_write">;
  /**
   * Resume after a reload. PURE. Resets `sinceLast` to 0 because any
   * un-checkpointed progress accumulated before the crash is moot — recovery
   * resumes from the last DURABLE checkpoint, so the cadence counter starts
   * fresh from there. `seq` / `lastSavedSeq` / `lastSavedAt` are preserved
   * (they describe what is durable, which a reload does not change). Call from
   * a `boot` Msg the host dispatches once after `run(...)`, never from `init`'s
   * rehydrate branch (invariant 2).
   *
   * Returns the reducer-cell shape `readonly [SnapshotState, readonly Cmd[]]`
   * (with `Cmd.none` — a resume emits nothing) so it drops straight into a
   * `snapshot_load_ok` cell.
   */
  boot(state: SnapshotState): readonly [SnapshotState, readonly Cmd[]];
  /**
   * Record a confirmed durable write. PURE. Advances `lastSavedSeq` /
   * `lastSavedAt` to the acknowledged write's `seq` / `at`, but only forward:
   * an out-of-order acknowledgement of an OLDER `seq` (a slow write landing
   * after a newer one) is ignored, so the confirmed watermark is monotonic.
   * Fold the `snapshot_write_ok` Msg here.
   *
   * Returns the reducer-cell shape `readonly [SnapshotState, readonly Cmd[]]`
   * (with `Cmd.none` — an ack emits nothing) for uniformity with every sibling
   * knob, so it drops straight into a `snapshot_write_ok` cell.
   */
  confirm(
    state: SnapshotState,
    msg: SnapshotSavedMsg<V>,
  ): readonly [SnapshotState, readonly Cmd[]];
  /**
   * Force a checkpoint regardless of the cadence counter. PURE. Always bumps
   * `seq`, resets `sinceLast`, and emits the write Cmd. Use on a phase boundary
   * the cadence would otherwise miss — e.g. "the run just finished, checkpoint
   * the terminal state now" — so the last durable checkpoint is the final state,
   * not whatever the modulo happened to land on.
   */
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
  /** The initial slice — zero progress, no checkpoint emitted or confirmed yet. */
  init(): SnapshotState;
  /**
   * Account one unit of progress. PURE. Increments `sinceLast`; once the
   * accumulated count reaches the configured cadence, DECIDES to checkpoint:
   * resets `sinceLast` to 0, bumps `seq`, and emits a single `snapshot_write`
   * Cmd carrying `payload` + `key` + the new `seq` + `at`. Below the cadence it
   * returns the bumped slice and NO Cmd.
   *
   * `payload` is the checkpoint value to persist (the consumer's domain state);
   * `at` is the caller-stamped time the progress occurred (epoch ms) — injected,
   * never read from the clock here.
   */
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
  /**
   * Ask the store for the durable checkpoint. PURE. Emits a single
   * `snapshot_load` Cmd carrying the configured `key`; returns the slice
   * UNCHANGED (a read decides nothing about the cadence bookkeeping — only the
   * later `snapshot_load_ok` fold, via `boot`, touches the slice). This is the
   * entry point of the recovery loop: the consumer dispatches a `boot` Msg once
   * after `run(...)` and folds `requestLoad` there.
   */
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
  /**
   * The last observed state. The oracle: `replayTrace` deep-compares its
   * recomputed final state against this. Equal ⇒ the reducer still produces
   * the same result for this input.
   */
  readonly finalState: S;
  /**
   * The initial state captured at the boot observe (the transition where
   * `msg === null`). Fed back to replay as `loaded` so `init(loaded, ctx)`
   * reproduces the exact starting point. `null` only if the recorder attached
   * AFTER boot (it missed the boot observe) — replay then re-runs fresh `init`.
   */
  readonly loaded: S | null;
  /** The ordered, non-null msgs as observed. The replay input sequence. */
  readonly msgs: readonly M[];
  /**
   * Per-transition `(msg, post-state)` pairs, in dispatch order, for human
   * inspection (e.g. "show me the state after step 3"). When present, there
   * is exactly one entry per recorded msg and `state` is the POST-transition
   * state for that msg (so `steps[i].msg === msgs[i]` and `steps.at(-1).state`
   * deep-equals `finalState`). NOT required for replay — replay only needs
   * `loaded` + `msgs` + `finalState`.
   *
   * Present iff the recorder was created with `captureSteps: true`, OR the
   * Trace was re-hydrated from JSONL via parseJSONL (the JSONL format
   * carries per-step state, so the parser populates `steps` whenever a step
   * line had a non-null state). A trace dumped with `captureSteps: false` has
   * `steps === undefined`.
   */
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
