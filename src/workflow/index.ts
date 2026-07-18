/**
 * @packageDocumentation
 * @demlik/tea/workflow — the durable-workflow runtime core (#124, the first
 * Phase-1 slice of the Temporal-style durable-workflow engine, epic #118).
 *
 * A workflow is a long-running, multi-step transaction whose every step (an
 * **activity**) is a side effect that may evict the actor mid-flight. The
 * substrate already solves "a state survives eviction" (the event-sourced
 * store) and "an owed effect survives eviction" (the `do/` pending-effects
 * ledger, #67). This module composes those two into the third primitive: a
 * **pure TEA reducer over a workflow's progress**, where each step is dispatched
 * as a durable owed effect and the next step is decided only after the previous
 * one's result is folded back in. That is exactly Temporal's contract — a
 * deterministic workflow function whose activities are the only impurity, so a
 * replay of the event log re-decides every step identically.
 *
 * The mapping onto TEA, mirroring `../raft`:
 *
 *   - **Reducer** — {@link createWorkflow}'s verbs (`init`, `onActivityOk`,
 *     `onActivityErr`) are the transition function over {@link WorkflowState}.
 *     PURE: they read no clock and no RNG. Wall time, randomness, retries — all
 *     impurity lives in the consumer's injected *interpret cell* (the thing that
 *     actually performs the activity `Cmd` and dispatches its result `Msg`).
 *     A workflow driven by a recorded result schedule re-decides bit-for-bit —
 *     the headline replay-determinism payoff (acceptance criterion 4).
 *   - **Cmd** — the activity dispatch is an {@link ActivityCmd}, recorded on the
 *     #67 ledger as an `effect_owed` BEFORE it is performed and `effect_confirmed`
 *     on its result. This module emits the Cmd literals; it performs NO side
 *     effects. The owed/confirmed events are persisted into the same log the
 *     reducer folds, so the ledger (and thus "which activity is still owed")
 *     rebuilds for free on cold wake — re-emit-on-wake is idempotent by the
 *     ledger's monotonic delivery id (acceptance criterion 3).
 *   - **Msg** — an activity result (`activity_ok` / `activity_err`) is a `Msg`
 *     the consumer routes back into a verb. The verb folds the result, records
 *     the completed step, and advances to the next activity (or to `completed`
 *     when the sequence is exhausted).
 *
 * **Invalid states unrepresentable.** The in-flight activity (`current`, with
 * its delivery id) lives ONLY on the `running` variant of {@link WorkflowState}.
 * A `completed` workflow carries its final output and no current activity; a
 * `failed` one carries its failure and no current activity. So "the current
 * activity exists only while running" is a type-level guarantee, not a runtime
 * convention (acceptance criterion 1).
 *
 * **Boundary with `@demlik/tea/saga` — the compensation test.** Both drive an
 * ordered multi-step transaction with reverse-order compensation (#125 here);
 * the line between them is whether every step carries a true inverse. Here
 * {@link WorkflowStep.compensation} is OPTIONAL — an irreversible step (a sent
 * email) is simply SKIPPED during the unwind, and the run still reaches a
 * terminal state. Saga's `SagaStep<D, U>` REQUIRES both `do` and `undo` — a
 * step without its inverse is unrepresentable, so full reversibility is a
 * type-level guarantee. Pick by the test: **every step must be reversible →
 * saga; some steps are irreversible but the run must finish → workflow.**
 * Cross to saga when you want the type system to enforce that every step can
 * be undone; stay here when the transaction includes steps that can't be.
 *
 * This module is the pure reducer only — like `../raft/index.ts` is the pure
 * Raft reducer with the DO grain deferred to its `./do` sibling (here #126).
 *
 * Generic over three opaque payloads, like raft's command generic: the activity
 * descriptor `A` (what a step asks to do — the consumer's interpret cell knows
 * how to perform it), the activity result `R`, and the failure `F`. The reducer
 * never inspects them; it only sequences them.
 *
 * NOT a substrate primitive: it depends only on the core `Cmd` type and the
 * sibling `../do` durable-effects ledger. Consumers reach it via the
 * `@demlik/tea/workflow` subpath.
 */

import {
  type DeliveryId,
  type EffectConfirmed,
  type EffectLedgerEvent,
  type EffectOwed,
  emptyLedger,
  foldLedger,
  type PendingEffectsLedger,
  pendingEffectsLedger,
  survivingEffects,
} from "../do/durable-effects";
import type { Cmd } from "../index";
import { routeWorkflowMsg } from "./route";

