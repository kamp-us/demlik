/**
 * @demlik/tea/snapshot — periodic state checkpoint to a host store (R2/KV-shaped).
 *
 * The problem it solves: a long-running machine (a multi-stage run, a paginated
 * crawl, a saga) lives in TEA's in-memory `State` and is persisted as ONE blob
 * by the substrate's `Store<S>` on every transition. That blob is fine for
 * crash recovery of the *runtime* — but it is NOT a coarse, named checkpoint a
 * human (or a separate recovery job) can point a restart at. `snapshot` adds
 * the "every N units of progress, write a durable checkpoint to R2/KV"
 * discipline on top, so a crashed long run restarts from the last checkpoint
 * instead of from zero (the field-guide pain row).
 *
 * Shape: this is the same knob contract every L2 composition follows —
 * `createSnapshot(config)` hands back a `{ init, <verbs>, handlers }` bundle you
 * splice into your machine. The state it owns is a Model slice (durable +
 * replayable, the two non-negotiables); the verbs are PURE decisions; the I/O
 * (the actual `put` to the store) lives only in `handlers`.
 *
 * It is a LEAF module: it imports only the core substrate (`../index`, for
 * `Cmd` / `Interpret`) and no sibling subpath. (It does NOT reuse
 * `@demlik/tea/retry-backoff` — that is an even-leafier utility that depends on
 * nothing at all, not even the core; the kinship here is "leaf with injected
 * time", not a shared dependency.)
 * Nothing here reads the clock or the RNG on its own behalf — time enters as an
 * `at`/`now` parameter at the verb boundary and the store I/O is realized only
 * when the runtime performs the emitted `Cmd`. That keeps every verb
 * deterministic (invariant 2) and the checkpoint write a `Cmd` the runtime
 * interprets (invariant 3).
 *
 * The Store port is deliberately ABSTRACT — `{ get, put }`, the lowest common
 * shape of R2 and KV — so this module never imports `@cloudflare/workers-types`
 * and can be checkpointed to anything (R2, KV, a DO sub-key, an in-memory map in
 * tests). The host binds the concrete adapter at `handlers({ store })`.
 *
 * Typical wiring:
 *
 *   const snap = createSnapshot<RunState>({ every: 25, key: "run/checkpoint" });
 *
 *   // machine state:
 *   type State = { run: RunState; snapshot: SnapshotState };
 *   init: (loaded) => loaded ? [loaded, []] : [{ run: initRun(), snapshot: snap.init() }, []],
 *
 *   // in `update`, on each progress Msg, fold the snapshot slice:
 *   progress: (s, msg) => {
 *     const run = advance(s.run, msg);
 *     const [snapshot, cmds] = snap.record(s.snapshot, run, msg.at);
 *     return [{ ...s, run, snapshot }, cmds];
 *   },
 *   // the write completed → durable ack folds back through update:
 *   snapshot_saved: (s, msg) => {
 *     const [snapshot, cmds] = snap.confirm(s.snapshot, msg);
 *     return [{ ...s, snapshot }, cmds];
 *   },
 *
 *   // RECOVERY — the half that makes a checkpoint a restart point, not just a
 *   // backup. A `boot` Msg the host dispatches once after `run(...)` asks the
 *   // store for the durable checkpoint; the answer folds the recovered payload
 *   // back into the run slice:
 *   boot: (s) => snap.requestLoad(s),                       // emits snapshot_load Cmd
 *   snapshot_loaded: (s, msg) => {
 *     if (msg.payload === null) return [s, []];             // no checkpoint → keep fresh init
 *     const [snapshot, cmds] = snap.boot(s.snapshot);
 *     return [{ ...s, run: msg.payload, snapshot }, cmds];
 *   },
 *   snapshot_load_failed: (s) => [s, []],                   // errors are data — decide here
 *
 *   // splice the I/O — both effect cells (write + load):
 *   interpret: { ...snap.handlers({ store: r2Adapter }) },
 */

import { Cmd, type Interpret, tryInterpret } from "../index";

