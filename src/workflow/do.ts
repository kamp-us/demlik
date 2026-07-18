/// <reference types="@cloudflare/workers-types" />
/**
 * `@demlik/tea/workflow/do` — a durable workflow as a virtual actor on a
 * Durable Object (#126, child of the durable-workflow epic #118).
 *
 * The pure reducer lives in `./index` (`createWorkflow` — #124's forward-only
 * core). This file is the HOST/persistence wiring only: it reuses the `../do`
 * event-sourced store, threads persist-before-deliver, rebuilds the workflow by
 * replaying the persisted log on cold wake, and re-emits the owed-but-
 * unconfirmed activity on activation. The reducer stays pure — the store and
 * the activity-performer arrive as injected ports.
 *
 * Three workflow responsibilities map onto three host duties (the `../raft/do`
 * pattern, adapted from a consensus node to an activity-driven workflow):
 *
 *   1. **Persist-before-deliver.** durable-effects.md's "persist the intent
 *      before deliver" rule, run at the activity-result granularity: the
 *      activity-result `Msg` (`activity_ok` / `activity_err`) is appended to the
 *      durable event log BEFORE the next activity `Cmd` is performed. The
 *      workflow's event log (the result Msgs) IS the durable record of progress.
 *      {@link WorkflowGrain}'s `deliver` awaits the store append, THEN performs
 *      the next activity. A crash between the two re-performs nothing the
 *      workflow had not already durably recorded — and the re-emit-on-wake path
 *      (3) covers the dispatch that the crash interrupted.
 *
 *   2. **Cold-wake replay.** A grain is a disposable process over durable
 *      storage (`.patterns/tea/durable-actors.md`): on activation the store's
 *      `load()` folds `init → update*` over the persisted result-Msg log (the
 *      SAME pure verbs the live runtime ran, via {@link foldWorkflow}'s shape),
 *      so a workflow rebuilt on cold wake is byte-identical to the never-evicted
 *      one after the same activity-result sequence — the #124 determinism
 *      property (acceptance criterion 4), now over the DO grain. The workflow
 *      advances across cold activations with NO warm state between them; the
 *      durable checkpoint is the continuation (the workflow hibernates between
 *      activity results — it is activity-driven, not timer-driven, so there is
 *      no give-up alarm).
 *
 *   3. **Re-emit on wake.** The in-flight activity is an owed effect on the #67
 *      ledger (owed before dispatch, confirmed on its result). On activation the
 *      grain rebuilds the ledger by folding the persisted owed/confirmed events
 *      and re-fires the surviving (owed-but-unconfirmed) dispatch via
 *      {@link Workflow.survivingActivities} (the #124 re-emit path). The re-fired
 *      Cmd carries the SAME delivery id, so a duplicate result is a no-op at the
 *      reducer's id-match guard — exactly-once-observable despite the at-least-
 *      once transport. A workflow evicted mid-activity resumes and completes.
 *
 * The activity performer is a thin injected port ({@link ActivityPerformer}) —
 * tests fake it; a real DO grain may back it with an HTTP call, a sibling-grain
 * message, or a tool round-trip. PURE-data in, result `Msg` out: the reducer
 * never names it; only the grain's `deliver` step does, and only AFTER the
 * persist.
 *
 * This module is the host wrapping only — like `../raft/do.ts` wraps the pure
 * Raft reducer. The pure `createWorkflow` / `foldWorkflow` surface in `./index`
 * is imported read-only; nothing here mutates the workflow vocabulary.
 */

import {
  type DeliveryId,
  doEventSourcedStore,
  type EffectLedgerEvent,
  type EventSourcedStore,
} from "../do";
import {
  type Cmd,
  defineMachine,
  type Machine,
  type Runtime,
  run,
  type Store,
} from "../index";
import {
  type ActivityErr,
  type ActivityOk,
  createWorkflow,
  WORKFLOW_MSG_TYPES,
  WORKFLOW_STATUSES,
  type Workflow,
  type WorkflowCmd,
  type WorkflowMsg,
  type WorkflowState,
  type WorkflowStep,
} from "./index";
import { routeWorkflowMsg } from "./route";

