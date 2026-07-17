/**
 * @packageDocumentation
 * @demlik/tea/saga — a forward-then-compensate transaction over an ordered list
 * of reversible steps.
 *
 * The Level-2 combinator for "run these N steps in order; if any step fails,
 * undo the steps that already succeeded, in reverse." It is the distributed-
 * transaction / compensation knob: each step is a `{ do, undo }` pair of Cmds,
 * the saga drives `do` forward one step at a time, and on the first failure it
 * pivots and drives `undo` backward over exactly the steps that completed.
 *
 * **Boundary with `@demlik/tea/workflow` — the compensation test.** Both drive
 * an ordered multi-step transaction with reverse-order compensation; the line
 * between them is whether every step carries a true inverse. Here
 * `SagaStep<D, U>` REQUIRES both `do` and `undo` — a step without its inverse
 * is unrepresentable, so full reversibility is a type-level guarantee.
 * Workflow's `WorkflowStep.compensation` is OPTIONAL — an irreversible step (a
 * sent email) is skipped during the unwind. Pick by the test: **every step
 * must be reversible → saga; some steps are irreversible but the run must
 * finish → workflow.** Cross to workflow when the transaction includes steps
 * that can't be undone (or when you want each activity recorded as a durable
 * owed effect on the `../do` ledger); stay here when the type system should
 * enforce that every step can be undone.
 *
 * The recipe (which bricks it composes):
 *   - `../work-queue/adapter` — the saga's forward progress IS a work-queue
 *     lifecycle. Each step's record carries the same `{ id, status, input }`
 *     vocabulary (`pending → running → done | failed | cancelled`), so the step
 *     taxonomy is the substrate's status enum rather than a parallel invention.
 *     We reuse the pure `QueueItem` / `QueueItemStatus` types AND delegate every
 *     status flip to the `QueueAdapter` verbs: `wq.enqueue` stamps each fresh
 *     ledger record, and `wq.patch` performs every
 *     `pending → running → done | failed | cancelled` transition. The status
 *     transitions are NOT re-rolled here — they live in exactly one place
 *     behind the adapter, per the package's one-shape rule. The async
 *     `createQueue(store)` adapter is NOT used: its `load → mutate → save` reads
 *     the clock and lives at an I/O boundary, while a combinator's verbs must be
 *     pure (invariant 2). We bind the same ops to the in-Model ledger instead —
 *     durable + replayable, the two non-negotiables every knob preserves.
 *
 * The compensation log is the spec's `done: StepId[]` — the indices of the
 * steps that completed forward, in the order they completed. On `stepErr` the
 * saga walks that log in reverse, emitting one `undo` per `undoOk`, so the
 * unwind is the exact mirror of the wind. If an `undo` ITSELF fails, `undoErr`
 * pivots to the terminal `compensation_failed` phase: a failed compensation is
 * a real-world fact (a refund that bounced, a hold that won't release) that the
 * consumer must see and reconcile by hand — never a saga wedged in
 * `compensating` forever.
 *
 * Typical wiring (combinator form — splice the hooks into your machine):
 *
 *   const saga = createSaga<BookFlight | ChargeCard | ..., Cancel | Refund | ...>({
 *     steps: [
 *       { do: { type: "book_flight" },  undo: { type: "cancel_flight" } },
 *       { do: { type: "charge_card" },  undo: { type: "refund_card" } },
 *       { do: { type: "reserve_hotel" },undo: { type: "release_hotel" } },
 *     ],
 *   });
 *
 *   // in `update`:
 *   begin:    (s)    => lift(s, saga.start(s.saga)),
 *   step_ok:  (s)    => lift(s, saga.stepOk(s.saga)),
 *   step_err: (s, m) => lift(s, saga.stepErr(s.saga, m.error)),
 *   undo_ok:  (s)    => lift(s, saga.undoOk(s.saga)),
 *   undo_err: (s, m) => lift(s, saga.undoErr(s.saga, m.error)),
 *
 * Every verb is PURE: it returns a NEW slice plus the Cmds to perform (the next
 * `do` going forward, or the next `undo` rolling back). The reducer never reads
 * a clock or RNG — step identity is positional (the index into `config.steps`),
 * so progress survives a round-trip through the durable slice and resumes
 * exactly where it left off after a DO eviction.
 *
 * There is no `subs` and no `handlers`: a saga runs no timers, and the `do` /
 * `undo` Cmds are fully caller-defined (the consumer's own `interpret` performs
 * each effect and routes Ok/Err back to the `stepOk` / `stepErr` / `undoOk`
 * verbs — the same shape `resilient-fetch` uses with `tryInterpret`). The saga
 * owns the ORDER; the consumer owns the I/O. Pure-ops module, like
 * `retry-backoff`.
 *
 * NOT a substrate primitive: it depends only on `../work-queue`'s pure types
 * and `../index`'s `Cmd` type. Consumers reach it via the `@demlik/tea/saga`
 * subpath.
 */

