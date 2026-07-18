/**
 * @demlik/tea/monitored-run — a long-running operation that is BOTH staged and
 * watched: an ordered stage pipeline whose POSITION survives eviction, wrapped
 * by a no-progress safety deadline and (optionally) a periodic durable
 * checkpoint.
 *
 * This is the merge of two field-guide concerns the audit-agent machine
 * hand-wired together (`seed/audit-agent-machine`): the OUTER pipeline position
 * (`RunStage` — planning → testing → summarizing → reporting, replayed on cold
 * wake by re-emitting the one outstanding effect) and the no-progress safety
 * alarm (`subs.ts`, keyed on `progressSeq` so every progress event retires the
 * old alarm and arms a fresh one). `monitored-run` lifts both into one config-
 * driven knob with the uniform L2 contract `resilient-call` established:
 * `init()`, the verbs (`start` / `advance` / `progress` / `onDeadline` /
 * `boot`), `subs(state)`, and `handlers(ports)`.
 *
 *   - It is **staged, optionally**. Omit `stages` and the run is single-shot:
 *     `start` enters `running`, `advance` finishes it to `done`. Provide
 *     `stages` and it becomes an ordered pipeline — each `advance` retires the
 *     current stage and claims the next, finishing to `done` only when the last
 *     stage is retired. The pipeline POSITION lives in the Model (a
 *     `work-queue` of stage items), so an eviction mid-pipeline resumes at the
 *     same stage via `boot` — the audit machine's "pipeline position survives
 *     eviction" property, generalized.
 *   - It is **watched**. While `running`, a no-progress deadline is armed at
 *     `lastProgressAt + deadlineMs` and keyed on `progressSeq`. Every
 *     `progress` / `advance` bumps the seq, so the substrate retires the old
 *     alarm and arms a new one — a self-rearming watchdog. If the alarm fires
 *     (`onDeadline`) the run goes `failed` with a deadline reason. Omit
 *     `deadlineMs` → no watchdog (the `stale` phase is never reachable).
 *   - It **checkpoints, optionally**. Provide `snapshotEvery` and every
 *     progress unit is accounted to a `../snapshot` slice; once the cadence is
 *     reached a checkpoint Cmd is emitted (interpreted by the spliced snapshot
 *     `handlers`), so a crashed run restarts from the last durable checkpoint
 *     rather than from zero. Omit it → no checkpointing.
 *
 * ## Why the run lifecycle is INLINE (run-tracker not extracted)
 *
 * The phase union (`running` / `done` / `failed` / `stale`) and its
 * bookkeeping (`runId`, `startedAt`, `lastProgressAt`, `progressSeq`) live
 * directly on this slice rather than behind a `run-tracker` sub-knob.
 * Extraction earns its keep when two independent axes vary; here the lifecycle
 * has exactly one anchoring axis (this run), so a separate module would be a
 * premature seam. The two genuinely independent axes — the safety DEADLINE and
 * the periodic SNAPSHOT — ARE extracted (`../deadline`, `../snapshot`), and the
 * stage list is a `../work-queue` slice (`QueueItem<Stage>[]`) whose every
 * status flip is DELEGATED to the blessed `../work-queue/ops` (`enqueueOp` /
 * `claimNextOp` / `markDoneOp`) — never re-rolled here. The lifecycle is the
 * glue between them.
 *
 * ## The two non-negotiables (canon)
 *
 *   - **Durable** — the slice is plain data (the stage queue is a
 *     JSON-serializable `QueueItem<Stage>[]`, the snapshot slice is plain
 *     numbers), so it survives DO eviction / reload.
 *   - **Replayable** — every transition is a pure verb returning new state +
 *     Cmds; nothing here reads the clock or RNG. Time arrives as an `at` / `atMs`
 *     parameter; the only clock read is `Date.now()` inside the snapshot
 *     `handlers` port (the effect boundary), exactly as `../snapshot` stamps it.
 *
 * ## Typical wiring
 *
 *   const run = createMonitoredRun<MyStage, MyState>({
 *     stages: ["plan", "test", "report"],
 *     deadlineMs: 10 * 60_000,
 *     snapshotEvery: 25,
 *   });
 *
 *   init: (loaded) => loaded ? [loaded, []] : [{ run: run.init() }, []],
 *   update: {
 *     begin:    (s, m) => lift(s, run.start(s.run, m.runId, m.at)),
 *     advance:  (s, m) => lift(s, run.advance(s.run, checkpoint(s), m.result, m.at)),
 *     progress: (s, m) => lift(s, run.progress(s.run, checkpoint(s), m.at)),
 *     run_deadline: (s, m) => lift(s, run.onDeadline(s.run, m)),
 *     boot:     (s, m) => lift(s, run.boot(s.run, m.at)),
 *   },
 *   subscriptions: (s) => run.subs(s.run),
 *   subscribe: { deadline: subscribeDeadline },
 *   interpret: run.handlers({ store: r2 }),
 */

