/**
 * internal/persistence/snapshot — periodic state checkpoint to a host store
 * (R2/KV-shaped). Internal since #49 — not published on any subpath.
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
 * Shape: `createSnapshot(config)` hands back plain functions and two
 * `Cmd.define`d Cmds (`write`, `load`) you call from your own `update` (ADR
 * 0022). The state it owns is a Model slice (durable + replayable, the two
 * non-negotiables); the verbs are PURE decisions; the I/O (the actual `put` /
 * `get` against your store) lives only in the two handlers you write (ADR 0021).
 *
 * It is a LEAF module: it imports only the core substrate (`../index`, for
 * `Cmd`) and no sibling subpath. (It does NOT reuse
 * `@demlik/tea/retry-backoff` — that is an even-leafier utility that depends on
 * nothing at all, not even the core; the kinship here is "leaf with injected
 * time", not a shared dependency.)
 * Nothing here reads the clock or the RNG on its own behalf — time enters as an
 * `at`/`now` parameter at the verb boundary and the store I/O is realized only
 * when the runtime performs the emitted `Cmd`. That keeps every verb
 * deterministic (invariant 2) and the checkpoint write a `Cmd` the runtime
 * interprets (invariant 3).
 *
 * The store is the handler's business, never this module's — so it never
 * imports `@cloudflare/workers-types` and can be checkpointed to anything (R2,
 * KV, a DO sub-key, an in-memory map in tests).
 *
 * Typical wiring:
 *
 *   const snap = createSnapshot<RunState>({ every: 25, key: "run/checkpoint" });
 *
 *   // machine state:
 *   type State = { run: RunState; snapshot: SnapshotState };
 *   cmds: [snap.write, snap.load],
 *   init: (loaded) => loaded ? [loaded, []] : [{ run: initRun(), snapshot: snap.init() }, []],
 *
 *   // in `update`, on each progress Msg, fold the snapshot slice:
 *   progress: (s, msg) => {
 *     const run = advance(s.run, msg);
 *     const [snapshot, cmds] = snap.record(s.snapshot, run, msg.at);
 *     return [{ ...s, run, snapshot }, cmds];
 *   },
 *   // the write completed → durable ack folds back through update:
 *   snapshot_write_ok: (s, msg) => {
 *     const [snapshot, cmds] = snap.confirm(s.snapshot, msg);
 *     return [{ ...s, snapshot }, cmds];
 *   },
 *   snapshot_write_err: (s) => [s, []],                     // errors are data — decide here
 *
 *   // RECOVERY — the half that makes a checkpoint a restart point, not just a
 *   // backup. A `boot` Msg the host dispatches once after `run(...)` asks the
 *   // store for the durable checkpoint; the answer folds the recovered payload
 *   // back into the run slice:
 *   boot: (s) => snap.requestLoad(s),                       // emits snapshot_load Cmd
 *   snapshot_load_ok: (s, msg) => {
 *     if (msg.value === null) return [s, []];               // no checkpoint → keep fresh init
 *     const [snapshot, cmds] = snap.boot(s.snapshot);
 *     return [{ ...s, run: msg.value, snapshot }, cmds];
 *   },
 *   snapshot_load_err: (s) => [s, []],                      // errors are data — decide here
 *
 *   // and where the machine runs, the two handlers you write:
 *   run(machine, {
 *     interpret: {
 *       snapshot_write: async (cmd, { ok, err }) => {
 *         try { await r2.put(cmd.key, cmd.payload); return ok(undefined); }
 *         catch (cause) { return err({ _tag: "snapshot_write_failed", cause }); }
 *       },
 *       snapshot_load: async (cmd, { ok, err }) => {
 *         try { return ok(await r2.get(cmd.key)); }
 *         catch (cause) { return err({ _tag: "snapshot_load_failed", cause }); }
 *       },
 *     },
 *   });
 */

