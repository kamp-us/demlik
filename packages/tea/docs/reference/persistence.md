# @demlik/tea/persistence

> the durability batteries: record a run to a trace, replay that trace back, checkpoint a long-running machine to a host store between evictions, and keep a machine's State in a store this subpath ships: `eventSourcedStore`, a durable log over a journal, and `rowStore`, one SQL row fenced by its revision.

Tier: `battery`

```ts
import { … } from "@demlik/tea/persistence";
```

## Check a host-written journal

The experimental K1–K8 kit checks a driver for `eventSourcedStore`: exact record order, exclusive reads, atomic batches, reopen, append cost, stream isolation, optional fencing and torn tails.

```ts
import { journalConformance, type JournalKitFactory } from "@demlik/tea/pbt";
```

Install `@demlik/tea` and `fast-check`. A `JournalKitFactory` creates fresh, isolated storage for each history and returns a fixture with these members:

| Member | Responsibility |
| --- | --- |
| `open()` | Return a fresh driver handle over the fixture's shared storage, including after close/reopen; closing a handle must retain the records. |
| `interruptAt(point)` | Arm a real storage interruption at a point from `writePoints`; `undefined` disarms it. |
| `writePoints(records)` | Return the physical write boundaries to interrupt for this batch, including boundaries around its atomic commit. |
| `dispose()` | Close remaining handles and remove the fixture's storage. |
| `byteFile` | Say whether this driver stores a byte file, enabling K8. |
| `tearTail(stream)` | Required when `byteFile` is true: append an incomplete tail to the stream. |
| `readStoredBytes(stream)` | Required when `byteFile` is true: return its stored bytes so K8 can check that reads leave them unchanged. |

Call `await journalConformance(make, { records: 10000, now: () => performance.now() })`, where `make` is your factory. `records` sets the fixed scale and `now` supplies a monotonic millisecond clock for K5. Each `KitResult` names K1–K8 with a `passed`, `failed` or `skipped` status; `detail` carries diagnostics, including the seed and shrinking path on generated failures. `KitOptions` also accepts `seed`, `runs`, `repeats` and `replay: { id, path }`.