import {
  type DeadlineExceeded,
  type DeadlineSub,
  deadlineSub,
  subscribeDeadline,
} from "../deadline";
import type { Cmd, Interpret } from "../index";
import {
  createSnapshot,
  type SnapshotFailedMsg,
  type SnapshotLoadCmd,
  type SnapshotLoadedMsg,
  type SnapshotLoadFailedMsg,
  type SnapshotSavedMsg,
  type SnapshotState,
  type SnapshotStore,
  type SnapshotWriteCmd,
} from "../snapshot";
import type { QueueItem } from "../work-queue";
import { queueAdapter } from "../work-queue/adapter";

// ===========================================================================
// Config — the knob. Every field optional; omit a field → omit its gate.
// ===========================================================================

/**
 * The monitored-run knob. EVERY field is optional:
 *   - omit `stages`       → single-shot run (no pipeline; one `advance` finishes).
 *   - omit `deadlineMs`   → no no-progress watchdog (the run is never auto-failed).
 *   - omit `snapshotEvery`→ no periodic checkpoint (no `snapshot_write` Cmds).
 *
 * An empty config `{}` is a valid single-shot, unwatched, uncheckpointed run.
 *
 * `Stage` is the consumer's stage identifier — any JSON-serializable value
 * (a string id, a `{ kind, ... }` record). It rides through the stage queue
 * unchanged so the consumer's reducer can branch on the current stage to emit
 * that stage's outstanding effect (the audit machine's `outstandingEffect`).
 */
export interface MonitoredRunConfig<Stage> {
  /**
   * The ordered stages of the pipeline. Position survives eviction (lives in
   * the Model's stage queue). Omit for a single-shot run. An empty array is
   * treated as single-shot too — there is nothing to pipeline through.
   */
  readonly stages?: readonly Stage[];
  /**
   * No-progress watchdog budget, in ms. The safety deadline is armed at
   * `lastProgressAt + deadlineMs` and re-armed on every progress event. Omit
   * for no watchdog.
   */
  readonly deadlineMs?: number;
  /**
   * Checkpoint cadence — write a durable snapshot once this many progress
   * units have accumulated. Threaded straight into `../snapshot`'s `every`.
   * Omit for no checkpointing.
   */
  readonly snapshotEvery?: number;
  /**
   * Store key the rolling checkpoint is written under. Forwarded to
   * `../snapshot`'s `key`; defaults to that module's `@@snapshot`. Ignored
   * when `snapshotEvery` is omitted.
   */
  readonly snapshotKey?: string;
}

// ===========================================================================
// Slice — the Model field this knob owns. Run lifecycle INLINE + composed bricks.
// ===========================================================================