// ===========================================================================
// Ports — the impure edges the grain injects (kept OUT of the pure reducer)
// ===========================================================================

/**
 * The outbound effect performer. The grain hands each owed {@link WorkflowCmd}
 * to `perform`; the consumer performs it (an HTTP call, a sibling-grain message,
 * a tool round-trip) and returns the result `Msg`. The owed cmd is either a
 * forward activity (→ {@link ActivityOk}/{@link ActivityErr}) or — once #125's
 * compensation is wired — a reverse compensation (→ `CompensationOk`/`Err`); both
 * carry the SAME delivery id the Cmd named. Retries are the performer's business
 * (the engine does not retry); it surfaces a terminal outcome. PURE-data in,
 * result out — the reducer never names this; only the grain's `deliver` step
 * does, and only AFTER the persist.
 */
export interface ActivityPerformer<A, R, F> {
  perform(cmd: WorkflowCmd<A>): Promise<WorkflowMsg<R, F>>;
}

/**
 * Everything {@link workflowGrain} needs from the Durable Object: its
 * `DurableObjectStorage` (the event log + snapshot live here) and the activity
 * performer (outbound activity dispatch). A workflow is activity-driven, not
 * timer-driven, so — unlike `../raft/do`'s `RaftGrainCtx` — there is no alarm
 * and no clock at the host edge.
 */
export interface WorkflowGrainCtx<A, R, F> {
  readonly storage: DurableObjectStorage;
  readonly performer: ActivityPerformer<A, R, F>;
}

/** Construction options for {@link workflowGrain}. */
export interface WorkflowGrainOptions<A> {
  /** The static, ordered step sequence the workflow runs (>= 1 step). */
  readonly steps: readonly WorkflowStep<A>[];
  /**
   * Snapshot retention — take a snapshot every N appended events (forwarded to
   * `doEventSourcedStore`; default 100). Bounds replay length; never changes the
   * fold's result.
   */
  readonly snapshotEvery?: number;
}

// ===========================================================================
// The grain's durable state — the WorkflowState plus its replayed ledger tail.
//
// The event log is the activity-result Msg stream (what the consumer records,
// exactly as #124's `foldWorkflow` folds). But `survivingActivities` needs the
// owed/confirmed LEDGER events to know which activity is still owed on wake.
// Those events are not separately persisted: they are a deterministic function
// of the folded result Msgs. So the grain carries them ALONGSIDE the
// `WorkflowState` in the machine state, accumulating the `ledger` channel each
// verb emits. The fold of the result-Msg log thus rebuilds BOTH the state and
// the ledger tail for free — no side table (the #67 discipline).
// ===========================================================================

/**
 * The grain's machine state: the workflow's {@link WorkflowState} plus the
 * accumulated #67 ledger events (the owe/confirm channel the verbs emit).
 * Carried together so a cold-wake fold of the result-Msg log rebuilds the
 * ledger tail in lockstep with the state — `survivingActivities` reads
 * `ledgerEvents` to re-fire the owed-but-unconfirmed activity.
 */
interface WorkflowGrainState<A, R, F> {
  readonly workflow: WorkflowState<A, R, F>;
  /** The ordered owe/confirm events emitted so far — folds the #67 ledger. */
  readonly ledgerEvents: readonly EffectLedgerEvent<WorkflowCmd<A>>[];
}

// ===========================================================================
// The reducer-backed machine — pure, the SAME verbs the live runtime folds
// ===========================================================================

/** This grain emits no Subs: a workflow is activity-driven, not timer-driven. */
type WorkflowGrainSub = never;

/**
 * The grain's machine Cmd union. The reducer emits the activity dispatch Cmd; it
 * is interpreted as an empty no-op in the runtime, because the grain (not the
 * machine) performs the activity, and only AFTER the persist (persist-before-
 * deliver lives entirely in the host).
 */
type WorkflowGrainCmd<A> = WorkflowCmd<A>;