// ─────────────────────────────────────────────────────────────────────────────
// Steps — the static definition of a workflow.
//
// A workflow is defined by an ordered sequence of steps. A step is an activity
// descriptor: a stable `name` (for readability + correlation in the event log)
// plus the opaque `activity` payload the consumer's interpret cell performs.
// Steps are inert data; the reducer walks them in order.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One step of a workflow: a named activity descriptor. `A` is the opaque
 * payload the consumer's interpret cell knows how to perform (an HTTP call, a
 * sibling-grain message, a tool round-trip). The reducer never inspects
 * `activity` — it only sequences the steps and correlates results.
 *
 * A step may declare a **compensation** — the inverse activity that undoes the
 * forward one (cancel the reservation, refund the charge). Compensation is the
 * `{ do, undo }` pair of `@demlik/tea/saga` mapped onto the workflow: the step's
 * `activity` is the `do`, its `compensation` is the `undo`. The pair is the unit
 * of reversibility — a step that completed (its forward activity succeeded) is
 * exactly a step whose `compensation` must run, in reverse order, if a LATER
 * step fails (#125). A step WITHOUT a compensation contributes nothing to the
 * unwind: it is skipped during the reverse walk (an irreversible step — a sent
 * email — that the saga model treats as a no-op `undo`).
 */
export interface WorkflowStep<A> {
  /** Stable, human-readable step name — appears in the completed-step record. */
  readonly name: string;
  /** The opaque activity this step performs. Interpreted by the consumer. */
  readonly activity: A;
  /**
   * The opaque compensating (inverse) activity, performed in reverse order on a
   * downstream failure (#125). Optional: a step with no compensation is skipped
   * during the unwind. Interpreted by the consumer's interpret cell, exactly
   * like {@link activity}.
   */
  readonly compensation?: A;
}

/**
 * A completed step: the step that ran plus the result its activity produced.
 * The `running` state accumulates these in execution order, so the full
 * forward history is available to the consumer (and to #125's compensation,
 * which will walk it in reverse).
 */
export interface CompletedStep<A, R> {
  readonly step: WorkflowStep<A>;
  readonly result: R;
}

// ─────────────────────────────────────────────────────────────────────────────
// The in-flight activity — the bridge between the reducer and the #67 ledger.
//
// While `running`, exactly one activity is in flight. It carries the step it is
// performing AND the monotonic `deliveryId` the #67 ledger issued for it. The
// delivery id is the single correlation key: an `activity_ok`/`activity_err`
// Msg names the id it answers, the reducer matches it against `current.id`, and
// the ledger confirms that same id. Re-emit-on-wake re-fires the SAME id, so a
// duplicate result is a no-op (idempotent by delivery id, acceptance crit. 3).
// ─────────────────────────────────────────────────────────────────────────────

/** The activity currently in flight on a `running` workflow. */
export interface InFlightActivity<A> {
  /** The 0-based index of this step in the workflow's step sequence. */
  readonly index: number;
  /** The step whose activity is in flight. */
  readonly step: WorkflowStep<A>;
  /** The #67 ledger delivery id this activity was owed under (the dedup key). */
  readonly id: DeliveryId;
}

/**
 * The compensation currently in flight on a `compensating` workflow (#125). The
 * mirror of {@link InFlightActivity} for the reverse walk: exactly one
 * compensation is owed at a time, on the SAME #67 ledger, with its own monotonic
 * delivery id. `index` is the index (into `completed`/`steps`) of the step being
 * undone — the unwind walks these from high to low (strict reverse order).
 */
export interface InFlightCompensation<A> {
  /** The 0-based index (into the step sequence) of the step being compensated. */
  readonly index: number;
  /** The step whose compensation is in flight. */
  readonly step: WorkflowStep<A>;
  /** The #67 ledger delivery id this compensation was owed under (the dedup key). */
  readonly id: DeliveryId;
}

// ─────────────────────────────────────────────────────────────────────────────
// WorkflowState — the discriminated union. Invalid states unrepresentable.
//
// `status` is the discriminant. The in-flight `current` activity exists ONLY on
// `running` and `compensating`; `completed` carries the final `output`;
// `failed` / `failed_compensated` / `compensation_failed` carry the failure.
// There is no representable state with a current activity that is neither
// running nor compensating, nor a terminal state still holding one
// (acceptance crit. 1).
//
// The failure path (#125), mirroring `@demlik/tea/saga`'s phases:
//
//   running ──activity_err with completed steps──▶ compensating
//   running ──activity_err with NO completed steps──▶ failed   (empty rollback)
//   compensating ──all compensations confirmed──▶ failed_compensated
//   compensating ──a compensation itself fails──▶ compensation_failed
//
// `compensating` is the analogue of saga's `compensating`; `failed_compensated`
// of saga's `aborted` (fully unwound); `compensation_failed` of saga's
// `compensation_failed` (an `undo` bounced, partially unwound — visible state,
// never a workflow wedged in `compensating` forever).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A workflow in progress. Carries the ordered `completed` steps (forward
 * history), the `steps` it is sequencing, and the `current` in-flight activity
 * (with its ledger delivery id). `completed.length === current.index` always
 * holds — the current activity is the next step after the last completed one.
 */
export interface RunningWorkflow<A, R> {
  readonly status: "running";
  /** The full, static step sequence this workflow runs. */
  readonly steps: readonly WorkflowStep<A>[];
  /** Steps that have produced a result, in execution order. */
  readonly completed: readonly CompletedStep<A, R>[];
  /** The single activity in flight right now. */
  readonly current: InFlightActivity<A>;
}

/**
 * A workflow that ran every step to completion. `output` is the result of the
 * final step — the workflow's overall output. No activity is in flight.
 */
export interface CompletedWorkflow<A, R> {
  readonly status: "completed";
  readonly steps: readonly WorkflowStep<A>[];
  /** Every step, in execution order, with its result. */
  readonly completed: readonly CompletedStep<A, R>[];
  /** The final step's result — the workflow's output. */
  readonly output: R;
}

/**
 * A workflow that failed on an activity with NOTHING to compensate — the
 * forward failure happened with zero completed steps (the first activity
 * failed). `failedStep` is the step whose activity reported the failure;
 * `failure` is the opaque failure payload. `completed` is empty by construction:
 * a failure WITH completed steps pivots into {@link CompensatingWorkflow}
 * instead, so `failed` is precisely the empty-rollback terminal (the analogue
 * of saga's `aborted` reached straight from the first step). No activity is in
 * flight; this is terminal (#125 acceptance criterion 3).
 */
export interface FailedWorkflow<A, R, F> {
  readonly status: "failed";
  readonly steps: readonly WorkflowStep<A>[];
  /** Empty by construction — a failure with completed steps compensates instead. */
  readonly completed: readonly CompletedStep<A, R>[];
  /** The step whose activity failed. */
  readonly failedStep: WorkflowStep<A>;
  /** The opaque failure the activity reported. */
  readonly failure: F;
}