import type { Cmd } from "../index";
import type { QueueItem, QueueItemStatus } from "../work-queue";
import { queueAdapter } from "../work-queue/adapter";

/**
 * A step's stable identity. Positional: the 0-based index into
 * `config.steps`. Positional ids are PURE (no clock, no RNG) and survive a
 * round-trip through the durable slice, so `done` can be replayed to resume an
 * interrupted saga exactly. The compensation log is a list of these.
 */
export type StepId = number;

/**
 * One step of the saga: the forward effect and its compensating inverse, both
 * as data (plain Cmds). `do` runs while winding forward; `undo` runs while
 * unwinding after a failure. The pair is the unit of reversibility — a step
 * that completed (`do` succeeded) is exactly a step whose `undo` must run if a
 * later step fails.
 */
export interface SagaStep<D extends Cmd, U extends Cmd> {
  /** The forward effect, performed while the saga winds forward. */
  readonly do: D;
  /** The compensating inverse, performed (in reverse) while the saga unwinds. */
  readonly undo: U;
}

/**
 * The knob. The ordered list of reversible steps. The list is fixed for the
 * life of one saga instance (a saga drives a known transaction); per-run inputs
 * ride on the consumer's Msgs, not here.
 */
export interface SagaConfig<D extends Cmd, U extends Cmd> {
  /** The steps, in forward order. `do` runs `0 → n-1`; `undo` runs the completed prefix `n-1 → 0`. */
  readonly steps: readonly SagaStep<D, U>[];
}

/**
 * The lifecycle phase of a saga, narrowed at the type level so a consumer can
 * branch on `state.phase` (and a Transitions-table reducer can key on it).
 *
 *   - `"idle"`         — created, not started. No step has run.
 *   - `"running"`      — winding forward; `position` is the in-flight step.
 *   - `"compensating"` — a step failed; unwinding `done` in reverse.
 *   - `"committed"`    — every step completed forward. Terminal success.
 *   - `"aborted"`      — compensation finished (every completed step undone, or
 *                        the first step itself failed with nothing to undo).
 *                        Terminal failure, fully unwound.
 *   - `"compensation_failed"` — an `undo` itself failed mid-rollback. Terminal
 *                        failure, PARTIALLY unwound: the steps still in `done`
 *                        were never compensated and must be reconciled by hand.
 *                        Distinguished from `aborted` precisely so a stuck
 *                        rollback is visible state, not a saga wedged in
 *                        `compensating` forever.
 */
export type SagaPhase =
  | "idle"
  | "running"
  | "compensating"
  | "committed"
  | "aborted"
  | "compensation_failed";

/**
 * The slice this knob owns.
 *
 * The spec's three fields are load-bearing:
 *   - `position` — the index of the step currently in flight while `running`,
 *     or the index being compensated while `compensating`. Survives eviction,
 *     so `boot` resumes mid-saga from the durable slice.
 *   - `done` — the compensation log: the ids of steps that completed forward,
 *     in completion order. `undo` walks this in reverse. This is the single
 *     source of truth for what must be unwound.
 *   - `compensating` — the direction bit. `false` while winding forward, `true`
 *     once a failure has pivoted the saga into rollback.
 *
 * Plus:
 *   - `phase` — the derived lifecycle tag (see `SagaPhase`). Kept in the slice
 *     (not recomputed) so a consumer's view and Transitions reducer can key on
 *     `state.phase` directly, and the terminal states (`committed` / `aborted`)
 *     are explicit facts rather than "position past the end" arithmetic.
 *   - `error` — the forward failure that triggered compensation, carried
 *     forward verbatim (`unknown`) for the consumer to read, never interpreted
 *     (same discipline as `retry-backoff`'s `lastError` and `fan-out`'s
 *     `error`).
 *   - `compensationError` — the failure of an `undo` itself, set only when the
 *     saga reaches `compensation_failed`. Kept distinct from `error` (the
 *     forward failure) so a consumer reconciling a stuck rollback can read both
 *     "what broke the transaction" and "which compensation then bounced".
 *     Carried verbatim, never interpreted, same as `error`.
 *   - `items` — the work-queue ledger, one `QueueItem` per step, keyed by the
 *     step's positional id. The single source of truth for each step's status;
 *     `phase` / `position` / `done` are the projection the verbs keep in
 *     lockstep with it.
 *
 * Every field is `readonly` and JSON-serializable (plain numbers, arrays, and
 * the work-queue's plain `QueueItem` records), so the slice round-trips through
 * a consumer's `Store<S>` unchanged — durable across DO eviction.
 */