/**
 * Why a run terminated as `failed`. Discriminated so each reason carries only
 * its own data (pattern 11):
 *   - `deadline`  — the no-progress watchdog fired (`onDeadline`).
 *   - `stage`     — the consumer reported a stage failure via `advance(..., fail)`.
 *
 * `stale` is a SEPARATE phase (not a fail reason): a run is `stale` only by an
 * explicit consumer signal that progress has wedged WITHOUT the deadline having
 * fired — a soft, recoverable observation. The deadline firing is a hard
 * terminal (`failed { reason: "deadline" }`).
 *
 * The `stage` variant carries the FAILING STAGE VALUE (the `Stage` itself), not
 * a positional index: done stages leave the queue (`markDoneOp` filters them),
 * so a residual index drifts as the pipeline advances. The stage value is the
 * stable, meaningful identifier — `undefined` for a single-shot run (no stage).
 */
export type RunFailure<Stage> =
  | { readonly reason: "deadline"; readonly at: number }
  | {
      readonly reason: "stage";
      readonly stage: Stage | undefined;
      readonly error: unknown;
    };

/**
 * Run lifecycle phase. Discriminated on `phase`:
 *
 *   - `running` — the run is live. Carries the current pipeline position
 *     (`stepStates` is the stage queue; the single `running` item in it is the
 *     current stage, `undefined` for a single-shot run) and the watchdog
 *     bookkeeping (`lastProgressAt` / `progressSeq` keying the safety alarm).
 *   - `stale`   — a soft "no progress observed" mark the consumer can set and
 *     clear; the run is still resumable (a `progress` clears it back to
 *     `running`). Distinct from a fired deadline, which is terminal.
 *   - `done`    — every stage retired (or the single-shot `advance` landed).
 *   - `failed`  — terminal failure; `failure` carries why.
 */
export type RunPhase = "running" | "stale" | "done" | "failed";

/**
 * The slice. Plain data end to end:
 *   - `phase`          — the lifecycle discriminant.
 *   - `runId`          — host-minted run identity, stamped at `start` (the
 *                        machine never mints — see the audit seed's
 *                        "run identity is host-minted").
 *   - `stepStates`     — the stage pipeline as a `work-queue` of stage items.
 *                        Empty for a single-shot run. The ONE `running` item is
 *                        the current stage; `done` items are retired stages
 *                        (they leave the queue via `markDoneOp`, so the queue
 *                        shrinks as the pipeline advances and is empty at
 *                        `done`). POSITION survives eviction because this list
 *                        is durable.
 *   - `startedAt`      — `at` of `start`. Observability; never compared in a verb.
 *   - `lastProgressAt` — `at` of the most recent progress event; the watchdog
 *                        base. Re-armed by `progress` / `advance`.
 *   - `progressSeq`    — monotonic progress counter; keys the safety alarm Sub
 *                        id so every bump retires the old alarm and arms a new
 *                        one (the audit subs' `safety:{progressSeq}` discipline).
 *   - `failure`        — present iff `phase === "failed"`; the typed reason.
 *   - `snapshot`       — the `../snapshot` slice (cadence counter + durable
 *                        watermark). Always present (uniform shape); the gate
 *                        is simply never driven when `snapshotEvery` is omitted.
 */
export interface MonitoredRunState<Stage> {
  readonly phase: RunPhase;
  readonly runId: string;
  readonly stepStates: readonly QueueItem<Stage>[];
  readonly startedAt: number;
  readonly lastProgressAt: number;
  readonly progressSeq: number;
  readonly failure: RunFailure<Stage> | null;
  readonly snapshot: SnapshotState;
}

/**
 * The outcome a consumer reports to `advance`: the current stage either
 * succeeded (retire it, claim the next) or failed (terminate the run). Plain
 * data — the consumer parses its stage result at its own boundary and hands a
 * settled outcome here.
 */
export type StageResult =
  | { readonly kind: "ok" }
  | { readonly kind: "fail"; readonly error: unknown };

// ===========================================================================
// Cmd + Msg — re-exported from the composed bricks so consumers wire one import.
// ===========================================================================

/** The checkpoint-write Cmd, generic over the consumer's checkpoint value `V`. */
export type MonitoredRunCmd<V> = SnapshotWriteCmd<V>;

/** The deadline Msg the safety alarm dispatches when the watchdog fires. */
export type MonitoredRunTimerMsg = DeadlineExceeded;