/**
 * A workflow unwinding after a forward failure (#125): the compensations of the
 * `completed` steps are being emitted in STRICT REVERSE order, one at a time, on
 * the same #67 ledger. The analogue of saga's `compensating` phase.
 *
 * `current` is the single compensation in flight (the mirror of `running`'s
 * in-flight activity). `compensated` records, in unwind order, the completed
 * steps whose compensation has confirmed — the reverse-walk's progress log, so
 * a cold wake resumes mid-rollback exactly. `failedStep`/`failure` carry the
 * forward failure that triggered the unwind (verbatim, never interpreted),
 * preserved for the consumer to read and to fold onto the terminal state.
 *
 * Invariant: the unwind walks `completed` from its tail toward index 0, skipping
 * steps with no compensation, so `current.index` is strictly below the index of
 * every entry in `compensated`.
 */
export interface CompensatingWorkflow<A, R, F> {
  readonly status: "compensating";
  readonly steps: readonly WorkflowStep<A>[];
  /** The completed forward steps, in execution order — the history being unwound. */
  readonly completed: readonly CompletedStep<A, R>[];
  /** The step whose forward activity failed, triggering the unwind. */
  readonly failedStep: WorkflowStep<A>;
  /** The opaque forward failure that triggered the unwind. Carried, never interpreted. */
  readonly failure: F;
  /** The single compensation in flight right now. */
  readonly current: InFlightCompensation<A>;
  /** Completed steps whose compensation has confirmed, in unwind (reverse) order. */
  readonly compensated: readonly CompletedStep<A, R>[];
}

/**
 * A workflow that failed forward and then fully unwound: every completed step's
 * compensation confirmed, in reverse order. Terminal. The analogue of saga's
 * `aborted` (fully unwound) — named `failed_compensated` to align with #125's
 * vocabulary. No activity or compensation is in flight.
 */
export interface FailedCompensatedWorkflow<A, R, F> {
  readonly status: "failed_compensated";
  readonly steps: readonly WorkflowStep<A>[];
  /** The forward steps that completed (and were each compensated), in execution order. */
  readonly completed: readonly CompletedStep<A, R>[];
  /** The step whose forward activity failed, triggering the (now-finished) unwind. */
  readonly failedStep: WorkflowStep<A>;
  /** The opaque forward failure that triggered compensation. Carried, never interpreted. */
  readonly failure: F;
}

/**
 * A workflow whose ROLLBACK itself failed: a compensation activity reported a
 * failure mid-unwind. Terminal, PARTIALLY unwound — the analogue of saga's
 * `compensation_failed`. A failed compensation is a real-world fact (a refund
 * that bounced, a hold that won't release) that must become visible terminal
 * state, never a workflow wedged in `compensating` forever.
 *
 * `compensated` is left intact (the steps already rolled back); `uncompensated`
 * is the step whose compensation bounced PLUS the steps still owed a
 * compensation behind it — exactly what the consumer must reconcile by hand.
 * `compensationFailure` is the rollback failure (distinct from `failure`, the
 * forward failure that started the unwind), carried verbatim.
 */
export interface CompensationFailedWorkflow<A, R, F> {
  readonly status: "compensation_failed";
  readonly steps: readonly WorkflowStep<A>[];
  /** The full completed-forward history, in execution order. */
  readonly completed: readonly CompletedStep<A, R>[];
  /** The step whose forward activity failed, triggering the unwind. */
  readonly failedStep: WorkflowStep<A>;
  /** The opaque forward failure that triggered compensation. Carried, never interpreted. */
  readonly failure: F;
  /** Completed steps successfully compensated before the rollback broke, in unwind order. */
  readonly compensated: readonly CompletedStep<A, R>[];
  /** The step whose compensation bounced. Its forward effect stands un-reversed. */
  readonly failedCompensationStep: WorkflowStep<A>;
  /** The opaque rollback failure (distinct from {@link failure}). Carried, never interpreted. */
  readonly compensationFailure: F;
}

/**
 * The workflow's state — a discriminated union on `status`. The current
 * in-flight activity is reachable ONLY through `running`, and the in-flight
 * compensation ONLY through `compensating`, making "an in-flight effect exists
 * only while the workflow is actively driving one" unrepresentable to violate.
 */
export type WorkflowState<A, R, F> =
  | RunningWorkflow<A, R>
  | CompletedWorkflow<A, R>
  | FailedWorkflow<A, R, F>
  | CompensatingWorkflow<A, R, F>
  | FailedCompensatedWorkflow<A, R, F>
  | CompensationFailedWorkflow<A, R, F>;

/** Every `status` discriminant of the {@link WorkflowState} union. */
export type WorkflowStatus = WorkflowState<unknown, unknown, unknown>["status"];

/**
 * The runtime accept-set of every {@link WorkflowStatus} — the single source of
 * truth the boundary snapshot parse keys off (see `do.ts`). Built from an
 * exhaustive `Record<WorkflowStatus, true>`, so adding a variant to the union
 * above without listing it here is a COMPILE error: the set can never silently
 * drift from the union again (the #312 regression, where the #125 compensation
 * statuses were missing and evicted-mid-rollback grains re-seeded fresh).
 */
export const WORKFLOW_STATUSES: ReadonlySet<string> = new Set(
  Object.keys({
    running: true,
    completed: true,
    failed: true,
    compensating: true,
    failed_compensated: true,
    compensation_failed: true,
  } satisfies Record<WorkflowStatus, true>),
);

// ─────────────────────────────────────────────────────────────────────────────
// Cmds — the activity dispatch. Recorded on the #67 ledger as an owed effect.
//
// `ActivityCmd` is the single Cmd this module emits: "perform the activity for
// step `index`, and the result you dispatch back must carry delivery id `id`".
// The consumer's interpret cell performs `activity` and dispatches an
// `ActivityOk`/`ActivityErr` Msg carrying the SAME id. The owed/confirmed
// ledger events ride alongside (see {@link WorkflowStep0}/the step tuple).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dispatch the in-flight activity. Routed through the consumer's `interpret`
 * over an injected activity port. The reducer emits this literal; it performs
 * no side effect. The result MUST be dispatched back as a Msg carrying `id`.
 */