import {
  Cmd,
  type CmdOf,
  type SettledErr,
  type SettledOk,
  type TaggedError,
} from "../../../index";
import { unchecked, undefinedOnly } from "../../schema";

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
// Cmds + Msgs — the write effect, the read effect, and their settled Msgs.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The checkpoint-write Cmd a `record` / `force` decision emits. Plain data
 * (invariant 1 — Cmds are data, not closures): it carries the `payload` to
 * write, the `key` to write it under, the `seq` it represents, and the `at` it
 * was decided.
 *
 * `payload` is `V` — the consumer's serializable checkpoint value (the run
 * state, the cursor, whatever the machine wants restartable). The verb takes it
 * as an argument so the snapshot slice never has to hold a copy of the
 * machine's domain state.
 *
 * `Cmd.define`d (ADR 0014, 0021), minted per `V` by a factory the way
 * `workflowActivityDef<A>()` is, since the payload type is the knob's own
 * parameter. The handler you write puts the payload in your store and returns
 * `ok(undefined)`, or `err({ _tag: "snapshot_write_failed", … })`; the engine
 * mints `snapshot_write_ok` / `snapshot_write_err`.
 */
export function snapshotWriteDef<V>() {
  return Cmd.define("snapshot_write", {
    input: unchecked<{
      readonly key: string;
      readonly seq: number;
      readonly at: number;
      readonly payload: V;
    }>(),
    ok: undefinedOnly,
    err: ["snapshot_write_failed"],
  });
}
export type SnapshotWriteCmd<V> = CmdOf<ReturnType<typeof snapshotWriteDef<V>>>;

/**
 * The checkpoint-READ Cmd a `requestLoad` decision emits — the recovery half of
 * the module. Plain data (invariant 1): it carries only the `key` to read. The
 * handler you write reads the store and returns `ok(payload)` — `null` when
 * the store has no checkpoint under `key` — or
 * `err({ _tag: "snapshot_load_failed", … })`.
 *
 * Distinct from `snapshot_write`: a write carries a payload OUT to the store; a
 * load asks the store to hand a payload BACK. The consumer dispatches the
 * triggering Msg once on resume (a `boot` Msg, never `init`'s rehydrate branch —
 * invariant 2), folds the recovered payload into its run slice, then continues.
 */
export function snapshotLoadDef<V>() {
  return Cmd.define("snapshot_load", {
    input: unchecked<{ readonly key: string }>(),
    ok: unchecked<V | null>(),
    err: ["snapshot_load_failed"],
  });
}
export type SnapshotLoadCmd<V = unknown> = CmdOf<
  ReturnType<typeof snapshotLoadDef<V>>
>;

/**
 * The Msg the engine mints when a write lands. Fold it through
 * `confirm(state, msg)` to advance `lastSavedSeq` / `lastSavedAt`. It carries
 * the write Cmd, so `msg.cmd.seq` matches the emitting decision and a late
 * acknowledgement of an older write can never regress a newer confirmed one.
 */
export type SnapshotSavedMsg<V = unknown> = SettledOk<
  "snapshot_write",
  SnapshotWriteCmd<V>,
  undefined
>;

/**
 * The Msg the engine mints when a write fails. Errors are data (never
 * swallowed): the consumer's reducer decides whether a failed checkpoint is
 * fatal, retryable (compose `@demlik/tea/retry-backoff`), or merely logged.
 * `msg.cmd.seq` identifies which checkpoint failed.
 */
export type SnapshotFailedMsg<V = unknown> = SettledErr<
  "snapshot_write",
  SnapshotWriteCmd<V>,
  TaggedError<"snapshot_write_failed">
>;

/**
 * The Msg the engine mints when a read resolves. `value` is the recovered
 * checkpoint, or `null` when the store has no checkpoint under `key` (fresh
 * boot — never checkpointed, or a wiped store). `null` is NOT an error — "no
 * checkpoint yet" is a normal first-run state, distinct from "the read failed"
 * (`snapshot_load_err`).
 */
export type SnapshotLoadedMsg<V> = SettledOk<
  "snapshot_load",
  SnapshotLoadCmd<V>,
  V | null
>;

/**
 * The Msg the engine mints when a read fails. Errors are data: a failed
 * recovery read is a visible signal the consumer's reducer decides on
 * (fatal-abort, retry, or boot-fresh-and-log). Kept apart from a `null` load
 * so "the store has no checkpoint" can never masquerade as "the read failed".
 */