export interface SagaState<I = StepId> {
  /** The step in flight (`running`) or being compensated (`compensating`). */
  readonly position: number;
  /** The compensation log: ids of completed-forward steps, in completion order. */
  readonly done: readonly StepId[];
  /** Direction bit: `false` winding forward, `true` unwinding. */
  readonly compensating: boolean;
  /** The derived lifecycle tag (see `SagaPhase`). */
  readonly phase: SagaPhase;
  /** The forward failure that triggered compensation, if any. Carried, never interpreted. */
  readonly error?: unknown;
  /** The failure of an `undo` itself (only when `compensation_failed`). Carried, never interpreted. */
  readonly compensationError?: unknown;
  /** The work-queue ledger: one record per step, keyed by positional id. */
  readonly items: readonly QueueItem<I>[];
}

/** Whether the saga has terminated successfully (every step committed). */
export function isCommitted<I>(state: SagaState<I>): boolean {
  return state.phase === "committed";
}

/** Whether the saga has terminated in failure, fully unwound (every completed step undone). */
export function isAborted<I>(state: SagaState<I>): boolean {
  return state.phase === "aborted";
}

/**
 * Whether the saga has terminated in failure with an UNFINISHED rollback: an
 * `undo` itself failed, so some completed steps were never compensated and need
 * hand reconciliation. Terminal, but distinct from `aborted` (fully unwound).
 */
export function isCompensationFailed<I>(state: SagaState<I>): boolean {
  return state.phase === "compensation_failed";
}

/**
 * Whether the saga has reached a terminal phase (success, fully-unwound
 * failure, or compensation-failed). Derived — reads the slice, never mutates.
 * Consumers branch their own phase off this; no further verb has any effect
 * once it holds (the verbs guard on phase and no-op).
 */
export function isSettled<I>(state: SagaState<I>): boolean {
  return (
    state.phase === "committed" ||
    state.phase === "aborted" ||
    state.phase === "compensation_failed"
  );
}

/**
 * The starting slice: idle, nothing run, winding-forward direction. `items` is
 * empty until `start` stamps one ledger record per configured step — the slice
 * is generic in the ledger payload `I`, defaulting to the positional `StepId`
 * since a saga's "input" per step is just its index (the consumer's real inputs
 * ride on its own Msgs).
 */
export function initSaga<I = StepId>(): SagaState<I> {
  return {
    position: 0,
    done: [],
    compensating: false,
    phase: "idle",
    items: [],
  };
}

/**
 * Build the saga knob from `config`. Returns the uniform combinator contract:
 * `init` for the owned slice and the five lifecycle verbs (`start`, `stepOk`,
 * `stepErr`, `undoOk`, `undoErr`).
 *
 * No `subs` and no `handlers` — a saga runs no timers, and each step's `do` /
 * `undo` effect is owned by the consumer's `interpret` (the saga emits the Cmd;
 * the consumer performs it and routes the outcome back to a verb). The saga's
 * sole job is the ORDER: which Cmd to emit next, and when to pivot from winding
 * to unwinding (and when a failed `undo` ends the rollback). Pure-ops module —
 * matches `retry-backoff`'s shape.
 */