export interface ActivityCmd<A> extends Cmd<"workflow_activity"> {
  /** The 0-based step index this activity belongs to. */
  readonly index: number;
  /** The #67 delivery id the result Msg must echo (the dedup key). */
  readonly id: DeliveryId;
  /** The opaque activity to perform. */
  readonly activity: A;
}

/**
 * Dispatch a compensation (#125). Same shape + ledger discipline as
 * {@link ActivityCmd} — a compensation is just another durable owed effect on
 * the same #67 ledger, with its own delivery id — but the consumer's interpret
 * cell performs the inverse `compensation` payload, and the result is dispatched
 * back as a {@link CompensationOk}/{@link CompensationErr} carrying the SAME id.
 * Distinguished by `type` so the consumer routes forward vs. inverse work to the
 * right port, and the re-emit-on-wake stays type-correct.
 */
export interface CompensationCmd<A> extends Cmd<"workflow_compensation"> {
  /** The 0-based step index whose compensation this is. */
  readonly index: number;
  /** The #67 delivery id the result Msg must echo (the dedup key). */
  readonly id: DeliveryId;
  /** The opaque compensating (inverse) activity to perform. */
  readonly compensation: A;
}

/** The Cmd union this module emits: forward activity dispatches AND (#125)
 *  reverse compensation dispatches. The owed/confirmed ledger events are not
 *  `WorkflowCmd`s — they are Msg variants persisted into the event log (see
 *  {@link EffectLedgerEvent}); the {@link WorkflowStep0} tuple carries them out
 *  alongside the dispatch Cmd so the host persists owed-before-dispatch. Both
 *  Cmd kinds are owed effects on the same ledger, so `survivingActivities`
 *  re-emits either kind on cold wake. */
export type WorkflowCmd<A> = ActivityCmd<A> | CompensationCmd<A>;

// ─────────────────────────────────────────────────────────────────────────────
// Msgs — activity results the consumer routes back into the reducer.
// ─────────────────────────────────────────────────────────────────────────────

/** An activity succeeded: `id` echoes the {@link ActivityCmd} it answers; the
 *  reducer matches it against `current.id`, records the completed step, and
 *  advances. */
export interface ActivityOk<R> {
  readonly type: "activity_ok";
  readonly id: DeliveryId;
  readonly result: R;
}

/** An activity failed (retries already exhausted by the consumer's interpret
 *  cell — this module does not retry). `id` echoes the {@link ActivityCmd};
 *  the reducer begins compensation (or settles `failed` when nothing has
 *  completed). */
export interface ActivityErr<F> {
  readonly type: "activity_err";
  readonly id: DeliveryId;
  readonly failure: F;
}

/** A compensation succeeded (#125): the inverse activity took. `id` echoes the
 *  {@link CompensationCmd} it answers; the reducer matches it against the
 *  in-flight compensation's id, records the step as compensated, and either
 *  emits the next compensation (continuing in reverse) or settles
 *  `failed_compensated` when the unwind is complete. A compensation produces no
 *  result the workflow carries — its only signal is "the undo took". */
export interface CompensationOk {
  readonly type: "compensation_ok";
  readonly id: DeliveryId;
}

/** A compensation itself failed (#125): the inverse activity bounced (a refund
 *  that won't go through). `id` echoes the {@link CompensationCmd}; the reducer
 *  halts the rollback at the terminal `compensation_failed` state — never wedged
 *  in `compensating` forever. */
export interface CompensationErr<F> {
  readonly type: "compensation_err";
  readonly id: DeliveryId;
  readonly failure: F;
}

/** The Msg union the reducer folds: forward activity results AND (#125) reverse
 *  compensation results. */
export type WorkflowMsg<R, F> =
  | ActivityOk<R>
  | ActivityErr<F>
  | CompensationOk
  | CompensationErr<F>;

/** Every `type` discriminant tag of the {@link WorkflowMsg} union. */
export type WorkflowMsgType = WorkflowMsg<unknown, unknown>["type"];

/**
 * The runtime accept-set of every {@link WorkflowMsgType} — the single source of
 * truth the boundary replay parse keys off (see `do.ts`). Built from an
 * exhaustive `Record<WorkflowMsgType, true>`, so adding a Msg variant to the
 * union above without listing it here is a COMPILE error: the set can never
 * silently drift from the union again (the #312 regression, where the #125
 * compensation result tags were missing and dropped from replay).
 */
export const WORKFLOW_MSG_TYPES: ReadonlySet<string> = new Set(
  Object.keys({
    activity_ok: true,
    activity_err: true,
    compensation_ok: true,
    compensation_err: true,
  } satisfies Record<WorkflowMsgType, true>),
);

// ─────────────────────────────────────────────────────────────────────────────
// The step tuple — the reducer's output shape.
//
// A verb returns the next `WorkflowState` PLUS the side-effect intents the host
// must enact, in the ORDER they must be enacted (owed-before-dispatch):
//
//   - `ledger` — the `effect_owed` / `effect_confirmed` events to PERSIST into
//     the same event log the reducer folds. A `running`-emitting verb owes the
//     new activity (and a verb that folded a prior result confirms it). Persist
//     these BEFORE the dispatch Cmd (the #67 "persist the intent before deliver"
//     rule) so an eviction between persist and dispatch re-fires on wake.
//   - `cmds` — the activity dispatch Cmd(s). Empty on a terminal transition.
//
// This is the same `readonly [state, cmds]` discipline as raft's `RaftStep`,
// extended with the ledger-events channel because activities ARE owed effects.
// ─────────────────────────────────────────────────────────────────────────────

/** A workflow reducer step: the next state, the ledger events to persist
 *  (owed-before-dispatch), and the activity Cmds to dispatch. */