/** The grain's machine type alias. */
type WorkflowMachine<A, R, F> = Machine<
  WorkflowGrainState<A, R, F>,
  WorkflowMsg<R, F>,
  WorkflowGrainCmd<A>,
  WorkflowGrainSub,
  WorkflowGrainCtx<A, R, F>
>;

/**
 * A mutable holder for the workflow instance. The recorder inside a
 * {@link Workflow} owns the #67 monotonic delivery-id counter, which is stateful
 * across the verbs. On a cold-wake fold that starts from a SNAPSHOT (not an
 * empty log), `init`'s rehydrate branch must resume that counter gap-free from
 * the snapshot's ledger tail — so it rebuilds `wf` from the snapshot's
 * `ledgerEvents`. The `update` cells and `survivingActivities` read through the
 * holder so they see the rehydrated recorder, not the pre-fold one.
 */
interface WorkflowRef<A, R, F> {
  current: Workflow<A, R, F>;
}

/**
 * Build the pure `Machine` for one workflow. `init` seeds a fresh workflow over
 * `steps` (owing + dispatching the first activity) or rehydrates a folded state
 * — rebuilding the recorder from the snapshot's ledger tail so delivery ids
 * resume gap-free. Each `update` cell routes the activity-result Msg into the
 * matching `createWorkflow` verb, accumulating BOTH the next `WorkflowState` and
 * the verb's `ledger` events. `interpret` is EMPTY by design: the grain performs
 * the activity post-persist, so the reducer never names the performer and the
 * persist-before-deliver ordering lives entirely in the host.
 *
 * `ref` holds the SHARED workflow instance — the live runtime and the cold-wake
 * fold thread it through. On a cold-wake fold from an empty log a freshly-
 * constructed `wf` reissues delivery ids monotonically from 0, exactly as
 * `foldWorkflow` does, so the rebuilt state + ledger are byte-identical to the
 * never-evicted run (the #124 determinism contract); from a snapshot, `init`
 * resumes the counter from the snapshot's ledger tail so the SAME holds.
 */
function workflowMachine<A, R, F>(
  ref: WorkflowRef<A, R, F>,
  steps: readonly WorkflowStep<A>[],
): WorkflowMachine<A, R, F> {
  return defineMachine<
    WorkflowGrainState<A, R, F>,
    WorkflowMsg<R, F>,
    WorkflowGrainCmd<A>,
    WorkflowGrainSub,
    WorkflowGrainCtx<A, R, F>
  >({
    // Fresh boot seeds the workflow over `steps`, owing + dispatching the first
    // activity (the owe ledger event is captured into the carried state, the
    // dispatch Cmd is emitted for the grain to perform post-persist). A cold
    // wake from a SNAPSHOT rehydrates the recorder from the snapshot's ledger
    // tail (so ids resume gap-free) and hands back the folded state verbatim
    // (init's rehydrate passthrough — TEA invariant 2; the owed dispatch the
    // fold reissues is re-emitted by the grain via `survivingActivities`, NOT by
    // replaying init's Cmd).
    init: (loaded) => {
      if (loaded) {
        ref.current = createWorkflow<A, R, F>({ events: loaded.ledgerEvents });
        return [loaded, []];
      }
      const { state, ledger, cmds } = ref.current.init(steps);
      return [{ workflow: state, ledgerEvents: ledger }, cmds];
    },
    // Every cell delegates to `routeWorkflowMsg` — the ONE WorkflowMsg → verb
    // routing table, shared with the pure replay `foldWorkflow`. #125
    // compensation folds the same way: a failed activity pivots to reverse-order
    // rollback and each compensation result advances the unwind, the verb
    // returning the same { state, ledger, cmds } shape whose dispatch Cmd (a
    // `workflow_activity` OR `workflow_compensation`) is performed post-persist.
    update: {
      activity_ok: (s, m) =>
        stepState(s, routeWorkflowMsg(ref.current, s.workflow, m)),
      activity_err: (s, m) =>
        stepState(s, routeWorkflowMsg(ref.current, s.workflow, m)),
      compensation_ok: (s, m) =>
        stepState(s, routeWorkflowMsg(ref.current, s.workflow, m)),
      compensation_err: (s, m) =>
        stepState(s, routeWorkflowMsg(ref.current, s.workflow, m)),
    },
    // No Cmds are interpreted in-runtime: the grain performs the activity OR
    // compensation post-persist. The empty cells keep the dispatch Cmds pure
    // data intents (one per WorkflowCmd member, #125 widened the union).
    interpret: {
      workflow_activity: async () => {},
      workflow_compensation: async () => {},
    },
  });
}