export type SnapshotLoadFailedMsg<V = unknown> = SettledErr<
  "snapshot_load",
  SnapshotLoadCmd<V>,
  TaggedError<"snapshot_load_failed">
>;

// ─────────────────────────────────────────────────────────────────────────────
// The combinator.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The bundle `createSnapshot` returns: plain functions plus the two Cmd defs to
 * list in `cmds`. There are no subs: a checkpoint is driven by progress (a
 * `record` call from the consumer's reducer), not by a timer.
 */
export interface SnapshotKnob<V> {
  /** The `snapshot_write` Cmd def — list it in the machine's `cmds`. */
  readonly write: ReturnType<typeof snapshotWriteDef<V>>;
  /** The `snapshot_load` Cmd def — list it in the machine's `cmds`. */
  readonly load: ReturnType<typeof snapshotLoadDef<V>>;
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
  ): readonly [SnapshotState, readonly SnapshotWriteCmd<V>[]];
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
  ): readonly [SnapshotState, readonly SnapshotWriteCmd<V>[]];
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
   * Ask the store for the durable checkpoint. PURE. Emits a single
   * `snapshot_load` Cmd carrying the configured `key`; returns the slice
   * UNCHANGED (a read decides nothing about the cadence bookkeeping — only the
   * later `snapshot_load_ok` fold, via `boot`, touches the slice). This is the
   * entry point of the recovery loop: the consumer dispatches a `boot` Msg once
   * after `run(...)` and folds `requestLoad` there.
   */
  requestLoad(
    state: SnapshotState,
  ): readonly [SnapshotState, readonly SnapshotLoadCmd<V>[]];
}

/**
 * Create a snapshot knob from a `SnapshotConfig`. The returned bundle is spliced
 * into a consumer machine: `init()` seeds the slice, `record` / `force` are
 * folded in reducer cells, `confirm` / `boot` handle the acknowledgement +
 * resume Msgs, and `write` / `load` are the Cmd defs whose handlers you write.
 */
export function createSnapshot<V>(config: SnapshotConfig): SnapshotKnob<V> {
  // Clamp the cadence to >= 1 at construction so `record`'s threshold check is
  // branchless and a misconfigured `0` / negative `every` checkpoints on every
  // progress unit instead of never.
  const every = config.every >= 1 ? config.every : 1;
  const key = config.key ?? DEFAULT_SNAPSHOT_KEY;
  const snapshotWrite = snapshotWriteDef<V>();
  const snapshotLoad = snapshotLoadDef<V>();

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
  ): readonly [SnapshotState, readonly SnapshotWriteCmd<V>[]] {
    const seq = state.seq + 1;
    const next: SnapshotState = { ...state, sinceLast: 0, seq };
    return [next, [snapshotWrite({ key, seq, at, payload })]];
  }

  return {
    write: snapshotWrite,
    load: snapshotLoad,

    init(): SnapshotState {
      return { sinceLast: 0, seq: 0, lastSavedSeq: null, lastSavedAt: null };
    },

    record(state, payload, at) {
      const sinceLast = state.sinceLast + 1;
      // Below the cadence: accumulate, emit nothing.
      if (sinceLast < every) {
        return [{ ...state, sinceLast }, []];
      }
      // Cadence reached: checkpoint. `emitWrite` resets the counter + bumps seq.
      return emitWrite(state, payload, at);
    },

    force(state, payload, at) {
      return emitWrite(state, payload, at);
    },

    confirm(state, msg) {
      const { seq, at } = msg.cmd;
      // Forward-only watermark: ignore a stale ack of an older seq so a slow
      // write landing after a newer one can't regress `lastSavedSeq`.
      if (state.lastSavedSeq !== null && seq <= state.lastSavedSeq) {
        return [state, Cmd.none];
      }
      return [{ ...state, lastSavedSeq: seq, lastSavedAt: at }, Cmd.none];
    },

    boot(state) {
      return [{ ...state, sinceLast: 0 }, Cmd.none];
    },

    requestLoad(state) {
      // A read decides nothing about the cadence bookkeeping — return the slice
      // unchanged and emit the single read Cmd. The recovered payload folds back
      // through `snapshot_load_ok` (the consumer's reducer), not here.
      return [state, [snapshotLoad({ key })]];
    },
  };
}