export interface WorkflowStep0<A, R, F> {
  readonly state: WorkflowState<A, R, F>;
  /** Ledger events to persist into the event log, in order, BEFORE `cmds`. */
  readonly ledger: readonly EffectLedgerEvent<WorkflowCmd<A>>[];
  /** Activity dispatch Cmds, after the ledger events are durable. */
  readonly cmds: readonly WorkflowCmd<A>[];
}

// ─────────────────────────────────────────────────────────────────────────────
// createWorkflow — the factory. Returns the hook bag (init/verbs), mirroring
// how `createRaftNode` / `createAgent` shape their knobs. The factory owns the
// #67 monotonic-id recorder so every dispatched activity gets a gap-free
// delivery id; the recorder is rehydrated from the persisted ledger events on
// cold wake (see `restore`) so ids resume without gaps.
// ─────────────────────────────────────────────────────────────────────────────

/** The hook bag returned by {@link createWorkflow}. Spread its verbs into a
 *  machine; `init(steps)` seeds a fresh workflow and emits the first activity,
 *  the verbs fold results and advance, and `survivingActivities` re-emits the
 *  owed-but-unconfirmed dispatch on cold wake (idempotent by delivery id). */
export interface Workflow<A, R, F> {
  /**
   * Seed a fresh workflow over `steps` and dispatch its first activity.
   *
   * - Empty `steps` ⇒ a workflow with nothing to do completes only when it has
   *   an output; with no steps there is no output, so an empty sequence is
   *   rejected as a misuse (a workflow must have at least one step). The reducer
   *   never reaches `completed` without a final result to carry.
   * - Otherwise → `running` with `current` = step 0, owed on the ledger.
   */
  init(steps: readonly WorkflowStep<A>[]): WorkflowStep0<A, R, F>;

  /**
   * Fold an activity success. If `msg.id` does not match the in-flight
   * activity's id (a stale/duplicate result from re-emit-on-wake, or a result
   * for an already-advanced step), the state is returned UNCHANGED with no
   * effects — idempotent by delivery id (acceptance criterion 3). Otherwise:
   * record the completed step, confirm the owed activity on the ledger, and
   * either advance to the next step (owing its activity) or transition to
   * `completed` carrying the final result.
   *
   * Only meaningful on `running`; a result arriving for a terminal workflow is
   * a no-op (the workflow is done — at-least-once tolerates the late echo).
   */
  onActivityOk(
    state: WorkflowState<A, R, F>,
    msg: ActivityOk<R>,
  ): WorkflowStep0<A, R, F>;

  /**
   * Fold an activity failure (#125). Same id-match idempotency guard as
   * {@link onActivityOk}. On a match: confirm the owed activity on the ledger,
   * then PIVOT into compensation — walk the completed-step history in strict
   * reverse and owe the first declared compensation as a durable effect on the
   * same ledger, transitioning to `compensating`. If NO completed step declares
   * a compensation (the empty-rollback edge — the first activity failed, or
   * every completed step is irreversible), settle `failed` directly with
   * nothing to unwind.
   */
  onActivityErr(
    state: WorkflowState<A, R, F>,
    msg: ActivityErr<F>,
  ): WorkflowStep0<A, R, F>;

  /**
   * Fold a compensation success (#125). Same id-match idempotency guard against
   * the in-flight compensation. On a match: confirm the owed compensation,
   * record the step as compensated, and continue the reverse walk — owe the
   * next declared compensation strictly below the step just undone, or settle
   * `failed_compensated` when the unwind is complete. Only meaningful on
   * `compensating`; a result for a terminal/forward workflow is a no-op.
   */
  onCompensationOk(
    state: WorkflowState<A, R, F>,
    msg: CompensationOk,
  ): WorkflowStep0<A, R, F>;

  /**
   * Fold a compensation failure (#125). Same id-match idempotency guard. On a
   * match: confirm the owed compensation and HALT the rollback at the terminal
   * `compensation_failed` state — a bounced compensation is visible terminal
   * state to reconcile by hand, never a workflow wedged in `compensating`
   * forever. Mirrors `@demlik/tea/saga`'s `undoErr`.
   */
  onCompensationErr(
    state: WorkflowState<A, R, F>,
    msg: CompensationErr<F>,
  ): WorkflowStep0<A, R, F>;

  /**
   * The owed-but-unconfirmed dispatch(es) to re-emit on activation — a forward
   * activity OR (#125) a compensation, rebuilt by folding the persisted ledger
   * events. On a fresh / fully-settled workflow this is empty. The re-fired Cmd
   * carries the SAME delivery id, so a duplicate result is a no-op at the
   * reducer (the id-match guard). This is the cold-wake re-emit that makes both
   * activities AND compensations exactly-once-observable despite the
   * at-least-once transport (acceptance criterion 2 & 3) — including a
   * compensation owed mid-rollback when the actor was evicted.
   */
  survivingActivities(
    ledgerEvents: Iterable<EffectLedgerEvent<WorkflowCmd<A>>>,
  ): readonly WorkflowCmd<A>[];
}

/**
 * Build a workflow hook bag. The factory captures NO clock and NO RNG — pure
 * bookkeeping over the injected #67 recorder, exactly like
 * `pendingEffectsLedger`. `restore` rehydrates the monotonic delivery-id
 * counter from the persisted ledger events on cold wake, so re-dispatched
 * activities resume their ids without gaps.
 *
 * @param restore - the persisted ledger events (read back from the log) and/or
 *   the last issued delivery id, so the id counter resumes gap-free. Omit for a
 *   fresh workflow.
 */