/**
 * Fold one verb result into the grain's carried state: advance the
 * `WorkflowState` and APPEND the verb's owe/confirm ledger events onto the
 * accumulated tail (so a cold-wake fold rebuilds the ledger in lockstep), and
 * forward the verb's dispatch Cmds for the grain to perform post-persist.
 *
 * A no-op verb result (the id-match idempotency guard fired — a stale/duplicate
 * result from re-emit-on-wake) returns empty `ledger` + `cmds`, so the carried
 * state and ledger tail are unchanged.
 */
function stepState<A, R, F>(
  prev: WorkflowGrainState<A, R, F>,
  step: {
    readonly state: WorkflowState<A, R, F>;
    readonly ledger: readonly EffectLedgerEvent<WorkflowCmd<A>>[];
    readonly cmds: readonly WorkflowGrainCmd<A>[];
  },
): readonly [WorkflowGrainState<A, R, F>, readonly WorkflowGrainCmd<A>[]] {
  const next: WorkflowGrainState<A, R, F> = {
    workflow: step.state,
    ledgerEvents:
      step.ledger.length === 0
        ? prev.ledgerEvents
        : [...prev.ledgerEvents, ...step.ledger],
  };
  return [next, step.cmds];
}

// ===========================================================================
// The durable grain — persist-before-deliver + cold-wake replay + re-emit
// ===========================================================================

/**
 * The grain handle returned by {@link workflowGrain}. `deliver(msg)` folds one
 * activity-result Msg durably (persist-before-deliver), THEN performs the next
 * owed activity and folds its result — driving the workflow forward until it
 * reaches a terminal state or owes nothing more. `state()` reads the current
 * (post-recovery) `WorkflowState`.
 */
export interface WorkflowGrain<A, R, F> {
  /**
   * Fold one inbound activity-result `Msg` durably and drive the workflow to its
   * next durable rest point. Persist-before-deliver: the result Msg is appended
   * to the durable log BEFORE the next activity is performed. After the append
   * settles, the newly-owed activity (if any) is performed via the injected
   * performer, and its result is `deliver`-ed in turn — so a single top-level
   * `deliver` of the first result drives the whole remaining workflow, each step
   * durably checkpointed before the next is performed. A terminal transition
   * owes nothing and the recursion stops. Returns the terminal/at-rest state.
   */
  deliver(msg: WorkflowMsg<R, F>): Promise<WorkflowState<A, R, F>>;
  /**
   * Drive the workflow from its activation state: perform the owed-but-
   * unconfirmed activity re-emitted on wake (or the freshly-dispatched first
   * activity on a fresh boot) and fold its result, advancing to the next rest
   * point. Idempotent — a re-woken grain whose owed activity already produced a
   * (persisted) result re-fires the same delivery id, which the reducer's
   * id-match guard discards. A no-op when nothing is owed (terminal workflow).
   */
  drive(): Promise<WorkflowState<A, R, F>>;
  /** The current `WorkflowState` (after cold-wake recovery has folded the log). */
  state(): WorkflowState<A, R, F>;
  /** Tear down the underlying runtime (releases the store). */
  close(): Promise<void>;
}