A fenced driver returned by `open()` exposes `fenced: true` and `appendFenced`; the same call then checks K7's atomic expected-head comparison and competing writers. K7 is skipped for plain drivers, and K8 for non-file fixtures. K3, the atomic-batch case, needs the fixture's interruption controls: a fixture whose `writePoints` returns no point gets K3 `failed` with "Fixture exposes no interruption points", and its other results still stand. See [the host fixture and deliberately broken driver](https://github.com/kamp-us/demlik/blob/main/packages/tea/examples/journal-store.ts) for a runnable example.

## Exports (39)

| Symbol | Kind | Tier | Summary |
| --- | --- | --- | --- |
| [`breadcrumbsFromTrace`](#breadcrumbsFromTrace) | Function | battery | Project a Trace's recorded msgs into Sentry-shaped breadcrumbs — a human-readable timeline of "what happened before the crash". |
| [`BreadcrumbsOptions`](#BreadcrumbsOptions) | Interface | battery | Options for breadcrumbsFromTrace. |
| [`createSnapshot`](#createSnapshot) | Function | battery | Create a snapshot knob from a `SnapshotConfig`. |
| [`deepEqual`](#deepEqual) | Function | battery | Order-insensitive structural deep-equality — the comparator the record/replay lane owns, exposed so consumers (e.g. |
| [`EncodedRecord`](#EncodedRecord) | Type | experimental | Opaque well-formed Unicode text preserved exactly by a driver. |
| [`eventSourcedStore`](#eventSourcedStore) | Function | experimental | Plain journal-backed stores require one active writer per stream throughout the loaded activation; concurrent plain writers can corrupt history. |
| [`FencedJournal`](#FencedJournal) | Type | experimental | A journal with an explicit expected-head append capability. |
| [`Journal`](#Journal) | Type | experimental | Ordered storage of opaque text in atomic batches. |
| [`JournalAppend`](#JournalAppend) | Type | experimental | Acknowledged text and positions from one atomic append. |
| [`JournalConflict`](#JournalConflict) | Type | experimental | An expected-head mismatch that changed no storage. |
| [`JournalEntry`](#JournalEntry) | Type | experimental | Opaque text and the position assigned by its journal. |
| [`JournalRead`](#JournalRead) | Type | experimental | A stream's head and the entries after a requested position. |
| [`JournalRefusal`](#JournalRefusal) | Type | experimental | Storage failure data, preserving append uncertainty. |
| [`parseJSONL`](#parseJSONL) | Function | battery | Re-hydrate a Trace from the JSONL produced by Recorder.toJSONL. |
| [`recorder`](#recorder) | Function | battery | Attach a recorder to a Runtime. |
| [`Recorder`](#Recorder) | Interface | battery | A live recorder attached to a Runtime. |
| [`RecorderOptions`](#RecorderOptions) | Interface | battery | Options for recorder. |
| [`ReplayResult`](#ReplayResult) | Interface | battery | The outcome of replayTrace. |
| [`replayStoredTrace`](#replayStoredTrace) | Function | battery | Replay a recording read back from storage, whose states and msgs are plain data not typed as the machine's own. |
| [`replayTrace`](#replayTrace) | Function | battery | Replay a recorded Trace against `machine` and diff the recomputed states against the recorded ones. |
| [`RowPort`](#RowPort) | Interface | experimental | One SQL row, bound by the host to its table and row id (and, when the save must be part of the host's transaction, to that transaction's connection). |
| [`rowStore`](#rowStore) | Function | experimental | A fenced `Store` whose storage is one SQL row: the State lives in the row's own columns, and the fence is the row's revision. |
| [`RowStoreOptions`](#RowStoreOptions) | Interface | experimental | The host's side of the boundary for rowStore. |
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
| [`TraceStep`](#TraceStep) | Interface | battery | One recorded transition: the msg, the State after it, and its Cmds. |
| [`writeTrace`](#writeTrace) | Function | battery | Write a captured Trace into a Store as the frames a live run would have saved: an `init` boundary for `loaded`, then one `step` boundary per recorded transition, each with the State after it and the Cmds it started. |

## Declarations

<a id="breadcrumbsFromTrace"></a>

### `breadcrumbsFromTrace`

```ts
function breadcrumbsFromTrace<S, M extends { _tag: string }>(
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
   * Customize each breadcrumb's `message`. Default uses `msg._tag`. Provide a
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

<a id="EncodedRecord"></a>

### `EncodedRecord`

```ts
type EncodedRecord = string;
```

<a id="eventSourcedStore"></a>

### `eventSourcedStore`

```ts
function eventSourcedStore<S, M extends { _tag: string }, C extends Cmd>(
  journal: FencedJournal,
  options: EventSourcedOptions<S, M, C> & { readonly fenced: true },
): LoggedStore<S, M, C> & FencedStore<S>
function eventSourcedStore<S, M extends { _tag: string }, C extends Cmd>(
  journal: Journal,
  options: EventSourcedOptions<S, M, C> & { readonly fenced?: false },
): LoggedStore<S, M, C>
```

<a id="FencedJournal"></a>

### `FencedJournal`

```ts
interface FencedJournal extends Journal {
  readonly fenced: true;
  appendFenced(
    stream: string,
    records: readonly [EncodedRecord, ...EncodedRecord[]],
    expected: number,
  ): Promise<JournalAppend | JournalRefusal | JournalConflict>;
}
```

<a id="Journal"></a>

### `Journal`

```ts
interface Journal {
  read(stream: string, after: number): Promise<JournalRead | JournalRefusal>;
  append(
    stream: string,
    records: readonly [EncodedRecord, ...EncodedRecord[]],
  ): Promise<JournalAppend | JournalRefusal>;
  close(): Promise<void>;
}
```

<a id="JournalAppend"></a>

### `JournalAppend`

```ts
type JournalAppend = {
  readonly _tag: "appended";
  readonly head: number;
  readonly entries: readonly JournalEntry[];
};
```

<a id="JournalConflict"></a>

### `JournalConflict`

```ts
type JournalConflict = {
  readonly _tag: "journal_conflict";
  readonly expected: number;
  readonly head: number;
};
```

<a id="JournalEntry"></a>

### `JournalEntry`

```ts
type JournalEntry = {
  readonly seq: number;
  readonly record: EncodedRecord;
};
```

<a id="JournalRead"></a>

### `JournalRead`

```ts
type JournalRead = {
  readonly _tag: "read";
  readonly head: number;
  readonly entries: readonly JournalEntry[];
};
```

<a id="JournalRefusal"></a>

### `JournalRefusal`

```ts
type JournalRefusal =
  | {
      readonly _tag: "journal_io";
      readonly operation: "read" | "append";
      readonly message: string;
      readonly uncertain: boolean;
    }
  | { readonly _tag: "journal_corrupt"; readonly message: string };
```

<a id="parseJSONL"></a>

### `parseJSONL`

```ts
function parseJSONL<S, M>(jsonl: string): Trace<S, M>
```

<a id="recorder"></a>

### `recorder`

```ts
function recorder<S, M extends { _tag: string }>(
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
   *     holds `{ msg, state, cmds }` for every transition (post-state and the
   *     Cmds it started) and
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
interface ReplayResult<S, M = unknown> {
  /**
   * The state the current reducer produced for the same input. On a
   * refusal it is the state the refused msg
   * arrived in.
   */
  actual: S;
  /**
   * The Cmds the current reducer started for each replayed msg, in order:
   * `cmds[i]` follows `trace.msgs[i]`, like `states`. Nothing runs them.
   */
  cmds: readonly (readonly Cmd[])[];
  /**
   * Present iff the states differ, or a step's Cmds differ from the recorded
   * ones. The FIRST point of divergence found by a
   * deterministic pre-order walk:
   *   - `path`     — a dotted/indexed access path from the state root, e.g.
   *                  `state.queue[2].status` or `state` for a root-level
   *                  scalar mismatch. When every State matches but a step's
   *                  Cmds do not, the path starts at that step's Cmd list,
   *                  e.g. `cmds[0].total`.
   *   - `expected` — the recorded value at that path.
   *   - `actual`   — the recomputed value at that path.
   *   - `at`       — the first msg after which the recomputed state differs
   *                  from the recorded one. Present when the trace carries
   *                  `steps`; a trace with only a final state can name the
   *                  path but not the msg.
   */
  divergence?: {
    actual: unknown;
    at?: { index: number; msg: M };
    expected: unknown;
    path: string;
  };
  /** The trace's recorded `finalState` — what the run originally produced. */
  expected: S;
  /**
   * `true` iff every recorded msg replayed and the recomputed states match the
   * recording: each step's state when the trace carries `steps`, the final
   * state otherwise.
   */
  matches: boolean;
  /**
   * Present iff the current machine has no update cell for a recorded msg in
   * the state it arrived in: a Msg renamed or removed since the recording, or
   * a cell the state no longer has. Replay stops there; `states` holds the
   * steps before it.
   */
  refusal?: {
    acceptedTypes: readonly string[];
    index: number;
    msg: M;
    stateName: string;
  };
  /**
   * The state the current reducer computed after each replayed msg, in order:
   * `states[i]` follows `trace.msgs[i]`. It stops short of `msgs.length` on a
   * refusal. A viewer draws the session from it as the current code sees it.
   */
  states: readonly S[];
}
```

<a id="replayStoredTrace"></a>

### `replayStoredTrace`

```ts
function replayStoredTrace<
  S,
  M extends { _tag: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  trace: Trace<unknown, { readonly _tag: string }>,
  ctx?: Ctx,
): ReplayResult<unknown, { readonly _tag: string }>
```

<a id="replayTrace"></a>

### `replayTrace`

```ts
function replayTrace<
  S,
  M extends { _tag: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  trace: Trace<S, M>,
  _ctx?: Ctx,
): ReplayResult<S, M>
```

<a id="RowPort"></a>

### `RowPort`

```ts
interface RowPort {
  /** Insert the row with `columns` at revision 1. `true` if inserted; `false`, writing nothing, if a row already exists. */
  insert(columns: Readonly<Record<string, unknown>>): Promise<boolean>;
  /** The row's columns and its revision, or `null` when no row exists. `row` is never `null`, and a revision starts at 1. */
  read(): Promise<{
    readonly revision: number;
    readonly row: unknown;
  } | null>;
  /** Delete the row. Resolves when no row exists, so deleting nothing is fine. */
  remove(): Promise<void>;
  /** Set `columns` and the revision to `expected + 1` where the row's revision is `expected`. `true` if a row changed, `false` if none did. */
  update(columns: Readonly<Record<string, unknown>>, expected: number): Promise<boolean>;
}
```

<a id="rowStore"></a>

### `rowStore`

```ts
function rowStore<S>(
  port: RowPort,
  options: RowStoreOptions<S>,
): FencedStore<S> & DeletableStore<S>
```

<a id="RowStoreOptions"></a>

### `RowStoreOptions`

```ts
interface RowStoreOptions<S> {
  /** `S` to the row's columns. It must not throw. The revision is the port's, never part of the columns. */
  readonly encode: (state: S) => Readonly<Record<string, unknown>>;
  /** Asked for by name, as on every fenced factory (ADR 0017, item 4). There is no unfenced form. */
  readonly fenced: true;
  /** The row's columns to `S`, or `refuse(reason)` for a row it cannot read. It never answers `null`: the row exists, and absence is decided only by `read` returning no row. It is never called with `null`, and it must not throw. */
  readonly parse: (row: unknown) => Refusal | S;
}
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
   * (they describe what is durable, which a reload does not change). A pure
   * restored `init` may use this to return resume State and Cmds. A host `boot`
   * Msg after `run(...)` is an optional protocol; Subs are already open then.
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
   * entry point of the recovery loop: call from pure restored `init` to return
   * resume State and the load Cmd, or from an optional host `boot` Msg after
   * `run(...)`, when Subs are already open.
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
   * The post-init State captured by `onBoot`, used directly as the recorded
   * replay's starting State. No init call is repeated. `null` marks a missing
   * anchor in an older or incomplete trace; `replayTrace` refuses it.
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
   * Trace was re-hydrated via parseJSONL from a JSONL whose every step
   * line carries a state (one written with `captureSteps: true`). A trace
   * dumped with `captureSteps: false` has `steps === undefined`, and so does
   * its JSONL once re-hydrated.
   *
   * `cmds`, when present, is the Cmds that msg's transition started, as the
   * engine reported them. `replayTrace` compares them step by step, so a
   * change that keeps every State but starts different effects is caught.
   */
  readonly steps?: readonly TraceStep<S, M>[];
}
```

<a id="traceAttachment"></a>

### `traceAttachment`

```ts
function traceAttachment<S, M extends { _tag: string }>(
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

<a id="TraceStep"></a>

### `TraceStep`

```ts
interface TraceStep<S, M> {
  readonly cmds?: readonly Cmd[];
  readonly msg: M;
  readonly state: S;
}
```

<a id="writeTrace"></a>

### `writeTrace`

```ts
function writeTrace<S, M extends { readonly _tag: string }>(
  store: Pick<Store<S>, "load" | "save">,
  trace: Trace<S, M>,
): Promise<void>
```