export function createWorkflow<A, R, F>(restore?: {
  readonly events?: Iterable<EffectLedgerEvent<WorkflowCmd<A>>>;
  readonly lastId?: DeliveryId;
}): Workflow<A, R, F> {
  // The #67 monotonic-id recorder. It owns the gap-free `deliveryId` and folds
  // an in-memory mirror of the ledger from the same owed/confirmed events the
  // host persists. Reused verbatim — activities AND compensations ARE owed
  // effects on this one ledger (do NOT reinvent the ledger).
  const recorder = pendingEffectsLedger<WorkflowCmd<A>>(restore);

  /**
   * Owe + dispatch the activity for `step` at `index`: allocate its delivery
   * id, build the dispatch Cmd, and emit BOTH the `effect_owed` ledger event
   * (to persist first) and the dispatch Cmd. The owed effect IS the dispatch
   * Cmd, so a cold wake re-emits the identical dispatch by folding the ledger.
   *
   * Returns the running state's `current` plus the owed event + dispatch Cmd.
   */
  /** Index into a step sequence with a bounds-check narrowing away `undefined`
   *  (`noUncheckedIndexedAccess`). Every call site has already proven the index
   *  in range — this converts that proof into the non-optional type, throwing
   *  only on a logic error that should be unreachable. */
  function stepAt(
    steps: readonly WorkflowStep<A>[],
    index: number,
  ): WorkflowStep<A> {
    const step = steps[index];
    if (step === undefined) {
      throw new Error(
        `createWorkflow: step index ${index} out of range (length ` +
          `${steps.length}) — a reducer bounds proof was violated.`,
      );
    }
    return step;
  }

  /**
   * Predict the next delivery id, build the FINAL dispatch Cmd with it via
   * `build`, owe that exact Cmd on the #67 ledger, and assert the issued id
   * equals the prediction.
   *
   * The dispatch Cmd needs the delivery id, and the ledger event carries that
   * Cmd as its `effect` payload — so the id and the Cmd are mutually dependent.
   * Resolve the cycle by predicting the next id (`lastId() + 1`, the recorder's
   * gap-free monotonic rule), building the final Cmd, then handing that exact
   * Cmd to `recorder.owe`. The recorder issues the predicted id and folds the
   * final Cmd into its mirror — so the mirror, the persisted `effect_owed`
   * event, and the dispatch Cmd all carry one identical id and payload (no
   * placeholder, no rebuild). Shared by the forward owe ({@link oweActivity})
   * and the reverse owe ({@link oweCompensation}) so both halves of the
   * transaction allocate ids on the SAME monotonic ledger.
   */
  function oweOnLedger<C extends WorkflowCmd<A>>(
    build: (id: DeliveryId) => C,
  ): {
    readonly id: DeliveryId;
    readonly owed: EffectOwed<WorkflowCmd<A>>;
    readonly cmd: C;
  } {
    const id = (recorder.lastId() + 1) as DeliveryId;
    const cmd = build(id);
    const { id: issued, event } = recorder.owe(cmd);
    // Defensive: the prediction must equal the issued id, or the ledger mirror
    // and the dispatch Cmd would diverge. This holds by the recorder's gap-free
    // monotonic contract; assert it rather than silently carry a mismatch.
    if (issued !== id) {
      throw new Error(
        `createWorkflow: delivery-id prediction (${id}) diverged from the ` +
          `recorder's issued id (${issued}). The #67 recorder's monotonic ` +
          "counter is not gap-free as assumed — this is a substrate invariant " +
          "violation, not a recoverable condition.",
      );
    }
    return { id, owed: event, cmd };
  }

  function oweActivity(
    step: WorkflowStep<A>,
    index: number,
  ): {
    readonly current: InFlightActivity<A>;
    readonly owed: EffectOwed<WorkflowCmd<A>>;
    readonly cmd: ActivityCmd<A>;
  } {
    const { id, owed, cmd } = oweOnLedger<ActivityCmd<A>>((id) => ({
      type: "workflow_activity",
      index,
      id,
      activity: step.activity,
    }));
    const current: InFlightActivity<A> = { index, step, id };
    return { current, owed, cmd };
  }

  /**
   * Owe + dispatch the COMPENSATION for the completed step at `index` (#125):
   * the reverse-walk mirror of {@link oweActivity}. The compensation is a
   * durable owed effect on the SAME #67 ledger, so a cold wake mid-rollback
   * re-emits the identical compensation dispatch by folding the ledger
   * (acceptance criterion 2). `step.compensation` is required to be present —
   * the caller (the reverse walk) only owes compensations for steps that
   * declared one, skipping the rest.
   */
  function oweCompensation(
    step: WorkflowStep<A>,
    compensation: A,
    index: number,
  ): {
    readonly current: InFlightCompensation<A>;
    readonly owed: EffectOwed<WorkflowCmd<A>>;
    readonly cmd: CompensationCmd<A>;
  } {
    const { id, owed, cmd } = oweOnLedger<CompensationCmd<A>>((id) => ({
      type: "workflow_compensation",
      index,
      id,
      compensation,
    }));
    const current: InFlightCompensation<A> = { index, step, id };
    return { current, owed, cmd };
  }

  /**
   * Begin (or continue) the reverse walk from `completed`, owing the next
   * compensation strictly BELOW `belowIndex` (exclusive) that declares one. The
   * single source of truth for "what to undo next", shared by the failure pivot
   * ({@link Workflow.onActivityErr}) and each `compensation_ok` step
   * ({@link Workflow.onCompensationOk}). Steps with no compensation are SKIPPED
   * (they contribute nothing to the unwind — saga's no-op `undo`).
   *
   * Returns the next compensation to owe (its in-flight record + ledger event +
   * dispatch Cmd), or `null` when no compensable step remains below `belowIndex`
   * — the unwind is complete and the caller settles `failed_compensated`.
   */
  function oweNextCompensation(
    completed: readonly CompletedStep<A, R>[],
    belowIndex: number,
  ): {
    readonly current: InFlightCompensation<A>;
    readonly owed: EffectOwed<WorkflowCmd<A>>;
    readonly cmd: CompensationCmd<A>;
  } | null {
    // Walk the completed history from just below `belowIndex` toward 0 (strict
    // reverse order), stopping at the first step that declares a compensation.
    for (let i = belowIndex - 1; i >= 0; i--) {
      const entry = completed[i];
      // `completed[i]` is the i-th completed step; `i` is also its step index
      // (completed is in execution order, contiguous from 0 up to the failure).
      if (entry !== undefined && entry.step.compensation !== undefined) {
        return oweCompensation(entry.step, entry.step.compensation, i);
      }
    }
    return null;
  }

  /**
   * Assemble the next `compensating` step from a `base` (everything but the
   * in-flight compensation — carried identically from the failure pivot OR from
   * the prior compensating state) and the `next` compensation to owe. Both the
   * failure pivot ({@link Workflow.onActivityErr}) and each `compensation_ok`
   * advance ({@link Workflow.onCompensationOk}) continue the unwind the same way,
   * so the confirm-then-owe ledger discipline (`[confirmed, next.owed]`, dispatch
   * `[next.cmd]`) lives here once instead of mirrored at both call sites.
   */
  function continueCompensating(
    base: Omit<CompensatingWorkflow<A, R, F>, "current">,
    next: {
      readonly current: InFlightCompensation<A>;
      readonly owed: EffectOwed<WorkflowCmd<A>>;
      readonly cmd: CompensationCmd<A>;
    },
    confirmed: EffectConfirmed,
  ): WorkflowStep0<A, R, F> {
    const compensating: CompensatingWorkflow<A, R, F> = {
      ...base,
      current: next.current,
    };
    return {
      state: compensating,
      ledger: [confirmed, next.owed],
      cmds: [next.cmd],
    };
  }

  return {
    init(steps) {
      if (steps.length === 0) {
        throw new Error(
          "createWorkflow.init: a workflow must have at least one step. An " +
            "empty step sequence has no final result to carry into `completed`, " +
            "so it is unrepresentable as a completed workflow — reject it at the " +
            "boundary rather than admit a resultless terminal state.",
        );
      }
      const { current, owed, cmd } = oweActivity(stepAt(steps, 0), 0);
      const state: RunningWorkflow<A, R> = {
        status: "running",
        steps,
        completed: [],
        current,
      };
      return { state, ledger: [owed], cmds: [cmd] };
    },

    onActivityOk(state, msg) {
      // A result for a terminal workflow, or one whose id does not match the
      // in-flight activity, is a no-op — idempotent by delivery id. This is the
      // guard that makes re-emit-on-wake safe: a re-fired (already-folded)
      // activity's result arrives with an id that is no longer `current.id`.
      if (state.status !== "running" || msg.id !== state.current.id) {
        return { state, ledger: [], cmds: [] };
      }

      // Record the completed step and confirm the owed activity on the ledger.
      const confirmed: EffectConfirmed = confirm(state.current.id);
      const completedStep: CompletedStep<A, R> = {
        step: state.current.step,
        result: msg.result,
      };
      const completed = [...state.completed, completedStep];

      const nextIndex = state.current.index + 1;
      if (nextIndex >= state.steps.length) {
        // The final step's result is the workflow's output → `completed`.
        const done: CompletedWorkflow<A, R> = {
          status: "completed",
          steps: state.steps,
          completed,
          output: msg.result,
        };
        return { state: done, ledger: [confirmed], cmds: [] };
      }

      // Advance: owe + dispatch the next activity.
      const { current, owed, cmd } = oweActivity(
        stepAt(state.steps, nextIndex),
        nextIndex,
      );
      const running: RunningWorkflow<A, R> = {
        status: "running",
        steps: state.steps,
        completed,
        current,
      };
      // Persist the confirm of the prior activity AND the owe of the next, in
      // that order, before dispatching the next. (Confirm-then-owe keeps the
      // ledger holding at most one in-flight activity per workflow.)
      return { state: running, ledger: [confirmed, owed], cmds: [cmd] };
    },

    onActivityErr(state, msg) {
      if (state.status !== "running" || msg.id !== state.current.id) {
        return { state, ledger: [], cmds: [] };
      }
      const confirmed: EffectConfirmed = confirm(state.current.id);

      // #125: the forward failure PIVOTS into compensation. Mirroring saga's
      // `stepErr`: walk the completed history in strict reverse, owing the
      // first declared compensation as a durable effect on this SAME ledger.
      // `state.completed` is preserved precisely so this reverse walk has its
      // history.
      const next = oweNextCompensation(state.completed, state.completed.length);

      if (next === null) {
        // Empty rollback: no completed step declares a compensation (the first
        // activity failed, OR every completed step is irreversible). The
        // analogue of saga aborting straight from the first step — settle
        // `failed` directly, nothing to unwind (acceptance criterion 3).
        const failed: FailedWorkflow<A, R, F> = {
          status: "failed",
          steps: state.steps,
          completed: state.completed,
          failedStep: state.current.step,
          failure: msg.failure,
        };
        return { state: failed, ledger: [confirmed], cmds: [] };
      }

      // Pivot to `compensating`, emitting the first compensation. Confirm the
      // failed forward activity AND owe the first compensation, in that order,
      // before dispatching it (the same confirm-then-owe ledger discipline as
      // the forward advance — at most one in-flight effect per workflow). The
      // `base` here is FRESH from the failing activity (failedStep/failure from
      // `state.current`/`msg`, empty `compensated`).
      return continueCompensating(
        {
          status: "compensating",
          steps: state.steps,
          completed: state.completed,
          failedStep: state.current.step,
          failure: msg.failure,
          compensated: [],
        },
        next,
        confirmed,
      );
    },

    onCompensationOk(state, msg) {
      // A compensation result for a non-compensating workflow, or one whose id
      // does not match the in-flight compensation, is a no-op — idempotent by
      // delivery id, the same re-emit-on-wake guard as the forward verbs.
      if (state.status !== "compensating" || msg.id !== state.current.id) {
        return { state, ledger: [], cmds: [] };
      }

      // Confirm the owed compensation and record the step as compensated.
      const confirmed: EffectConfirmed = confirm(state.current.id);
      const undoneStep = state.completed[state.current.index];
      if (undoneStep === undefined) {
        throw new Error(
          `createWorkflow.onCompensationOk: compensation index ` +
            `${state.current.index} has no completed step — a reverse-walk ` +
            "bounds proof was violated.",
        );
      }
      const compensated = [...state.compensated, undoneStep];

      // Continue the reverse walk strictly below the step just undone, skipping
      // steps with no compensation.
      const next = oweNextCompensation(state.completed, state.current.index);

      if (next === null) {
        // Fully unwound → `failed_compensated` (saga's `aborted`).
        const settled: FailedCompensatedWorkflow<A, R, F> = {
          status: "failed_compensated",
          steps: state.steps,
          completed: state.completed,
          failedStep: state.failedStep,
          failure: state.failure,
        };
        return { state: settled, ledger: [confirmed], cmds: [] };
      }

      // Continue the unwind. The `base` here CARRIES failedStep/failure from the
      // prior compensating `state` and the accumulated `compensated` list.
      return continueCompensating(
        {
          status: "compensating",
          steps: state.steps,
          completed: state.completed,
          failedStep: state.failedStep,
          failure: state.failure,
          compensated,
        },
        next,
        confirmed,
      );
    },

    onCompensationErr(state, msg) {
      // Same id-match idempotency guard as the other verbs.
      if (state.status !== "compensating" || msg.id !== state.current.id) {
        return { state, ledger: [], cmds: [] };
      }
      // Confirm the owed compensation (the dispatch is no longer owed — it was
      // delivered and answered, just with a failure), then HALT the rollback at
      // the terminal `compensation_failed` state. Mirroring saga's `undoErr`: a
      // bounced compensation is a real-world fact the consumer must reconcile by
      // hand, never a workflow wedged in `compensating` forever. `compensated`
      // (already rolled back) is left intact for the consumer to read.
      const confirmed: EffectConfirmed = confirm(state.current.id);
      const halted: CompensationFailedWorkflow<A, R, F> = {
        status: "compensation_failed",
        steps: state.steps,
        completed: state.completed,
        failedStep: state.failedStep,
        failure: state.failure,
        compensated: state.compensated,
        failedCompensationStep: state.current.step,
        compensationFailure: msg.failure,
      };
      return { state: halted, ledger: [confirmed], cmds: [] };
    },

    survivingActivities(ledgerEvents) {
      // Rebuild the ledger by folding the persisted events (NOT a side table),
      // then the surviving owed effects ARE the dispatch Cmds to re-fire — each
      // owed effect's payload is its dispatch Cmd (a forward activity OR a
      // compensation), carrying the same id.
      const ledger: PendingEffectsLedger<WorkflowCmd<A>> =
        foldLedger(ledgerEvents);
      return survivingEffects(ledger).map((owed) => owed.effect);
    },
  };

  /** Confirm an owed activity (or compensation) on the recorder's ledger,
   *  returning the `effect_confirmed` event to persist. The boolean (was-owed)
   *  is not needed by the reducer — the id-match guard above already gates on
   *  the in-flight effect — so it is discarded here. */
  function confirm(id: DeliveryId): EffectConfirmed {
    return recorder.confirm(id).event;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// foldWorkflow — the pure replay fold. The determinism contract (acceptance
// criterion 4) in one function: fold a workflow's full event log — its `init`
// steps plus the ordered activity-result Msgs — back into a `WorkflowState`,
// reading no clock and no RNG. Two folds of the same log produce byte-identical
// state, because every decision is a pure function of (state, msg) and the
// delivery ids are reissued in the same order from the same fresh recorder.
//
// This is the workflow-level twin of `foldLedger`: the host's `replay()` over
// the event-sourced store re-runs exactly this fold to rebuild a workflow on
// cold wake. Kept here (not only in the host, #126) so the determinism contract
// is provable against the pure core alone.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Replay a workflow from its event log: seed over `steps`, then fold each
 * activity-result `Msg` in order. Returns the final {@link WorkflowState}.
 *
 * Determinism: a freshly-constructed {@link createWorkflow} reissues delivery
 * ids monotonically from 0, and the reducer reads no ambient state — so two
 * calls with the same `steps` + `msgs` return deeply-equal states (and equal
 * `JSON.stringify`). This is the byte-identity property #124 pins.
 *
 * Note this folds ONLY the result Msgs; the `init` dispatch + per-step
 * owe/confirm ledger events are an internal effect channel reconstructed by the
 * fresh recorder, not part of the replayed Msg log — exactly as the activity
 * results are the only thing the consumer records and replays.
 */
export function foldWorkflow<A, R, F>(
  steps: readonly WorkflowStep<A>[],
  msgs: Iterable<WorkflowMsg<R, F>>,
): WorkflowState<A, R, F> {
  const wf = createWorkflow<A, R, F>();
  let { state } = wf.init(steps);
  for (const msg of msgs) {
    // Route each result Msg to its verb via the shared dispatcher. The forward
    // results (`activity_*`) and the reverse compensation results
    // (`compensation_*`, #125) are folded by the same fresh recorder, so a
    // replay across a failure+compensation sequence re-issues every delivery id
    // in identical order — byte-identity holds end to end (acceptance
    // criterion 4).
    state = routeWorkflowMsg(wf, state, msg).state;
  }
  return state;
}

// Re-export the durable-effects types a consumer needs to persist + replay a
// workflow's ledger (the owed/confirmed events, the delivery id, the empty
// seed) without reaching into the `../do` subpath directly.
export {
  type DeliveryId,
  type EffectConfirmed,
  type EffectLedgerEvent,
  type EffectOwed,
  emptyLedger,
};
