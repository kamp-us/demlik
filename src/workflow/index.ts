/**
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
 * **Forward-only (#124 scope).** This core advances FORWARD on success. A step
 * failure transitions to `failed` — a deliberate placeholder. Compensation /
 * Saga rollback (the reverse-ordered sequence of compensating activities) is
 * #125; the `// #125:` seam in {@link Workflow.onActivityErr} marks exactly
 * where that slice hooks in. DO-grain host wrapping is #126; the Saga demo is
 * #127.
 * This module is the pure reducer only — like `../raft/index.ts` is the pure
 * Raft reducer with the DO grain deferred to its `./do` sibling.
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
 */
export interface WorkflowStep<A> {
  /** Stable, human-readable step name — appears in the completed-step record. */
  readonly name: string;
  /** The opaque activity this step performs. Interpreted by the consumer. */
  readonly activity: A;
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

// ─────────────────────────────────────────────────────────────────────────────
// WorkflowState — the discriminated union. Invalid states unrepresentable.
//
// `status` is the discriminant. The in-flight `current` activity exists ONLY on
// `running`; `completed` carries the final `output`; `failed` carries the
// `failure`. There is no representable state with a current activity that is not
// running, nor a completed/failed state still holding one (acceptance crit. 1).
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
 * A workflow that failed on an activity. `failedStep` is the step whose
 * activity reported the failure; `failure` is the opaque failure payload; the
 * `completed` steps before it are preserved (this is the history #125's
 * compensation will roll back in reverse). No activity is in flight.
 *
 * #124 reaches this state and STOPS — forward-only. #125 turns this into the
 * entry point of compensation (see {@link reduceActivityErr}).
 */
export interface FailedWorkflow<A, R, F> {
  readonly status: "failed";
  readonly steps: readonly WorkflowStep<A>[];
  /** Steps that succeeded before the failure, in execution order. */
  readonly completed: readonly CompletedStep<A, R>[];
  /** The step whose activity failed. */
  readonly failedStep: WorkflowStep<A>;
  /** The opaque failure the activity reported. */
  readonly failure: F;
}

/**
 * The workflow's state — a discriminated union on `status`. The current
 * in-flight activity is reachable ONLY through the `running` variant, making
 * "an activity exists only while running" unrepresentable to violate.
 */
export type WorkflowState<A, R, F> =
  | RunningWorkflow<A, R>
  | CompletedWorkflow<A, R>
  | FailedWorkflow<A, R, F>;

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

/** The Cmd union this module emits. The owed/confirmed ledger events are not
 *  `WorkflowCmd`s — they are Msg variants persisted into the event log (see
 *  {@link EffectLedgerEvent}); the {@link WorkflowStep0} tuple carries them out
 *  alongside the dispatch Cmd so the host persists owed-before-dispatch. */
export type WorkflowCmd<A> = ActivityCmd<A>;

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
 *  the reducer flips to `failed`. #125 will instead begin compensation here. */
export interface ActivityErr<F> {
  readonly type: "activity_err";
  readonly id: DeliveryId;
  readonly failure: F;
}

/** The Msg union the reducer folds. */
export type WorkflowMsg<R, F> = ActivityOk<R> | ActivityErr<F>;

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
  readonly ledger: readonly EffectLedgerEvent<ActivityCmd<A>>[];
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
   * Fold an activity failure. Same id-match idempotency guard as
   * {@link onActivityOk}. On a match: confirm the owed activity on the ledger
   * and transition to `failed`, preserving the completed-step history.
   *
   * #124 STOPS here (forward-only). #125 replaces the `failed` transition with
   * the start of compensation — see the `// #125:` seam in the implementation.
   */
  onActivityErr(
    state: WorkflowState<A, R, F>,
    msg: ActivityErr<F>,
  ): WorkflowStep0<A, R, F>;

  /**
   * The owed-but-unconfirmed activity dispatch(es) to re-emit on activation,
   * rebuilt by folding the persisted ledger events. On a fresh / fully-advanced
   * workflow this is empty. The re-fired Cmd carries the SAME delivery id, so a
   * duplicate result is a no-op at the reducer (the id-match guard). This is the
   * cold-wake re-emit that makes activities exactly-once-observable despite the
   * at-least-once transport (acceptance criterion 3).
   */
  survivingActivities(
    ledgerEvents: Iterable<EffectLedgerEvent<ActivityCmd<A>>>,
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
  readonly events?: Iterable<EffectLedgerEvent<ActivityCmd<A>>>;
  readonly lastId?: DeliveryId;
}): Workflow<A, R, F> {
  // The #67 monotonic-id recorder. It owns the gap-free `deliveryId` and folds
  // an in-memory mirror of the ledger from the same owed/confirmed events the
  // host persists. Reused verbatim — activities ARE owed effects (do NOT
  // reinvent the ledger).
  const recorder = pendingEffectsLedger<ActivityCmd<A>>(restore);

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

  function oweActivity(
    step: WorkflowStep<A>,
    index: number,
  ): {
    readonly current: InFlightActivity<A>;
    readonly owed: EffectOwed<ActivityCmd<A>>;
    readonly cmd: ActivityCmd<A>;
  } {
    // The dispatch Cmd needs the delivery id, and the ledger event carries that
    // Cmd as its `effect` payload — so the id and the Cmd are mutually
    // dependent. Resolve the cycle by predicting the next id (`lastId() + 1`,
    // the recorder's gap-free monotonic rule), building the FINAL dispatch Cmd
    // with it, then handing that exact Cmd to `recorder.owe`. The recorder
    // issues that predicted id and folds the final Cmd into its mirror — so the
    // mirror, the persisted `effect_owed` event, and the dispatch Cmd all carry
    // one identical id and payload (no placeholder, no rebuild).
    const id = (recorder.lastId() + 1) as DeliveryId;
    const cmd: ActivityCmd<A> = {
      type: "workflow_activity",
      index,
      id,
      activity: step.activity,
    };
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
    const current: InFlightActivity<A> = { index, step, id };
    return { current, owed: event, cmd };
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

      // #125: COMPENSATION SEAM. Forward-only #124 transitions straight to
      // `failed`. The #125 compensation slice replaces this with a transition
      // to a `compensating` state that emits the completed steps' compensating
      // activities in REVERSE order (each itself a durable owed effect on this
      // same ledger) — `state.completed` is preserved here precisely so that
      // reverse walk has its history. Do NOT implement compensation in #124.
      const failed: FailedWorkflow<A, R, F> = {
        status: "failed",
        steps: state.steps,
        completed: state.completed,
        failedStep: state.current.step,
        failure: msg.failure,
      };
      return { state: failed, ledger: [confirmed], cmds: [] };
    },

    survivingActivities(ledgerEvents) {
      // Rebuild the ledger by folding the persisted events (NOT a side table),
      // then the surviving owed effects ARE the dispatch Cmds to re-fire —
      // each owed effect's payload is its dispatch Cmd, carrying the same id.
      const ledger: PendingEffectsLedger<ActivityCmd<A>> =
        foldLedger(ledgerEvents);
      return survivingEffects(ledger).map((owed) => owed.effect);
    },
  };

  /** Confirm an owed activity on the recorder's ledger, returning the
   *  `effect_confirmed` event to persist. The boolean (was-owed) is not needed
   *  by the reducer — the id-match guard above already gates on the in-flight
   *  activity — so it is discarded here. */
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
    const step =
      msg.type === "activity_ok"
        ? wf.onActivityOk(state, msg)
        : wf.onActivityErr(state, msg);
    state = step.state;
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