/**
 * Activate a workflow as a durable grain over a Durable Object.
 *
 * Returns a Promise because activation REPLAYS: the event-sourced store's
 * `load()` folds the persisted result-Msg log on top of the latest snapshot
 * BEFORE the grain serves anything (cold-wake replay, acceptance criterion 4).
 * The same call on a fresh DO seeds the workflow over `steps` and owes its first
 * activity.
 *
 * Wiring, in order (the persist-before-deliver discipline):
 *   1. `run(machine, { store: es.store })` — `store.load()` folds the result-Msg
 *      log → rebuilt `WorkflowState` + ledger tail (or a fresh seed).
 *   2. `runtime.observe(append)` — every APPLIED result Msg is appended to the
 *      durable log. The append Promise is tracked so `deliver` can AWAIT it
 *      before performing the next activity (persist-before-deliver).
 *   3. After recovery, re-emit the owed-but-unconfirmed activity (re-emit on
 *      wake) — idempotent by delivery id.
 *
 * NOTE the grain does NOT auto-drive in the activator: the caller drives via
 * `drive()` (a fresh boot) or `deliver(result)` (an inbound result). This keeps
 * the activator side-effect-free until the host decides to advance — the
 * performer is invoked only from `deliver`/`drive`, never from `load`/replay
 * (recovery.md: side effects are suppressed on replay).
 */
export async function workflowGrain<A, R, F>(
  ctx: WorkflowGrainCtx<A, R, F>,
  opts: WorkflowGrainOptions<A>,
): Promise<WorkflowGrain<A, R, F>> {
  const { steps } = opts;
  // The shared workflow instance — owns the #67 monotonic-id recorder. A fresh
  // one here reissues delivery ids from 0; on cold wake the fold re-runs every
  // verb over the same result-Msg log, reissuing the SAME ids in the SAME order
  // (the #124 determinism contract), so the rebuilt ledger tail matches. Held in
  // a ref so a snapshot-replay can rehydrate the recorder (see `workflowMachine`
  // `init`); all references (the verbs, `owedActivities`) read through `ref`.
  const ref: WorkflowRef<A, R, F> = { current: createWorkflow<A, R, F>() };
  const machine = workflowMachine<A, R, F>(ref, steps);

  // The event-sourced store: appends each applied result Msg to the durable log
  // and rebuilds state by folding the SAME verbs on activation. The fold only
  // uses `init` + `update`, so `doEventSourcedStore` erases the machine's
  // Cmd/Sub to the substrate base unions (its factory comment: "pinning the
  // machine's concrete C/U would force every caller to thread them through").
  // The `interpret` map is contravariant in its Cmd param, so a concrete
  // `WorkflowCmd<A>` machine is not STRUCTURALLY assignable to the erased
  // `Machine<S, M, Cmd, Sub, Ctx>` parameter even though it is sound for the
  // fold; the cast crosses that erasure boundary deliberately (the live `run`
  // below keeps the machine's precise `WorkflowCmd<A>` / `never` types).
  const es: EventSourcedStore<
    WorkflowGrainState<A, R, F>,
    WorkflowMsg<R, F>
  > = doEventSourcedStore<
    WorkflowGrainState<A, R, F>,
    WorkflowMsg<R, F>,
    WorkflowGrainCtx<A, R, F>
  >(
    ctx.storage,
    machine as unknown as Parameters<
      typeof doEventSourcedStore<
        WorkflowGrainState<A, R, F>,
        WorkflowMsg<R, F>,
        WorkflowGrainCtx<A, R, F>
      >
    >[1],
    ctx,
    {
      snapshotEvery: opts.snapshotEvery,
      parse: parseWorkflowGrainState<A, R, F>,
      parseEvent: parseWorkflowMsg<R, F>,
    },
  );

  const store: Store<WorkflowGrainState<A, R, F>> = es.store;

  // The live runtime. `load()` runs here (the cold-wake fold); `ready` resolves
  // once the persisted log has been replayed into the grain state.
  const runtime: Runtime<
    WorkflowGrainState<A, R, F>,
    WorkflowMsg<R, F>
  > = await run(machine, { ctx, store }).ready;

  // Track in-flight appends so `deliver` can persist-before-deliver. `observe`
  // is synchronous (it cannot await us), so we capture the append Promise per
  // applied Msg; the `deliver` turn awaits it before performing the next
  // activity.
  let pendingAppend: Promise<void> = Promise.resolve();
  runtime.observe((msg) => {
    pendingAppend = es.append(msg);
  });
  await runtime.ready;

  /**
   * The owed-but-unconfirmed activity dispatch to perform next, rebuilt by
   * folding the carried ledger tail. Empty on a fresh/fully-advanced workflow.
   * At most one is owed at a time (confirm-then-owe keeps the ledger holding one
   * in-flight activity), so the array is 0- or 1-length.
   */
  function owedActivities(): readonly WorkflowCmd<A>[] {
    return ref.current.survivingActivities(runtime.getState().ledgerEvents);
  }

  const grain: WorkflowGrain<A, R, F> = {
    async deliver(msg) {
      // Drive the result Msg through the runtime so its state + the durable log
      // advance identically to the pure fold. `dispatch` runs to quiescence and
      // the observer enqueues the append.
      await runtime.dispatch(msg);

      // PERSIST-BEFORE-DELIVER: block until the result event is durably written
      // before the next activity is performed over the transport.
      await pendingAppend;

      // Now it is safe to advance: perform the next owed activity (if any) and
      // fold its result in turn. A terminal transition owes nothing → stop.
      return grain.drive();
    },

    async drive() {
      // The owed-but-unconfirmed activity to perform — on a fresh boot the first
      // dispatch, on a re-woken grain the re-emitted survivor (same delivery id,
      // idempotent at the reducer). At most one is owed at a time.
      const owed = owedActivities();
      if (owed.length === 0) return runtime.getState().workflow;

      // Perform each owed activity and deliver its result. Driving sequentially
      // (await before the next) keeps the durable checkpoint ahead of the work:
      // each result is persisted before the next activity is performed.
      for (const cmd of owed) {
        const result = await ctx.performer.perform(cmd);
        await grain.deliver(result);
      }
      return runtime.getState().workflow;
    },

    state() {
      return runtime.getState().workflow;
    },

    async close() {
      await runtime.stop();
    },
  };

  return grain;
}