// ─────────────────────────────────────────────────────────────────────────────
// Config — the knob.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The snapshot knob.
 *
 * `every` is the cadence: a checkpoint is written once `every` units of
 * progress have accumulated since the last one (see `record`). It is the
 * `snapshotEvery` field `monitored-run` threads through to this module.
 *
 * `key` is the store key the checkpoint is written under. A single machine
 * keeps a single rolling checkpoint, so the key is fixed at config time rather
 * than passed per write — the latest checkpoint overwrites the previous one
 * (R2/KV are last-write-wins on a key). Defaults to `"@@snapshot"`, mirroring
 * `doStore`'s `@@state` default-key convention.
 */
export interface SnapshotConfig {
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

const DEFAULT_SNAPSHOT_KEY = "@@snapshot";

// ─────────────────────────────────────────────────────────────────────────────
// Slice — the Model field this knob owns.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The snapshot bookkeeping slice. Plain data — JSON-serializable so it rides
 * inside the consumer's `Store<S>` blob and survives DO eviction / reload (the
 * "durable" non-negotiable). It carries NO payload: the thing being
 * checkpointed lives elsewhere in the machine's state; this slice only tracks
 * *when* to checkpoint and *what has been acknowledged durable*.
 *
 *   - `sinceLast` — progress units accumulated since the last checkpoint
 *     DECISION (reset to 0 the moment `record` decides to write, not when the
 *     write lands). The cadence counter.
 *   - `seq` — monotonic checkpoint sequence. Bumped each time a write is
 *     emitted, so the write Cmd and its later acknowledgement can be matched
 *     even if several are in flight. The "version" of the latest emitted
 *     checkpoint.
 *   - `lastSavedSeq` — the highest `seq` whose write the host has confirmed
 *     durable (via `confirm`). `null` until the first confirmed write. The gap
 *     `seq - lastSavedSeq` is the "writes emitted but not yet acknowledged"
 *     depth — observable for backpressure / health.
 *   - `lastSavedAt` — the `at` of the most recent confirmed write (epoch ms),
 *     `null` until the first. Carried for observability, never compared inside
 *     a verb (time is injected, never read here).
 */