export function createSaga<D extends Cmd, U extends Cmd>(
  config: SagaConfig<D, U>,
) {
  // The ledger seam, bound once. The saga delegates ledger construction to
  // `wq.enqueue` and every status flip to `wq.patch`, so the `QueueItem<StepId>`
  // shape stays insulated behind the verbs.
  const wq = queueAdapter<StepId>();

  /**
   * One ledger record per configured step, keyed by its positional id. Each
   * record is stamped by the `QueueAdapter`'s `enqueue` (the saga delegates
   * ledger construction to the verb rather than building records inline).
   *
   * The positional id is stringified — `QueueItem.id` is a string, the saga's
   * step identity is the index; `String(index)` keeps both the ledger's
   * string-id contract and the positional identity. `enqueuedAt` is `0`: saga
   * verbs are pure and the saga makes no timestamp-based decision (ordering is
   * positional), so there is no clock to read here.
   */
  function freshLedger(): QueueItem<StepId>[] {
    let items: QueueItem<StepId>[] = [];
    config.steps.forEach((_step, index) => {
      items = wq.enqueue(items, index, 0, String(index)).next;
    });
    return items;
  }

  /**
   * Flip the ledger record for step `index` to `status`, delegating the
   * transition to the `QueueAdapter`'s `patch` (keyed by the record's string
   * id, `String(index)`) so the status flip is NOT re-rolled here. PURE —
   * `patch` returns a new array; an unknown id returns a copy unchanged (the
   * verbs guard against out-of-range, but the helper is total).
   */
  function setStatus(
    items: readonly QueueItem<StepId>[],
    index: number,
    status: QueueItemStatus,
  ): QueueItem<StepId>[] {
    return wq.patch(items, String(index), (item) => ({
      ...item,
      status,
    })).next;
  }

  /**
   * The step at `index`, or `undefined` if out of range. Centralizes the bounds
   * check so the verbs read a step through a narrowing guard instead of a
   * non-null assertion: `const step = stepAt(i); if (step === undefined) …`.
   */
  function stepAt(index: number): SagaStep<D, U> | undefined {
    return config.steps[index];
  }

  /** The most-recently-completed step id (tail of `done`), or `undefined` if the log is empty. */
  function lastDone(done: readonly StepId[]): StepId | undefined {
    return done[done.length - 1];
  }

  /**
   * Begin the saga: stamp a `pending` ledger record per step, mark step 0
   * `running`, and emit step 0's `do` Cmd. PURE.
   *
   * A saga with zero configured steps commits immediately (nothing to do, so
   * the empty transaction trivially succeeds) and emits no Cmd. Calling `start`
   * on an already-started saga (phase ≠ `"idle"`) is a no-op: the slice is
   * returned unchanged with no Cmds, so a stray re-`start` after a boot/replay
   * can't relaunch step 0 on top of an in-flight saga.
   */
  function start(
    state: SagaState<StepId>,
  ): readonly [SagaState<StepId>, readonly D[]] {
    if (state.phase !== "idle") return [state, []];

    const items = freshLedger();
    const first = stepAt(0);
    if (first === undefined) {
      // Empty transaction: trivially committed, no effect.
      return [{ ...state, phase: "committed", items }, []];
    }

    const next: SagaState<StepId> = {
      ...state,
      position: 0,
      phase: "running",
      items: setStatus(items, 0, "running"),
    };
    return [next, [first.do]];
  }

  /**
   * Record the in-flight step as committed and advance. PURE.
   *
   * Flips the current step's ledger record `running → done`, appends its id to
   * the compensation log, and:
   *   - if a next step exists, marks it `running` and emits its `do` Cmd;
   *   - if this was the last step, transitions to `committed` (terminal
   *     success) and emits no Cmd.
   *
   * `stepOk` while not `running` (idle, compensating, or already terminal) is a
   * no-op — the runtime's serial dispatch makes a true double-`stepOk`
   * impossible, but a stale success Msg after a boot/replay is real, and
   * swallowing it is the safe direction (the step's outcome is already recorded
   * in the ledger).
   */
  function stepOk(
    state: SagaState<StepId>,
  ): readonly [SagaState<StepId>, readonly D[]] {
    if (state.phase !== "running") return [state, []];

    const completed = state.position;
    const itemsDone = setStatus(state.items, completed, "done");
    const done = [...state.done, completed];
    const nextPosition = completed + 1;
    const nextStep = stepAt(nextPosition);

    if (nextStep === undefined) {
      // No next step — the last step committed, so the whole transaction
      // succeeded.
      return [{ ...state, done, items: itemsDone, phase: "committed" }, []];
    }

    const next: SagaState<StepId> = {
      ...state,
      position: nextPosition,
      done,
      items: setStatus(itemsDone, nextPosition, "running"),
    };
    return [next, [nextStep.do]];
  }

  /**
   * Pivot from winding to unwinding: the in-flight step failed. PURE.
   *
   * Flips the failed step's ledger record `running → failed`, records the
   * `error`, sets the direction bit, and begins compensation by emitting the
   * `undo` of the MOST-recently-completed step (the tail of the compensation
   * log) — rollback is the mirror of progress, so the last step that succeeded
   * is the first to be undone.
   *
   * If nothing completed forward (the first step itself failed), there is
   * nothing to compensate: the saga goes straight to `aborted` (terminal
   * failure) and emits no `undo`.
   *
   * `stepErr` while not `running` is a no-op (same stale-Msg reasoning as
   * `stepOk`): once a saga is already compensating or terminal, a late failure
   * Msg for an old step must not restart or re-pivot the unwind.
   */
  function stepErr(
    state: SagaState<StepId>,
    error: unknown,
  ): readonly [SagaState<StepId>, readonly U[]] {
    if (state.phase !== "running") return [state, []];

    const failed = state.position;
    const items = setStatus(state.items, failed, "failed");

    // Compensate the most-recently-completed step first. `lastDone === undefined`
    // means nothing completed forward (the first step itself failed) — there is
    // nothing to undo, so the saga aborts straight away. The guard narrows
    // `undoIndex` to `StepId` and `undoStep` to a present step without a
    // non-null assertion.
    const undoIndex = lastDone(state.done);
    const undoStep = undoIndex === undefined ? undefined : stepAt(undoIndex);
    if (undoIndex === undefined || undoStep === undefined) {
      return [
        { ...state, items, error, compensating: true, phase: "aborted" },
        [],
      ];
    }

    const next: SagaState<StepId> = {
      ...state,
      items,
      error,
      compensating: true,
      phase: "compensating",
      position: undoIndex,
    };
    return [next, [undoStep.undo]];
  }

  /**
   * Continue the rollback: the `undo` for the current compensation position
   * succeeded. PURE.
   *
   * Pops the just-undone step off the tail of the compensation log (flipping
   * its ledger record `done → cancelled` to mark it rolled back), and:
   *   - if more completed steps remain, emits the next one's `undo` (continuing
   *     in reverse) and moves `position` to it;
   *   - if the log is now empty, transitions to `aborted` (terminal failure —
   *     the saga is fully unwound) and emits no Cmd.
   *
   * `undoOk` while not `compensating` is a no-op (same stale-Msg reasoning as
   * the forward verbs): an `undo`-success Msg that arrives after the saga has
   * already finished unwinding must not pop a step that isn't there.
   */
  function undoOk(
    state: SagaState<StepId>,
  ): readonly [SagaState<StepId>, readonly U[]] {
    if (state.phase !== "compensating") return [state, []];

    // The tail of the log is the step we just compensated — mark it cancelled.
    // `undone === undefined` cannot happen while `compensating` (the phase is
    // only entered with a non-empty log), but the guard keeps the lookup total
    // and narrows `undone` to `StepId` without a non-null assertion.
    const undone = lastDone(state.done);
    if (undone === undefined) return [state, []];
    const remaining = state.done.slice(0, -1);
    const items = setStatus(state.items, undone, "cancelled");

    // The next step to compensate is the new tail of the log. `nextUndo`
    // narrows to `StepId` here and to a present step via `stepAt`, so the
    // continue-vs-terminate branch needs no non-null assertion.
    const nextUndo = lastDone(remaining);
    const nextStep = nextUndo === undefined ? undefined : stepAt(nextUndo);
    if (nextUndo === undefined || nextStep === undefined) {
      // Fully unwound — terminal failure.
      return [{ ...state, done: remaining, items, phase: "aborted" }, []];
    }

    const next: SagaState<StepId> = {
      ...state,
      done: remaining,
      items,
      position: nextUndo,
    };
    return [next, [nextStep.undo]];
  }

  /**
   * Halt the rollback: the `undo` for the current compensation position itself
   * FAILED. PURE.
   *
   * A failed compensation is a real-world fact — a refund that bounced, a hold
   * that won't release — and it must become visible terminal state, never leave
   * the saga wedged in `compensating` forever waiting for an `undoOk` that will
   * never come. So `undoErr`:
   *   - flips the in-flight compensation step's ledger record `done → failed`
   *     (its `undo` did not take, so it is NOT `cancelled`);
   *   - records the undo failure in `compensationError` (distinct from `error`,
   *     the forward failure that started the rollback);
   *   - transitions to the terminal `compensation_failed` phase and emits no
   *     Cmd. The compensation log is LEFT INTACT (`done` keeps the steps that
   *     were never rolled back) so the consumer can see exactly which steps
   *     still need hand reconciliation.
   *
   * `undoErr` while not `compensating` is a no-op (same stale-Msg reasoning as
   * the other verbs): an `undo`-failure Msg that arrives after the saga has
   * already settled must not re-pivot a terminal saga.
   */
  function undoErr(
    state: SagaState<StepId>,
    error: unknown,
  ): readonly [SagaState<StepId>, readonly U[]] {
    if (state.phase !== "compensating") return [state, []];

    // The step whose `undo` just failed is the current compensation position.
    // Its forward effect stands un-reversed, so its record goes `done → failed`,
    // not `cancelled`.
    const items = setStatus(state.items, state.position, "failed");
    return [
      {
        ...state,
        items,
        compensationError: error,
        phase: "compensation_failed",
      },
      [],
    ];
  }

  return {
    init: initSaga<StepId>,
    start,
    stepOk,
    stepErr,
    undoOk,
    undoErr,
    isCommitted,
    isAborted,
    isCompensationFailed,
    isSettled,
  };
}