/** Ports the consumer supplies to `handlers` — just the checkpoint store. */
export interface MonitoredRunPorts<V> {
  /** Where periodic checkpoints are written (R2 / KV / DO sub-key / Map). */
  readonly store: SnapshotStore<V>;
}

// ===========================================================================
// Sub-id family. The safety alarm is keyed on `progressSeq` so a progress
// event retires the old alarm and arms a new one (single-shot, re-armed by id
// bump — the audit subs discipline).
// ===========================================================================

function safetyTimerId(runId: string, progressSeq: number): string {
  return `monitored:safety:${runId}:${progressSeq}`;
}

// ===========================================================================
// The knob factory.
// ===========================================================================

/**
 * Build a monitored-run knob from `config`. `Stage` is the consumer's stage
 * identifier type; `V` is the consumer's checkpoint value type (what
 * `snapshotEvery` checkpoints). Returns the uniform L2 knob contract.
 *
 * No `rng` parameter: unlike `resilient-call`, nothing here jitters — the only
 * external inputs are time (an `at` / `atMs` parameter) and the consumer's
 * stage outcomes. The clock is read only inside the snapshot `handlers` port.
 */
export function createMonitoredRun<Stage, V = unknown>(
  config: MonitoredRunConfig<Stage> = {},
) {
  const stages = config.stages ?? [];
  const isPipeline = stages.length > 0;

  // The stage-queue seam, bound once. Every stage status flip delegates to the
  // `QueueAdapter` verbs (`wq.enqueue` / `wq.claim` / `wq.markDone`), so the
  // `QueueItem<Stage>` shape stays insulated behind them.
  const wq = queueAdapter<Stage>();

  // The snapshot sub-knob is built only when `snapshotEvery` is configured;
  // absence is `null` so the progress gate short-circuits to "no checkpoint".
  // When present, the slice still carries a default SnapshotState so the shape
  // is uniform across configs — the gate simply never records into it.
  const snap =
    config.snapshotEvery !== undefined
      ? createSnapshot<V>({
          every: config.snapshotEvery,
          ...(config.snapshotKey !== undefined
            ? { key: config.snapshotKey }
            : {}),
        })
      : null;

  // The snapshot knob to actually drive: `snap` when configured, else a single
  // inert default (`every: 1`) bound ONCE here. Its `record` is never invoked
  // (the progress gate short-circuits when `snap` is null), so the cadence value
  // is immaterial — one shared stateless knob of pure functions stands in for
  // the disabled-checkpoint case across init/boot/handlers.
  const activeSnap = snap ?? createSnapshot<V>({ every: 1 });

  /** The starting slice for a never-started run. `runId` is filled at `start`. */
  function init(): MonitoredRunState<Stage> {
    return {
      phase: "running",
      runId: "",
      stepStates: [],
      startedAt: 0,
      lastProgressAt: 0,
      progressSeq: 0,
      failure: null,
      // A default snapshot slice even without the brick → uniform shape. When
      // `snap` is null the inert `activeSnap` default supplies the slice; its
      // `record` is never called, so the cadence value is immaterial.
      snapshot: activeSnap.init(),
    };
  }

  /**
   * Seed the stage queue from the configured stages: every stage enqueued
   * `pending`, then the first claimed `running`. `at` stamps the claim. PURE —
   * the work-queue ops are pure array transforms; ids are positional (`stage:i`)
   * so they are deterministic and replayable (no `crypto`, no `Math.random`).
   */
  function seedStages(at: number): readonly QueueItem<Stage>[] {
    let queue: readonly QueueItem<Stage>[] = [];
    stages.forEach((stage, i) => {
      queue = wq.enqueue(queue, stage, at, `stage:${i}`).next;
    });
    // Claim the first stage as the running position. A non-empty pipeline always
    // has a pending head here, so the claim succeeds.
    const claimed = wq.claim(queue, at);
    return claimed ? claimed.next : queue;
  }

  /** The current (running) stage item, or `undefined` for a single-shot run. */
  function currentStage(
    s: MonitoredRunState<Stage>,
  ): QueueItem<Stage> | undefined {
    return s.stepStates.find((i) => i.status === "running");
  }

  // === Verb: start =========================================================

  /**
   * Start (or restart) the run for `runId` at time `at`. Seeds the stage queue
   * (if a pipeline) and enters `running` with the watchdog clock primed. Stamps
   * `runId` from the host — the machine never mints (invariant: identity is
   * host-minted, parsed at the boundary). PURE.
   */
  function start(
    s: MonitoredRunState<Stage>,
    runId: string,
    at: number,
  ): readonly [MonitoredRunState<Stage>, readonly MonitoredRunCmd<V>[]] {
    const next: MonitoredRunState<Stage> = {
      ...s,
      phase: "running",
      runId,
      stepStates: isPipeline ? seedStages(at) : [],
      startedAt: at,
      lastProgressAt: at,
      progressSeq: 0,
      failure: null,
    };
    return [next, []];
  }

  /**
   * Bump the watchdog clock: set `lastProgressAt`/`progressSeq` so the safety
   * alarm Sub id changes and the substrate re-arms a fresh deadline. Shared by
   * `progress` and `advance`. PURE.
   */
  function bumpProgress(
    s: MonitoredRunState<Stage>,
    at: number,
  ): MonitoredRunState<Stage> {
    return { ...s, lastProgressAt: at, progressSeq: s.progressSeq + 1 };
  }

  /**
   * Account one progress unit to the snapshot slice (when the brick is
   * configured), returning the new slice + any checkpoint Cmd. `payload` is the
   * consumer's checkpoint value to persist. PURE — `snap.record` is pure, the
   * write is realized only when the runtime performs the emitted Cmd.
   */
  function recordSnapshot(
    s: MonitoredRunState<Stage>,
    payload: V,
    at: number,
  ): readonly [MonitoredRunState<Stage>, readonly MonitoredRunCmd<V>[]] {
    if (snap === null) return [s, []];
    const [snapshot, cmds] = snap.record(s.snapshot, payload, at);
    // `snap.record` only ever emits `SnapshotWriteCmd<V>` (its sole Cmd), but
    // its signature widens to `readonly Cmd[]`. Narrow back to this knob's
    // precise Cmd union so a consumer's host Cmd type can stay exact.
    return [{ ...s, snapshot }, cmds as readonly MonitoredRunCmd<V>[]];
  }

  // === Verb: progress ======================================================

  /**
   * Record forward progress: bump the watchdog (re-arming the safety alarm),
   * clear any `stale` mark back to `running`, and account a snapshot unit
   * (emitting a checkpoint Cmd on a cadence hit). A no-op on a settled run
   * (`done` / `failed`) — a late progress event after the run ended is ignored.
   * PURE.
   */
  function progress(
    s: MonitoredRunState<Stage>,
    payload: V,
    at: number,
  ): readonly [MonitoredRunState<Stage>, readonly MonitoredRunCmd<V>[]] {
    if (s.phase === "done" || s.phase === "failed") return [s, []];
    const bumped: MonitoredRunState<Stage> = {
      ...bumpProgress(s, at),
      phase: "running",
    };
    return recordSnapshot(bumped, payload, at);
  }

  // === Verb: markStale =====================================================

  /**
   * Mark the run `stale` — a soft "no progress observed" signal the consumer
   * raises WITHOUT the deadline having fired (e.g. an upstream heartbeat gap).
   * Recoverable: the next `progress` flips it back to `running`. A no-op unless
   * the run is currently `running` (a settled run cannot go stale). Does NOT
   * touch `progressSeq` — going stale is not progress, so the armed deadline
   * keeps counting toward the hard terminal. PURE.
   */
  function markStale(
    s: MonitoredRunState<Stage>,
  ): readonly [MonitoredRunState<Stage>, readonly MonitoredRunCmd<V>[]] {
    if (s.phase !== "running") return [s, []];
    return [{ ...s, phase: "stale" }, []];
  }

  // === Verb: advance =======================================================

  /**
   * Advance the pipeline on a stage outcome:
   *
   *   - `result.kind === "fail"` → terminate `failed { reason: "stage" }`,
   *     carrying the failing stage index + error. No further stages run.
   *   - `result.kind === "ok"`:
   *       - single-shot run → finish to `done` (and force a final checkpoint
   *         when checkpointing, so the last durable snapshot is the terminal
   *         state).
   *       - pipeline → retire the current stage (`markDoneOp`) and claim the
   *         next (`claimNextOp`). If none remain, finish to `done`. The new
   *         position survives eviction.
   *
   * An advance is itself a progress event, so it bumps the watchdog (re-arming
   * the alarm at the new stage) and accounts a snapshot unit. A no-op on a
   * settled run. PURE — `at` is the only clock, ids are positional.
   */
  function advance(
    s: MonitoredRunState<Stage>,
    payload: V,
    result: StageResult,
    at: number,
  ): readonly [MonitoredRunState<Stage>, readonly MonitoredRunCmd<V>[]] {
    if (s.phase === "done" || s.phase === "failed") return [s, []];

    // Stage failure → hard terminal. Carry the failing stage VALUE (stable),
    // `undefined` for a single-shot run with no stage.
    if (result.kind === "fail") {
      const failed: MonitoredRunState<Stage> = {
        ...s,
        phase: "failed",
        failure: {
          reason: "stage",
          stage: currentStage(s)?.input,
          error: result.error,
        },
      };
      return [failed, []];
    }

    // Success: bump the watchdog first (an advance is progress), then move the
    // pipeline position.
    const bumped = bumpProgress(s, at);

    // Single-shot: one advance finishes the run.
    if (!isPipeline) {
      const done: MonitoredRunState<Stage> = { ...bumped, phase: "done" };
      // Force a terminal checkpoint so the last durable snapshot is `done`,
      // not whatever the cadence happened to land on.
      return finishWithSnapshot(done, payload, at);
    }

    // Pipeline: retire the running stage, claim the next.
    const current = currentStage(s);
    const afterDone =
      current !== undefined
        ? wq.markDone(s.stepStates, current.id).next
        : s.stepStates;
    const claimed = wq.claim(afterDone, at);

    if (claimed === null) {
      // No more stages — the pipeline is complete.
      const done: MonitoredRunState<Stage> = {
        ...bumped,
        phase: "done",
        stepStates: afterDone,
      };
      return finishWithSnapshot(done, payload, at);
    }

    // Advance to the next stage — POSITION now points at the claimed item.
    const moved: MonitoredRunState<Stage> = {
      ...bumped,
      stepStates: claimed.next,
    };
    return recordSnapshot(moved, payload, at);
  }

  /**
   * Finish helper: force a terminal checkpoint when checkpointing is enabled
   * (so the durable snapshot is the terminal state), else just settle. Shared
   * by single-shot finish and pipeline completion. PURE.
   */
  function finishWithSnapshot(
    s: MonitoredRunState<Stage>,
    payload: V,
    at: number,
  ): readonly [MonitoredRunState<Stage>, readonly MonitoredRunCmd<V>[]] {
    if (snap === null) return [s, []];
    const [snapshot, cmds] = snap.force(s.snapshot, payload, at);
    // Same narrowing as `recordSnapshot`: `snap.force` emits only the write Cmd.
    return [{ ...s, snapshot }, cmds as readonly MonitoredRunCmd<V>[]];
  }

  // === Verb: onDeadline ====================================================

  /**
   * The safety alarm fired. Two outcomes by Sub-id match:
   *
   *   - the alarm matches the CURRENT `progressSeq` (no progress since it was
   *     armed) → the run is wedged → terminate `failed { reason: "deadline" }`.
   *   - the alarm matches an OLDER seq → a stale fire racing a progress event
   *     that already re-armed the alarm → no-op (the substrate retired this id;
   *     tolerate a fire still in flight defensively).
   *
   * A no-op on a settled run (its alarm was reconciled away; tolerate a stale
   * fire) and on a NEVER-STARTED run (empty `runId` → `subs` armed nothing, so
   * any alarm reaching it is a rogue fire that must not un-start it). PURE —
   * `msg.atMs` stamps the failure.
   */
  function onDeadline(
    s: MonitoredRunState<Stage>,
    msg: MonitoredRunTimerMsg,
  ): readonly [MonitoredRunState<Stage>, readonly MonitoredRunCmd<V>[]] {
    if (s.phase === "done" || s.phase === "failed") return [s, []];
    // A never-started run has no host-minted runId, so `subs` never armed a
    // watchdog for it. Any alarm reaching this slice is a born-live/rogue fire;
    // refuse to auto-fail a run that was never started.
    if (s.runId === "") return [s, []];
    // Only the alarm armed against the current progressSeq is live. A bumped
    // seq means progress re-armed it; an older fire is stale.
    if (msg.id !== safetyTimerId(s.runId, s.progressSeq)) return [s, []];
    const failed: MonitoredRunState<Stage> = {
      ...s,
      phase: "failed",
      failure: { reason: "deadline", at: msg.atMs },
    };
    return [failed, []];
  }

  // === Verb: boot ==========================================================

  /**
   * Resume after a reload (cold wake). Re-seeds the watchdog clock to `at` so
   * the safety alarm re-arms from NOW (the pre-crash `lastProgressAt` would
   * immediately fire a deadline that already elapsed during downtime — a cold
   * wake is not a no-progress wedge). Bumps `progressSeq` so the alarm gets a
   * fresh id, and resets the snapshot cadence counter (un-checkpointed
   * pre-crash progress is moot — recovery resumes from the last durable
   * checkpoint). The pipeline POSITION (`stepStates`) is preserved untouched —
   * that is the whole point of staging: resume at the same stage.
   *
   * A no-op on a settled run. Emits NO Cmd — re-emitting the current stage's
   * outstanding effect is the CONSUMER's job (it knows the per-stage Cmd), the
   * audit machine's `outstandingEffect(stage)` pattern. PURE.
   */
  function boot(
    s: MonitoredRunState<Stage>,
    at: number,
  ): readonly [MonitoredRunState<Stage>, readonly MonitoredRunCmd<V>[]] {
    if (s.phase === "done" || s.phase === "failed") return [s, []];
    // `snap.boot` returns the reducer-cell shape `[SnapshotState, Cmd[]]`
    // (uniform across every sibling knob); a boot emits no Cmd, so take only the
    // slice. Assigning the tuple itself would put an ARRAY where a SnapshotState
    // belongs — a type error AND a non-round-trippable slice.
    const [bootedSnapshot] = activeSnap.boot(s.snapshot);
    const reseeded: MonitoredRunState<Stage> = {
      ...s,
      phase: "running",
      lastProgressAt: at,
      progressSeq: s.progressSeq + 1,
      snapshot: bootedSnapshot,
      // Any stage left `running` mid-flight stays the running position; the
      // queue is already correct (a single in-flight stage). resetRunningOp is
      // NOT applied — unlike a work pool, a monitored run has exactly one
      // in-flight stage and resuming it (not re-queuing it) is the correct
      // cold-wake behavior.
    };
    return [reseeded, []];
  }

  // === Subs ================================================================

  /**
   * Pre-wired subscriptions: the no-progress safety deadline, armed only while
   * the run is live (`running` / `stale`) AND a `deadlineMs` is configured. The
   * Sub id is keyed on `progressSeq`, so every progress event retires the old
   * alarm and the substrate arms a fresh one at the new `lastProgressAt +
   * deadlineMs` — a self-rearming watchdog with no manual `clearTimeout`. A
   * settled run desires no subs. Wire `subscribe: { deadline: subscribeDeadline }`.
   *
   * A NEVER-STARTED slice (`init()`) is `running` with an empty `runId` and a
   * zero `lastProgressAt`. Without the `runId` gate it would arm a deadline at
   * `0 + deadlineMs` — already in the past — which fires immediately and
   * auto-fails a run that never began (the "born live" defect). `start` is the
   * only verb that stamps a host-minted `runId`, so `runId !== ""` is the exact
   * "has this run actually been started?" predicate: a pre-start slice arms
   * nothing, and the watchdog only exists once a real run is in flight.
   */
  function subs(s: MonitoredRunState<Stage>): readonly DeadlineSub[] {
    if (config.deadlineMs === undefined) return [];
    if (s.runId === "") return [];
    if (s.phase !== "running" && s.phase !== "stale") return [];
    return [
      deadlineSub(
        safetyTimerId(s.runId, s.progressSeq),
        s.lastProgressAt + config.deadlineMs,
      ),
    ];
  }

  // === Handlers ============================================================

  /**
   * Pre-wired interpret handler for the checkpoint write. Delegates wholesale to
   * `../snapshot`'s `handlers` (which performs the `put` and routes Ok →
   * `snapshot_saved` / Err → `snapshot_failed` via Railway — the write never
   * rejects into the runtime). When checkpointing is disabled (`snapshotEvery`
   * omitted), no `snapshot_write` Cmd is ever emitted, so the returned map is an
   * inert no-op handler — kept for a uniform `handlers(ports)` call shape.
   *
   * Fold the `snapshot_saved` Msg back through this knob's `confirmSnapshot`
   * verb to advance the durable watermark.
   */
  function handlers(
    ports: MonitoredRunPorts<V>,
  ): Interpret<
    | SnapshotSavedMsg
    | SnapshotFailedMsg
    | SnapshotLoadedMsg<V>
    | SnapshotLoadFailedMsg,
    SnapshotWriteCmd<V> | SnapshotLoadCmd,
    unknown
  > {
    return activeSnap.handlers({ store: ports.store });
  }

  /**
   * Fold a confirmed checkpoint write into the slice — advances the snapshot
   * watermark (forward-only). A no-op pass-through when checkpointing is
   * disabled. PURE. Fold the `snapshot_saved` Msg here.
   */
  function confirmSnapshot(
    s: MonitoredRunState<Stage>,
    msg: SnapshotSavedMsg,
  ): MonitoredRunState<Stage> {
    if (snap === null) return s;
    // `snap.confirm` returns the reducer-cell shape `[SnapshotState, Cmd[]]`
    // (an ack emits nothing). Take only the slice — folding the whole tuple into
    // `snapshot` would store an ARRAY where a SnapshotState belongs (a type error
    // and a non-round-trippable slice).
    const [confirmed] = snap.confirm(s.snapshot, msg);
    return { ...s, snapshot: confirmed };
  }

  return {
    init,
    start,
    progress,
    markStale,
    advance,
    onDeadline,
    boot,
    confirmSnapshot,
    subs,
    handlers,
  };
}

/**
 * Lift a knob result `[slice, cmds]` into a host `[State, cmds]` where the
 * slice lives at `state.run`. Convenience for the common single-slice host;
 * hosts with a differently-named field spread by hand. PURE — a thin record
 * rebuild, no clock / RNG.
 */
export function liftRun<
  S extends { run: MonitoredRunState<Stage> },
  Stage,
  C extends Cmd,
>(
  state: S,
  [slice, cmds]: readonly [MonitoredRunState<Stage>, readonly C[]],
): readonly [S, readonly C[]] {
  return [{ ...state, run: slice }, cmds];
}

/**
 * Re-export the deadline Sub primitives so consumers (and tests) wire one
 * import: `subscribeDeadline` is the `subscribe` cell, `deadlineSub` builds the
 * Sub literal this knob's `subs` emits.
 */
export { subscribeDeadline, deadlineSub };
export type {
  DeadlineSub,
  DeadlineExceeded,
  SnapshotSavedMsg,
  SnapshotWriteCmd,
};