export interface SnapshotState {
  readonly sinceLast: number;
  readonly seq: number;
  readonly lastSavedSeq: number | null;
  readonly lastSavedAt: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Store port — abstract R2/KV-shaped checkpoint sink.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The abstract checkpoint sink — the intersection of R2's and KV's surface,
 * narrowed to exactly the two methods a rolling checkpoint needs. Deliberately
 * NOT the substrate's `Store<S>` (`{ load, save, migrate }`): that is the
 * runtime's whole-state persistence boundary keyed at a fixed cell, whereas a
 * checkpoint store is keyed, value-typed, and host-supplied.
 *
 *   - `put(key, value)` — write the checkpoint. Last-write-wins on `key`.
 *   - `get(key)` — read the latest checkpoint back, or `null` if none. Used by
 *     a recovery path to seed `init`'s `loaded` from the durable checkpoint
 *     when the runtime's own `Store<S>` blob is gone.
 *
 * No `@cloudflare/workers-types` import — an R2 bucket, a KV namespace, a DO
 * sub-key, or an in-memory `Map` all satisfy this shape with a 3-line adapter
 * at the host.
 */
export interface SnapshotStore<V> {
  get(key: string): Promise<V | null>;
  put(key: string, value: V): Promise<void>;
}

/**
 * The ports `handlers` binds. Just the store today — named so a future port
 * (a metrics sink, a clock) can grow without breaking the `handlers(ports)`
 * call shape.
 */
export interface SnapshotPorts<V> {
  readonly store: SnapshotStore<V>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cmd + Msg — the write effect and its durable acknowledgement.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The checkpoint-write Cmd a `record` / `force` decision emits. Plain data
 * (invariant 1 — Cmds are data, not closures): it carries the `payload` to
 * write, the `key` to write it under, the `seq` it represents, and the `at` it
 * was decided. The handler performs the `put` and routes the result back to a
 * `confirm` / fail Msg.
 *
 * `payload` is `V` — the consumer's serializable checkpoint value (the run
 * state, the cursor, whatever the machine wants restartable). The verb takes it
 * as an argument so the snapshot slice never has to hold a copy of the
 * machine's domain state.
 */
export type SnapshotWriteCmd<V> = Cmd<"snapshot_write"> & {
  readonly key: string;
  readonly seq: number;
  readonly at: number;
  readonly payload: V;
};

/**
 * The Msg the write handler dispatches on a SUCCESSFUL `put`. Fold it back
 * through `confirm(state, msg)` to advance `lastSavedSeq` / `lastSavedAt`. The
 * `seq` matches the emitting Cmd so a late acknowledgement of an older write
 * can never regress a newer confirmed one.
 */
export type SnapshotSavedMsg = {
  readonly type: "snapshot_saved";
  readonly seq: number;
  readonly at: number;
};

/**
 * The Msg the write handler dispatches on a FAILED `put`. Errors are data
 * (never swallowed): the consumer's reducer decides whether a failed checkpoint
 * is fatal, retryable (compose `@demlik/tea/retry-backoff`), or merely logged.
 * `seq` identifies which checkpoint failed; `error` is carried, never
 * interpreted here.
 */
export type SnapshotFailedMsg = {
  readonly type: "snapshot_failed";
  readonly seq: number;
  readonly error: unknown;
};

/**
 * The checkpoint-READ Cmd a `requestLoad` decision emits — the recovery half of
 * the module. Plain data (invariant 1): it carries only the `key` to read. The
 * handler performs `store.get(key)` and routes the result back to a
 * `snapshot_loaded` (Ok, payload-or-null) / `snapshot_load_failed` (Err) Msg.
 *
 * Distinct from `snapshot_write`: a write carries a payload OUT to the store; a
 * load asks the store to hand a payload BACK. The consumer dispatches the
 * triggering Msg once on resume (a `boot` Msg, never `init`'s rehydrate branch —
 * invariant 2), folds the recovered payload into its run slice, then continues.
 */
export type SnapshotLoadCmd = Cmd<"snapshot_load"> & {
  readonly key: string;
};

/**
 * The Msg the load handler dispatches when `store.get` RESOLVES. `payload` is
 * the recovered checkpoint value, or `null` when the store has no checkpoint
 * under `key` (fresh boot — never checkpointed, or a wiped store). The consumer
 * folds this into `init`'s loaded branch: `payload === null` → keep the fresh
 * `init` state; non-null → seed the run slice from the durable checkpoint and
 * `boot` the snapshot slice's cadence counter.
 *
 * A `null` payload is NOT an error — "no checkpoint yet" is a normal first-run
 * state, distinct from "the read failed" (`snapshot_load_failed`).
 */
export type SnapshotLoadedMsg<V> = {
  readonly type: "snapshot_loaded";
  readonly payload: V | null;
};

/**
 * The Msg the load handler dispatches when `store.get` REJECTS. Errors are data
 * (never swallowed — the field-guide rule): a failed recovery read is a visible
 * signal the consumer's reducer decides on (fatal-abort, retry via
 * `@demlik/tea/retry-backoff`, or boot-fresh-and-log). `error` is carried, never
 * interpreted here. Kept separate from `snapshot_loaded`'s `null` so "the store
 * has no checkpoint" can never masquerade as "the read failed".
 */
export type SnapshotLoadFailedMsg = {
  readonly type: "snapshot_load_failed";
  readonly error: unknown;
};

/** Construct a `snapshot_saved` Msg. Shared by the handler and tests so the wire shape can't drift. */
export function snapshotSaved(seq: number, at: number): SnapshotSavedMsg {
  return { type: "snapshot_saved", seq, at };
}

/** Construct a `snapshot_failed` Msg. Shared by the handler and tests so the wire shape can't drift. */
export function snapshotFailed(seq: number, error: unknown): SnapshotFailedMsg {
  return { type: "snapshot_failed", seq, error };
}

/** Construct a `snapshot_loaded` Msg. Shared by the handler and tests so the wire shape can't drift. */
export function snapshotLoaded<V>(payload: V | null): SnapshotLoadedMsg<V> {
  return { type: "snapshot_loaded", payload };
}

/** Construct a `snapshot_load_failed` Msg. Shared by the handler and tests so the wire shape can't drift. */
export function snapshotLoadFailed(error: unknown): SnapshotLoadFailedMsg {
  return { type: "snapshot_load_failed", error };
}

// ─────────────────────────────────────────────────────────────────────────────
// The combinator.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The bundle `createSnapshot` returns — the uniform knob contract. `subs` is
 * omitted: a checkpoint is driven by progress (a `record` call from the
 * consumer's reducer), not by a timer, so this module has no subscriptions.
 */
export interface SnapshotKnob<V> {
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
  ): readonly [SnapshotState, readonly Cmd[]];
  /**
   * Record a confirmed durable write. PURE. Advances `lastSavedSeq` /
   * `lastSavedAt` to the acknowledged `seq` / `at`, but only forward: an
   * out-of-order acknowledgement of an OLDER `seq` (a slow write landing after a
   * newer one) is ignored, so the confirmed watermark is monotonic. Fold the
   * `snapshot_saved` Msg here.
   *
   * Returns the reducer-cell shape `readonly [SnapshotState, readonly Cmd[]]`
   * (with `Cmd.none` — an ack emits nothing) for uniformity with every sibling
   * knob, so it drops straight into a `snapshot_saved` cell without the caller
   * re-wrapping a bare State.
   */
  confirm(
    state: SnapshotState,
    msg: SnapshotSavedMsg,
  ): readonly [SnapshotState, readonly Cmd[]];
  /**
   * Resume after a reload. PURE. Resets `sinceLast` to 0 because any
   * un-checkpointed progress accumulated before the crash is moot — recovery
   * resumes from the last DURABLE checkpoint (`get` from the store), so the
   * cadence counter starts fresh from there. `seq` / `lastSavedSeq` /
   * `lastSavedAt` are preserved (they describe what is durable, which a reload
   * does not change). Call from a `boot` Msg the host dispatches once after
   * `run(...)`, never from `init`'s rehydrate branch (invariant 2).
   *
   * Returns the reducer-cell shape `readonly [SnapshotState, readonly Cmd[]]`
   * (with `Cmd.none` — a resume emits nothing) for uniformity with every sibling
   * knob, so it drops straight into a `snapshot_loaded` cell without the caller
   * re-wrapping a bare State.
   */
  boot(state: SnapshotState): readonly [SnapshotState, readonly Cmd[]];
  /**
   * Ask the store for the durable checkpoint. PURE. Emits a single
   * `snapshot_load` Cmd carrying the configured `key`; returns the slice
   * UNCHANGED (a read decides nothing about the cadence bookkeeping — only the
   * later `snapshot_loaded` fold, via `boot`, touches the slice). This is the
   * entry point of the recovery loop: the consumer dispatches a `boot` Msg once
   * after `run(...)`, folds `requestLoad` here, and the emitted Cmd's handler
   * reads `store.get(key)` and dispatches `snapshot_loaded` / `snapshot_load_failed`.
   *
   * Returns `readonly [SnapshotState, readonly Cmd[]]` (the reducer-cell shape)
   * so it drops straight into a `boot: (s) => snap.requestLoad(s)` cell.
   */
  requestLoad(state: SnapshotState): readonly [SnapshotState, readonly Cmd[]];
  /**
   * The `interpret` map for this knob's two effect Cmds:
   *
   *   - `snapshot_write` — binds the store and performs the `put`, routing
   *     Ok → `snapshot_saved` / Err → `snapshot_failed`.
   *   - `snapshot_load`  — binds the store and performs the `get`, routing
   *     Ok → `snapshot_loaded` (payload-or-null) / Err → `snapshot_load_failed`.
   *
   * Railway throughout — neither effect throws into the runtime; the outcome is
   * always a Msg. Spread into your machine's `interpret`.
   */
  handlers(
    ports: SnapshotPorts<V>,
  ): Interpret<
    | SnapshotSavedMsg
    | SnapshotFailedMsg
    | SnapshotLoadedMsg<V>
    | SnapshotLoadFailedMsg,
    SnapshotWriteCmd<V> | SnapshotLoadCmd,
    unknown
  >;
}

/**
 * Create a snapshot knob from a `SnapshotConfig`. The returned bundle is spliced
 * into a consumer machine: `init()` seeds the slice, `record` / `force` are
 * folded in reducer cells, `confirm` / `boot` handle the acknowledgement +
 * resume Msgs, and `handlers({ store })` supplies the write `interpret` cell.
 */
export function createSnapshot<V>(config: SnapshotConfig): SnapshotKnob<V> {
  // Clamp the cadence to >= 1 at construction so `record`'s threshold check is
  // branchless and a misconfigured `0` / negative `every` checkpoints on every
  // progress unit instead of never.
  const every = config.every >= 1 ? config.every : 1;
  const key = config.key ?? DEFAULT_SNAPSHOT_KEY;

  /**
   * Emit the write Cmd for a checkpoint decision. Shared by `record`'s
   * cadence-hit branch and `force`. Bumps `seq`, resets `sinceLast`, returns the
   * new slice + the single `snapshot_write` Cmd. The input slice is never
   * mutated (invariant 1).
   */
  function emitWrite(
    state: SnapshotState,
    payload: V,
    at: number,
  ): readonly [SnapshotState, readonly Cmd[]] {
    const seq = state.seq + 1;
    const next: SnapshotState = { ...state, sinceLast: 0, seq };
    const cmd: SnapshotWriteCmd<V> = {
      type: "snapshot_write",
      key,
      seq,
      at,
      payload,
    };
    return [next, [cmd]];
  }

  return {
    init(): SnapshotState {
      return { sinceLast: 0, seq: 0, lastSavedSeq: null, lastSavedAt: null };
    },

    record(state, payload, at) {
      const sinceLast = state.sinceLast + 1;
      // Below the cadence: accumulate, emit nothing.
      if (sinceLast < every) {
        return [{ ...state, sinceLast }, Cmd.none];
      }
      // Cadence reached: checkpoint. `emitWrite` resets the counter + bumps seq.
      return emitWrite(state, payload, at);
    },

    force(state, payload, at) {
      return emitWrite(state, payload, at);
    },

    confirm(state, msg) {
      // Forward-only watermark: ignore a stale ack of an older seq so a slow
      // write landing after a newer one can't regress `lastSavedSeq`.
      if (state.lastSavedSeq !== null && msg.seq <= state.lastSavedSeq) {
        return [state, Cmd.none];
      }
      return [
        { ...state, lastSavedSeq: msg.seq, lastSavedAt: msg.at },
        Cmd.none,
      ];
    },

    boot(state) {
      return [{ ...state, sinceLast: 0 }, Cmd.none];
    },

    requestLoad(state) {
      // A read decides nothing about the cadence bookkeeping — return the slice
      // unchanged and emit the single read Cmd. The recovered payload folds back
      // through `snapshot_loaded` (the consumer's reducer), not here.
      const cmd: SnapshotLoadCmd = { type: "snapshot_load", key };
      return [state, [cmd]];
    },

    handlers(ports) {
      const { store } = ports;
      return {
        // The write effect. Performs the `put`; on success the saved `seq`/`at`
        // ride the `snapshot_saved` Msg back into `confirm`; on failure the
        // error rides `snapshot_failed`. Railway via the core's `tryInterpret`
        // (matching every other module's handler) — the handler always resolves
        // with a Msg, never rejects into the runtime.
        snapshot_write: tryInterpret<
          SnapshotWriteCmd<V>,
          void,
          SnapshotSavedMsg | SnapshotFailedMsg,
          unknown
        >(
          (cmd) => store.put(cmd.key, cmd.payload),
          (_value, cmd) => snapshotSaved(cmd.seq, cmd.at),
          (error, cmd) => snapshotFailed(cmd.seq, error),
        ),
        // The read effect — the recovery half. Performs the `get`; on success
        // the recovered payload (or `null` when no checkpoint exists) rides the
        // `snapshot_loaded` Msg the consumer folds into `init`'s loaded branch;
        // on failure the error rides `snapshot_load_failed`. Same Railway
        // discipline via `tryInterpret` — the read never rejects into the runtime.
        snapshot_load: tryInterpret<
          SnapshotLoadCmd,
          V | null,
          SnapshotLoadedMsg<V> | SnapshotLoadFailedMsg,
          unknown
        >(
          (cmd) => store.get(cmd.key),
          (payload) => snapshotLoaded(payload),
          (error) => snapshotLoadFailed(error),
        ),
      };
    },
  };
}