// ===========================================================================
// Boundary parses — the persisted snapshot + event cells (never throw)
// ===========================================================================

// The snapshot parse's status accept-set (`WORKFLOW_STATUSES`) and the replay
// parse's Msg-tag accept-set (`WORKFLOW_MSG_TYPES`) are derived from the union
// discriminants in `./index`, so they can never drift from the vocabulary (#312).

/**
 * Boundary parse for the persisted SNAPSHOT cell. Accepts a recovered
 * {@link WorkflowGrainState} (a non-null object carrying a `workflow` with a
 * known `status` and an array `ledgerEvents`); returns `null` on an
 * unrecognized shape so the grain seeds a fresh workflow (the
 * `doEventSourcedStore` parse contract — never throws).
 */
function parseWorkflowGrainState<A, R, F>(
  raw: unknown,
): WorkflowGrainState<A, R, F> | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return null;
  const s = raw as Record<string, unknown>;
  if (!Array.isArray(s.ledgerEvents)) return null;
  const workflow = s.workflow;
  if (workflow === null || typeof workflow !== "object") return null;
  const status = (workflow as { status?: unknown }).status;
  if (typeof status !== "string" || !WORKFLOW_STATUSES.has(status)) return null;
  return raw as WorkflowGrainState<A, R, F>;
}

/**
 * Boundary parse for a persisted EVENT (one logged activity-result `Msg`).
 * Accepts a non-null object whose `type` is a known {@link WorkflowMsg} tag and
 * whose `id` is a delivery id; returns `null` to DROP a retired/unknown variant
 * from replay (never throws).
 */
function parseWorkflowMsg<R, F>(raw: unknown): WorkflowMsg<R, F> | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.type !== "string" || !WORKFLOW_MSG_TYPES.has(m.type))
    return null;
  if (typeof m.id !== "number") return null;
  return raw as WorkflowMsg<R, F>;
}

// Re-export the workflow-facing types a consumer wiring the grain needs, so they
// need not also import from `./index`.
export type {
  ActivityErr,
  ActivityOk,
  Cmd,
  DeliveryId,
  WorkflowCmd,
  WorkflowMsg,
  WorkflowState,
  WorkflowStep,
};
