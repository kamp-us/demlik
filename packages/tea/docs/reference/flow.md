# @demlik/tea/flow

> the multi-step control-flow batteries: fan a batch out, run steps in order and compensate on failure, poll until a predicate holds, reconcile desired against actual.

Tier: `battery`

```ts
import { … } from "@demlik/tea/flow";
```

## Exports (103)

| Symbol | Kind | Tier | Summary |
| --- | --- | --- | --- |
| [`ActivityCmd`](#ActivityCmd) | Type | battery | The Cmd a workflow emits to run one forward activity. |
| [`ActivityErr`](#ActivityErr) | Interface | battery | An activity failed (retries already exhausted by the consumer's interpret cell — this module does not retry). |
| [`ActivityOk`](#ActivityOk) | Interface | battery | An activity succeeded: `id` echoes the ActivityCmd it answers; the reducer matches it against `current.id`, records the completed step, and advances. |
| [`addItem`](#addItem) | Function | battery | Buffer `item` and decide whether the size trigger fires. |
| [`awaitTerminal`](#awaitTerminal) | Function | battery | Attach to an ALREADY-RUNNING `Runtime<S, M, E>` and resolve with the terminal `S` on the first transition for which `isTerminal(state)` is true. |
| [`AwaitTerminalOptions`](#AwaitTerminalOptions) | Interface | battery | Options shared by `awaitTerminal` and `runToTerminal`. |
| [`BatchWindow`](#BatchWindow) | Interface | battery | The Model slice a batch window owns. |
| [`BatchWindowConfig`](#BatchWindowConfig) | Interface | battery | Configuration for a batch window — the knob. |
| [`batchWindowExpired`](#batchWindowExpired) | Function | battery | Construct the window-expired Msg for the window identified by `id`, flushing by `atMs`. |
| [`BatchWindowExpired`](#BatchWindowExpired) | Type | battery | The Msg a closed-by-time window dispatches. |
| [`BatchWindowKnob`](#BatchWindowKnob) | Interface | battery | The bound knob returned by `createBatchWindow`. |
| [`BatchWindowSub`](#BatchWindowSub) | Type | battery | The deadline a batch window's open timer lists: it IS `../deadline`'s `DeadlineSub`, not a re-tagged copy. |
| [`CompensatingWorkflow`](#CompensatingWorkflow) | Interface | battery | A workflow unwinding after a forward failure (#125): the compensations of the `completed` steps are being emitted in STRICT REVERSE order, one at a time, on the same #67 ledger. |
| [`CompensationCmd`](#CompensationCmd) | Type | battery | The Cmd a workflow emits to run one compensation, the inverse of an earlier activity. |
| [`CompensationErr`](#CompensationErr) | Interface | battery | A compensation itself failed (#125): the inverse activity bounced (a refund that won't go through). |
| [`CompensationFailedWorkflow`](#CompensationFailedWorkflow) | Interface | battery | A workflow whose ROLLBACK itself failed: a compensation activity reported a failure mid-unwind. |
| [`CompensationOk`](#CompensationOk) | Interface | battery | A compensation succeeded (#125): the inverse activity took. |
| [`CompletedStep`](#CompletedStep) | Interface | battery | A completed step: the step that ran plus the result its activity produced. |
| [`CompletedWorkflow`](#CompletedWorkflow) | Interface | battery | A workflow that ran every step to completion. |
| [`createBatchWindow`](#createBatchWindow) | Function | battery | Build a batch window knob from a config. |
| [`createFanOut`](#createFanOut) | Function | battery | Build the fan-out knob from `config`. |
| [`createMonitoredRun`](#createMonitoredRun) | Function | battery | Build a monitored-run knob from `config`. |
| [`createPoller`](#createPoller) | Function | battery | Build a poller knob from `config`. |
| [`createReconciler`](#createReconciler) | Function | battery | Build a reconciler knob from `config`. |
| [`createSaga`](#createSaga) | Function | battery | Build the saga knob from `config`. |
| [`createWorkflow`](#createWorkflow) | Function | battery | Build a workflow hook bag. |
| [`debounce`](#debounce) | Function | battery | Wrap `fn` so a BURST of calls collapses to a single invocation. |
| [`Debounced`](#Debounced) | Interface | battery | A debounced wrapper around `fn`. |
| [`DeliveryId`](#DeliveryId) | Type | battery | Monotonic, gap-free delivery id — the single correlation + dedup key. |
| [`EffectConfirmed`](#EffectConfirmed) | Interface | battery | An owed effect has been CONFIRMED delivered. |
| [`EffectLedgerEvent`](#EffectLedgerEvent) | Type | battery | The event union the ledger folds over. |
| [`EffectOwed`](#EffectOwed) | Interface | battery | An effect is now OWED: it has been decided but its delivery is not yet confirmed. |
| [`emptyLedger`](#emptyLedger) | Function | battery | The empty ledger — the fold's starting value (a fresh actor owes nothing). |
| [`EndedRun`](#EndedRun) | Type | battery | The ENDED phases — a run that finished (`done`) or was stopped from outside (`cancelled`). |
| [`EnqueueInput`](#EnqueueInput) | Type | battery | Caller-facing enqueue payload. |
| [`FailedCompensatedWorkflow`](#FailedCompensatedWorkflow) | Interface | battery | A workflow that failed forward and then fully unwound: every completed step's compensation confirmed, in reverse order. |
| [`FailedWorkflow`](#FailedWorkflow) | Interface | battery | A workflow that failed on an activity with NOTHING to compensate — the forward failure happened with zero completed steps (the first activity failed). |
| [`FanOutConfig`](#FanOutConfig) | Interface | battery | The knob. |
| [`FanOutDone`](#FanOutDone) | Interface | battery | One settled-OK item: the original `input` and the `result` its effect produced. |
| [`FanOutFailed`](#FanOutFailed) | Interface | battery | One settled-error item: the original `input` and the `error` its effect surfaced. |
| [`FanOutPorts`](#FanOutPorts) | Interface | battery | Optional Port for observing batch completion out-of-band. |
| [`FanOutState`](#FanOutState) | Interface | battery | The slice this knob owns — four partitions over the work-queue item lifecycle, plus the work-queue records the verbs thread the lifecycle through. |
| [`foldWorkflow`](#foldWorkflow) | Function | battery | Replay a workflow from its event log: seed over `steps`, then fold each activity-result `Msg` in order. |
| [`InFlightActivity`](#InFlightActivity) | Interface | battery | The activity currently in flight on a `running` workflow. |
| [`InFlightCompensation`](#InFlightCompensation) | Interface | battery | The compensation currently in flight on a `compensating` workflow (#125). |
| [`initBatchWindow`](#initBatchWindow) | Function | battery | The starting slice: closed window, empty buffer. |
| [`initFanOut`](#initFanOut) | Function | battery | The starting slice: nothing scattered yet. |
| [`initSaga`](#initSaga) | Function | battery | The starting slice: idle, nothing run, winding-forward direction. |
| [`isAborted`](#isAborted) | Function | battery | Whether the saga has terminated in failure, fully unwound (every completed step undone). |
| [`isCommitted`](#isCommitted) | Function | battery | Whether the saga has terminated successfully (every step committed). |
| [`isCompensationFailed`](#isCompensationFailed) | Function | battery | Whether the saga has terminated in failure with an UNFINISHED rollback: an `undo` itself failed, so some completed steps were never compensated and need hand reconciliation. |
| [`isComplete`](#isComplete) | Function | battery | Whether every scattered item has settled (no `pending`, no `running`). |
| [`isSettled`](#isSettled) | Function | battery | Whether the saga has reached a terminal phase (success, fully-unwound failure, or compensation-failed). |
| [`liftReconciler`](#liftReconciler) | Function | battery | Lift a knob result `[slice, cmds]` into a host `[State, cmds]` where the slice lives at `state.rec`. |
| [`liftRun`](#liftRun) | Function | battery | Lift a knob result `[slice, cmds]` into a host `[State, cmds]` where the slice lives at `state.run`. |
| [`MonitoredRunCmd`](#MonitoredRunCmd) | Type | battery | The checkpoint-write Cmd, generic over the consumer's checkpoint value `V`. |
| [`MonitoredRunConfig`](#MonitoredRunConfig) | Interface | battery | The monitored-run knob. |
| [`MonitoredRunState`](#MonitoredRunState) | Type | battery | The slice — a discriminated union on `phase` so each phase carries ONLY its own data and impossible combinations are unrepresentable (pattern 11), the same idiom the sibling `CircuitState` / `PaginatorState` / `RunFailure` follow: - `idle` — created but never started. |
| [`MonitoredRunTimerMsg`](#MonitoredRunTimerMsg) | Type | battery | The deadline Msg the safety alarm dispatches when the watchdog fires. |
| [`onWindow`](#onWindow) | Function | battery | Flush the open window because its time bound was reached. |
| [`Poller`](#Poller) | Interface | battery | The knob handle returned by `createPoller`. |
| [`PollerConfig`](#PollerConfig) | Interface | battery | The poller knob's config — the single object you hand `createPoller`. |
| [`PollerDone`](#PollerDone) | Type | battery | The poller state once a poll has returned its final result. |
| [`PollerGaveUp`](#PollerGaveUp) | Type | battery | The poller state once it has stopped without a result. |
| [`PollerPolling`](#PollerPolling) | Type | battery | The three arms, named — so a verb can DECLARE the phases it can actually reach instead of the whole union. |
| [`PollerState`](#PollerState) | Type | battery | The Model field the poller knob owns — its visible slice (the knob principle: managed state lives in the Model, never a closure, so it is durable and replayable). |
| [`PollerSub`](#PollerSub) | Type | battery | The deadline the poller lists — a `../deadline` entry under the `poller:tick:` id family (see `pollerSubId`). |
| [`ReconcilePhase`](#ReconcilePhase) | Type | battery | Reconcile lifecycle phase. |
| [`ReconcilerConfig`](#ReconcilerConfig) | Interface | battery | The reconciler knob. |
| [`ReconcilerState`](#ReconcilerState) | Interface | battery | The slice. |
| [`ReconcilerTimerMsg`](#ReconcilerTimerMsg) | Type | battery | The scan retry / deadline timer Msg — inherited from paginated-walk. |
| [`routeWorkflowMsg`](#routeWorkflowMsg) | Function | battery | Route a `WorkflowMsg` to the matching verb of a workflow and return its step. |
| [`RunFailure`](#RunFailure) | Type | battery | Why a run terminated as `failed`. |
| [`RunningWorkflow`](#RunningWorkflow) | Interface | battery | A workflow in progress. |
| [`runToTerminal`](#runToTerminal) | Function | battery | Fire-and-await convenience: `run()` the machine, dispatch the seed `msgs`, and resolve with the terminal state — then tear the runtime down (`runtime.stop()`) on BOTH the resolve and reject paths. |
| [`SagaConfig`](#SagaConfig) | Interface | battery | The knob. |
| [`SagaPhase`](#SagaPhase) | Type | battery | The lifecycle phase of a saga, narrowed at the type level so a consumer can branch on `state.phase` (and a Transitions-table reducer can key on it). |
| [`SagaState`](#SagaState) | Interface | battery | The slice this knob owns. |
| [`SagaStep`](#SagaStep) | Interface | battery | One step of the saga: the forward effect and its compensating inverse, both as data (plain Cmds). |
| [`ScanPageCmd`](#ScanPageCmd) | Type | battery | The actual-list page-fetch effect: the inherited `resilient_run` Cmd from paginated-walk, whose `input` is the `Cursor` to fetch and whose `key` is the fixed `PAGE_KEY`. |
| [`ScanPageErrMsg`](#ScanPageErrMsg) | Type | battery | The Msg the engine mints when the scan's page-fetch handler fails. |
| [`ScanPageOkMsg`](#ScanPageOkMsg) | Type | battery | The page-settled Msgs the engine mints from that handler's outcome. |
| [`SnapshotSavedMsg`](#SnapshotSavedMsg) | Type | battery | The Msg the engine mints when a write lands. |
| [`SnapshotWriteCmd`](#SnapshotWriteCmd) | Type | battery | The Cmd a snapshot decision emits to write a checkpoint: `payload` under `key`, at sequence `seq`. |
| [`StageResult`](#StageResult) | Type | battery | The outcome a consumer reports to `advance`: the current stage either succeeded (retire it, claim the next) or failed (terminate the run). |
| [`StepId`](#StepId) | Type | battery | A step's stable identity. |
| [`subscribeBatchWindow`](#subscribeBatchWindow) | Variable | battery | The `deadline` runner for a batch window's absolute timer — the exact `../deadline` runner. |
| [`subsFor`](#subsFor) | Function | battery | The window timer deadline, derived from the slice. |
| [`TerminalTimeoutError`](#TerminalTimeoutError) | Class | battery | Raised when `awaitTerminal` / `runToTerminal` is wired with a `timeoutMs` and the deadline elapses before any terminal state is reached. |
| [`timerFor`](#timerFor) | Function | battery | The built-in `timer` Sub's deps for a batch window. |
| [`Workflow`](#Workflow) | Interface | battery | The hook bag returned by createWorkflow. |
| [`WORKFLOW_MSG_TYPES`](#WORKFLOW_MSG_TYPES) | Variable | battery | The runtime accept-set of every WorkflowMsgType — the single source of truth the boundary replay parse keys off (see `do.ts`). |
| [`WORKFLOW_STATUSES`](#WORKFLOW_STATUSES) | Variable | battery | The runtime accept-set of every WorkflowStatus — the single source of truth the boundary snapshot parse keys off (see `do.ts`). |
| [`workflowActivityDef`](#workflowActivityDef) | Function | battery | Dispatch the in-flight activity. |
| [`WorkflowCmd`](#WorkflowCmd) | Type | battery | The Cmd union this module emits: forward activity dispatches AND (#125) reverse compensation dispatches. |
| [`workflowCompensationDef`](#workflowCompensationDef) | Function | battery | Dispatch a compensation (#125). |
| [`WorkflowMsg`](#WorkflowMsg) | Type | battery | The Msg union the reducer folds: forward activity results AND (#125) reverse compensation results. |
| [`WorkflowMsgType`](#WorkflowMsgType) | Type | battery | Every `type` discriminant tag of the WorkflowMsg union. |
| [`WorkflowReducerStep`](#WorkflowReducerStep) | Interface | battery | A workflow reducer step: the next state, the ledger events to persist (owed-before-dispatch), and the activity Cmds to dispatch. |
| [`WorkflowState`](#WorkflowState) | Type | battery | The workflow's state — a discriminated union on `status`. |
| [`WorkflowStatus`](#WorkflowStatus) | Type | battery | Every `status` discriminant of the WorkflowState union. |
| [`WorkflowStep`](#WorkflowStep) | Interface | battery | One step of a workflow: a named activity descriptor. |
| [`WorkflowSteps`](#WorkflowSteps) | Type | battery | A workflow's step sequence at construction — a NON-EMPTY tuple. |

## Declarations

<a id="ActivityCmd"></a>

### `ActivityCmd`

```ts
type ActivityCmd<A> = CmdOf<ReturnType<typeof workflowActivityDef>>
```

<a id="ActivityErr"></a>

### `ActivityErr`

```ts
interface ActivityErr<F> {
  readonly failure: F;
  readonly id: number;
  readonly type: "activity_err";
}
```

<a id="ActivityOk"></a>

### `ActivityOk`

```ts
interface ActivityOk<R> {
  readonly id: number;
  readonly result: R;
  readonly type: "activity_ok";
}
```

<a id="addItem"></a>

### `addItem`

```ts
function addItem<I, C extends Cmd>(
  config: BatchWindowConfig<I, C>,
  state: BatchWindow<I>,
  item: I,
  at: number,
): readonly [BatchWindow<I>, readonly C[]]
```

<a id="awaitTerminal"></a>

### `awaitTerminal`

```ts
function awaitTerminal<
  S,
  M extends { type: string },
  E extends { type: string } = never,
>(
  runtime: Runtime<S, M, E>,
  isTerminal: (state: S) => boolean,
  opts?: AwaitTerminalOptions,
): Promise<S>
```

<a id="AwaitTerminalOptions"></a>

### `AwaitTerminalOptions`

```ts
interface AwaitTerminalOptions {
  /**
   * Optional bounded deadline in milliseconds. When set, the returned promise
   * REJECTS with TerminalTimeoutError if no terminal state is reached
   * within the window; the timer is cleared on the resolve path so a resolved
   * await never later rejects or leaves a dangling timer. Omit for an unbounded
   * await (never rejects for time).
   */
  readonly timeoutMs?: number;
}
```

<a id="BatchWindow"></a>

### `BatchWindow`

```ts
interface BatchWindow<I> {
  readonly buffer: readonly I[];
  readonly openedAt: number | null;
}
```

<a id="BatchWindowConfig"></a>

### `BatchWindowConfig`

```ts
interface BatchWindowConfig<I, C extends Cmd> {
  /**
   * Map a flushed batch to the single Cmd the runtime performs. Called with the
   * buffered items in arrival order; the returned Cmd is what `add` / `onWindow`
   * emit when a window closes. PURE constructor — no I/O, no clock; the I/O
   * happens later in the consumer's interpret handler for the returned Cmd.
   */
  readonly flush: (items: readonly I[]) => C;
  /**
   * Size trigger. A batch flushes the instant its buffer reaches `maxItems`,
   * WITHOUT waiting for the time window — the classic "send as soon as the
   * page is full" cutoff. Must be `>= 1`; a config of `maxItems: 0` would flush
   * an empty batch on every `add`, which is never useful, so callers treat `1`
   * as the floor (the verb still behaves: with `maxItems <= 1` every item
   * flushes on arrival, a degenerate but legal "no batching" window).
   */
  readonly maxItems: number;
  /**
   * Time trigger, in milliseconds. A batch flushes no later than `openedAt +
   * maxMs` — `openedAt` being the `at` of the item that opened the window. This
   * is the latency ceiling: an item never waits longer than `maxMs` to ship,
   * even if the buffer never reaches `maxItems`.
   */
  readonly maxMs: number;
}
```

<a id="batchWindowExpired"></a>

### `batchWindowExpired`

```ts
function batchWindowExpired(id: string, atMs: number): BatchWindowExpired
```

<a id="BatchWindowExpired"></a>

### `BatchWindowExpired`

```ts
type BatchWindowExpired = DeadlineExceeded
```

<a id="BatchWindowKnob"></a>

### `BatchWindowKnob`

```ts
interface BatchWindowKnob<I, C extends Cmd> {
  /**
   * Buffer `item` (arrival-stamped `at`), flushing immediately if that brings
   * the buffer to `maxItems`. See `addItem`.
   */
  add(
    state: BatchWindow<I>,
    item: I,
    at: number,
  ): readonly [BatchWindow<I>, readonly C[]];
  /** The starting slice — `initBatchWindow()`. */
  init(): BatchWindow<I>;
  /** Flush whatever is buffered because the time window closed. See `onWindow`. */
  onWindow(state: BatchWindow<I>, at: number): readonly [BatchWindow<I>, readonly C[]];
  /**
   * The window timer as an absolute deadline, listed only while a window is
   * open — for `deadlinesSub` + `subscribeBatchWindow`. See `subsFor`.
   */
  subs(state: BatchWindow<I>, id?: string): readonly BatchWindowSub[];
  /**
   * The built-in `timer` Sub's deps while a window is open, `null` while it is
   * closed. See `timerFor`. `id` keys the Msg so several windows on one
   * machine route distinctly.
   */
  timer(state: BatchWindow<I>, id?: string): TimerDeps<BatchWindowExpired> | null;
}
```

<a id="BatchWindowSub"></a>

### `BatchWindowSub`

```ts
type BatchWindowSub = DeadlineSub
```

<a id="CompensatingWorkflow"></a>

### `CompensatingWorkflow`

```ts
interface CompensatingWorkflow<A, R, F> {
  /** Completed steps whose compensation has confirmed, in unwind (reverse) order. */
  readonly compensated: readonly CompletedStep<A, R>[];
  /** The completed forward steps, in execution order — the history being unwound. */
  readonly completed: readonly CompletedStep<A, R>[];
  /** The single compensation in flight right now. */
  readonly current: InFlightCompensation<A>;
  /** The step whose forward activity failed, triggering the unwind. */
  readonly failedStep: WorkflowStep<A>;
  /** The opaque forward failure that triggered the unwind. Carried, never interpreted. */
  readonly failure: F;
  readonly status: "compensating";
  readonly steps: readonly WorkflowStep<A>[];
}
```

<a id="CompensationCmd"></a>

### `CompensationCmd`

```ts
type CompensationCmd<A> = CmdOf<ReturnType<typeof workflowCompensationDef>>
```

<a id="CompensationErr"></a>

### `CompensationErr`

```ts
interface CompensationErr<F> {
  readonly failure: F;
  readonly id: number;
  readonly type: "compensation_err";
}
```

<a id="CompensationFailedWorkflow"></a>

### `CompensationFailedWorkflow`

```ts
interface CompensationFailedWorkflow<A, R, F> {
  /** Completed steps successfully compensated before the rollback broke, in unwind order. */
  readonly compensated: readonly CompletedStep<A, R>[];
  /** The opaque rollback failure (distinct from failure). Carried, never interpreted. */
  readonly compensationFailure: F;
  /** The full completed-forward history, in execution order. */
  readonly completed: readonly CompletedStep<A, R>[];
  /** The step whose compensation bounced. Its forward effect stands un-reversed. */
  readonly failedCompensationStep: WorkflowStep<A>;
  /** The step whose forward activity failed, triggering the unwind. */
  readonly failedStep: WorkflowStep<A>;
  /** The opaque forward failure that triggered compensation. Carried, never interpreted. */
  readonly failure: F;
  readonly status: "compensation_failed";
  readonly steps: readonly WorkflowStep<A>[];
}
```

<a id="CompensationOk"></a>

### `CompensationOk`

```ts
interface CompensationOk {
  readonly id: number;
  readonly type: "compensation_ok";
}
```

<a id="CompletedStep"></a>

### `CompletedStep`

```ts
interface CompletedStep<A, R> {
  readonly result: R;
  readonly step: WorkflowStep<A>;
}
```

<a id="CompletedWorkflow"></a>

### `CompletedWorkflow`

```ts
interface CompletedWorkflow<A, R> {
  /** Every step, in execution order, with its result. */
  readonly completed: readonly CompletedStep<A, R>[];
  /** The final step's result — the workflow's output. */
  readonly output: R;
  readonly status: "completed";
  readonly steps: readonly WorkflowStep<A>[];
}
```

<a id="createBatchWindow"></a>

### `createBatchWindow`

```ts
function createBatchWindow<I, C extends Cmd>(
  config: BatchWindowConfig<I, C>,
): BatchWindowKnob<I, C>
```

<a id="createFanOut"></a>

### `createFanOut`

```ts
function createFanOut<I, R, C extends Cmd = Cmd, J extends Cmd = Cmd>(
  config: FanOutConfig<I, R, C, J>,
): {
  /**
   * The out-of-band completion splice. Returns an observer-shaped function the
   * consumer calls after every settle: when the batch has just completed it
   * emits the gathered results onto `ports.complete`. This is the Port-side
   * analogue of the `join` Cmd — use it when completion should leave the
   * runtime as a typed signal rather than re-enter `update`.
   *
   * Returns the emit-on-complete callback so the consumer wires it into its own
   * runtime `observe` (e.g. `runtime.observe((_, s) => emit(s.fanOut))`); fan-out
   * stays out of the dispatch loop, matching `historyTracker`'s discipline.
   */
  completion: (
    ports: FanOutPorts<R>,
  ) => {
    /**
     * Emit the gathered done-results onto `ports.complete` iff `state` is a
     * just-completed batch. Idempotency is the caller's concern (call it once
     * per transition via `observe`); emitting to a Port with no subscribers
     * is a no-op at the runtime, so an extra call is harmless.
     */
    emitOnComplete(emit: <T>(port: Port<T>, value: T) => void, state: FanOutState<I, R>): void;
  };
  /** The starting slice: nothing scattered yet. */
  init: () => FanOutState<I, R>;
  /**
   * Whether every scattered item has settled (no `pending`, no `running`).
   * Derived — reads the slice, never mutates. The verbs use it to decide when to
   * fire `join`; consumers can read it directly to branch their own phase.
   *
   * An empty fan-out (nothing ever scattered) is NOT complete: completion is "a
   * non-empty batch fully drained," so `isComplete(initFanOut())` is `false` and
   * a `scatter([])` of zero items also reads `false` (there was no batch to
   * complete). This keeps `join` from firing on a degenerate empty scatter.
   */
  isComplete: <I, R>(state: FanOutState<I, R>) => boolean;
  /**
   * Record `id`'s effect as failed with `error`, then launch the next pending
   * item to backfill the freed slot. PURE.
   *
   * Symmetric to `itemOk`: moves the item out of `running` into `failed`
   * (carrying the original input + the error), flips its ledger record
   * `running → failed`, backfills via `launchUpTo`, and fires `join` at the
   * completion edge if configured. A failed item still counts toward completion
   * — the batch is "done" when every item has settled, success or failure;
   * `join` receives only the OK results (failures are read off `failed`).
   *
   * Same unknown-`id` no-op contract as `itemOk`.
   */
  itemErr: (
    state: FanOutState<I, R>,
    id: string,
    error: unknown,
  ) => readonly [FanOutState<I, R>, readonly (C | J)[]];
  /**
   * Record `id`'s effect as succeeded with `result`, then launch the next
   * pending item to backfill the freed slot. PURE.
   *
   * Moves the item out of `running` into `done` (carrying the original input +
   * its result), flips its ledger record `running → done`, and runs
   * `launchUpTo` to keep the pipeline full. If this transition empties both
   * `pending` and `running` AND a `join` is configured, the returned Cmds also
   * include the single `join(results)` Cmd — fired exactly once at the
   * completion edge.
   *
   * A settle for an unknown / already-settled `id` is a no-op (returns the
   * slice unchanged, no Cmds): the runtime's serial dispatch makes a true
   * double-settle impossible, but a stale Msg after a boot/replay is real, and
   * swallowing it is the safe direction (the result is already recorded).
   */
  itemOk: (
    state: FanOutState<I, R>,
    id: string,
    result: R,
  ) => readonly [FanOutState<I, R>, readonly (C | J)[]];
  /**
   * Enqueue `items` and launch up to `concurrency` of them. PURE.
   *
   * Each item gets a ledger record (`status: "pending"`, its `idOf` id) and is
   * appended to `pending`; `launchUpTo` then promotes as many as the free
   * concurrency budget allows, emitting `of(item)` per launch. The returned
   * Cmds are exactly the launch effects — `scatter` never fires `join` (a batch
   * can't complete on the same transition it starts unless it launches zero
   * effects, which `isComplete`'s empty-batch rule already declines to treat as
   * completion).
   *
   * Each pending ledger record is minted by the `QueueAdapter`'s `enqueue` — the
   * same `pending` append `src/internal/work-queue/` owns — rather than re-rolled
   * inline, so the `status: "pending"` literal lives in exactly one place (no
   * `as QueueItemStatus` cast here).
   *
   * `enqueuedAt` is stamped `0` rather than read from a clock: fan-out's verbs
   * are pure, and fan-out does not use the timestamp for any decision (ordering
   * is positional via the arrays). A consumer that needs real enqueue times
   * threads them through its own Msg `at` and stores them alongside.
   */
  scatter: (
    state: FanOutState<I, R>,
    items: readonly I[],
  ) => readonly [FanOutState<I, R>, readonly C[]];
}
```

<a id="createMonitoredRun"></a>

### `createMonitoredRun`

```ts
function createMonitoredRun<Stage, V = unknown>(
  config?: MonitoredRunConfig<Stage>,
): {
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
   * settled (`done` / `failed` / `cancelled`) or never-started (`idle`) run. PURE — `at` is the
   * only clock, ids are positional.
   */
  advance: (
    s: MonitoredRunState<Stage>,
    payload: V,
    result: StageResult,
    at: number,
  ) => readonly [MonitoredRunState<Stage>, readonly MonitoredRunCmd<V>[]];
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
   * A no-op on a settled (`done` / `failed` / `cancelled`) or never-started (`idle`) run. Emits
   * NO Cmd — re-emitting the current stage's outstanding effect is the CONSUMER's
   * job (it knows the per-stage Cmd), the audit machine's `outstandingEffect(stage)`
   * pattern. PURE.
   */
  boot: (
    s: MonitoredRunState<Stage>,
    at: number,
  ) => readonly [MonitoredRunState<Stage>, readonly MonitoredRunCmd<V>[]];
  /**
   * Stop the run from outside and settle it `cancelled` at `at`. The durable half
   * of an `AbortSignal`: the outcome is a phase in the slice, so a reload reads a
   * run that ended rather than one to resume.
   *
   * Legal from `idle` too, not just the live phases — a signal already aborted
   * when the run is asked for has to end it BEFORE `start`, and leaving it `idle`
   * would let the next boot start the very run the caller stopped. That is the
   * one arm where `runId` is `null`, built explicitly rather than spread so no
   * stale `failure` or absent `runId` rides along.
   *
   * A no-op on a settled run (`done` / `failed` / `cancelled`): a terminal outcome
   * is already the answer, and an abort landing after it must not overwrite it.
   * That also makes a second abort idempotent. Emits no Cmd — cancelling issues no
   * effect, and the in-flight ones it cannot recall are the consumer's to drain.
   * PURE.
   */
  cancel: (
    s: MonitoredRunState<Stage>,
    at: number,
  ) => readonly [MonitoredRunState<Stage>, readonly MonitoredRunCmd<V>[]];
  /** The `snapshot_write` Cmd def — list it in `cmds` when checkpointing. */
  checkpoint: CmdDef<"snapshot_write", {
    readonly at: number;
    readonly key: string;
    readonly payload: V;
    readonly seq: number;
  }, undefined, {
    readonly [detail: string]: unknown;
    readonly _tag: "snapshot_write_failed";
  }>;
  /**
   * Fold a confirmed checkpoint write into the slice — advances the snapshot
   * watermark (forward-only). A no-op pass-through when checkpointing is
   * disabled. PURE. Fold the `snapshot_write_ok` Msg here.
   */
  confirmSnapshot: (
    s: MonitoredRunState<Stage>,
    msg: SnapshotSavedMsg<V>,
  ) => MonitoredRunState<Stage>;
  /**
   * The no-progress safety deadline, listed only while the run is live
   * (`running` / `stale`) AND a `deadlineMs` is configured. Its id is keyed on
   * `progressSeq`, so every progress event retires the old alarm and arms a
   * fresh one at the new `lastProgressAt + deadlineMs` — a self-rearming
   * watchdog with no manual `clearTimeout`. A settled run lists none.
   *
   * A NEVER-STARTED slice (`init()`) is its OWN `idle` phase, not a `running` run
   * with an empty `runId`. The `phase !== "running" && phase !== "stale"` narrow
   * therefore excludes it structurally — no separate `runId === ""` sentinel gate
   * is needed. Were `idle` armed, it would fire a deadline at `0 + deadlineMs`
   * (already in the past) and auto-fail a run that never began — the "born live"
   * defect. `start` is the only transition out of `idle`, so the watchdog exists
   * exactly once a real run is in flight.
   */
  deadlines: (s: MonitoredRunState<Stage>) => readonly DeadlineSub[];
  /** The starting slice for a never-started run: the `idle` phase, no `runId`. */
  init: () => MonitoredRunState<Stage>;
  /**
   * Mark the run `stale` — a soft "no progress observed" signal the consumer
   * raises WITHOUT the deadline having fired (e.g. an upstream heartbeat gap).
   * Recoverable: the next `progress` flips it back to `running`. A no-op unless
   * the run is currently `running` (a settled run cannot go stale). Does NOT
   * touch `progressSeq` — going stale is not progress, so the armed deadline
   * keeps counting toward the hard terminal. PURE.
   */
  markStale: (
    s: MonitoredRunState<Stage>,
  ) => readonly [MonitoredRunState<Stage>, readonly MonitoredRunCmd<V>[]];
  /**
   * The safety alarm fired. Two outcomes by deadline-id match:
   *
   *   - the alarm matches the CURRENT `progressSeq` (no progress since it was
   *     armed) → the run is wedged → terminate `failed { reason: "deadline" }`.
   *   - the alarm matches an OLDER seq → a stale fire racing a progress event
   *     that already re-armed the alarm → no-op (the engine retired this id;
   *     tolerate a fire still in flight defensively).
   *
   * A no-op on a settled run (its alarm was reconciled away; tolerate a stale
   * fire) and on a NEVER-STARTED (`idle`) run (`subs` armed nothing for it, so
   * any alarm reaching it is a rogue fire that must not un-start it). PURE —
   * `msg.atMs` stamps the failure.
   */
  onDeadline: (
    s: MonitoredRunState<Stage>,
    msg: MonitoredRunTimerMsg,
  ) => readonly [MonitoredRunState<Stage>, readonly MonitoredRunCmd<V>[]];
  /**
   * Record forward progress: bump the watchdog (re-arming the safety alarm),
   * clear any `stale` mark back to `running`, and account a snapshot unit
   * (emitting a checkpoint Cmd on a cadence hit). A no-op unless the run is live
   * (`running` / `stale`) — a late progress event on a settled (`done` /
   * `failed`) or never-started (`idle`) run is ignored. PURE.
   */
  progress: (
    s: MonitoredRunState<Stage>,
    payload: V,
    at: number,
  ) => readonly [MonitoredRunState<Stage>, readonly MonitoredRunCmd<V>[]];
  /**
   * Start (or restart) the run for `runId` at time `at`. Seeds the stage queue
   * (if a pipeline) and enters `running` with the watchdog clock primed. Stamps
   * `runId` from the host — the machine never mints (invariant: identity is
   * host-minted, parsed at the boundary). PURE.
   */
  start: (
    s: MonitoredRunState<Stage>,
    runId: string,
    at: number,
  ) => readonly [MonitoredRunState<Stage>, readonly MonitoredRunCmd<V>[]];
  /**
   * The built-in `timer` Sub's deps for the watchdog: `deadlineMs` counted from
   * `lastProgressAt`, the instant the current alarm was armed. Its fire is a
   * `deadline_exceeded` Msg; route it to `onDeadline`. Declare
   * `{ type: "timer", deps: (s) => run.timer(s.run) }`. PURE.
   */
  timer: (s: MonitoredRunState<Stage>) => TimerDeps<MonitoredRunTimerMsg> | null;
}
```

<a id="createPoller"></a>

### `createPoller`

```ts
function createPoller<State, R>(
  config: PollerConfig<State, R>,
  rng?: () => number,
): Poller<State, R>
```

<a id="createReconciler"></a>

### `createReconciler`

```ts
function createReconciler<
  Actual,
  Desired,
  Page,
  Change,
  ApplyCmd extends Cmd = Cmd,
  Cursor = number,
>(
  config: ReconcilerConfig<Actual, Desired, Page, Change, ApplyCmd, Cursor>,
  rng?: () => number,
): {
  /**
   * Record that `change` finished applying: write it into the applied ledger,
   * advance the cursor past it, and drive the next `applyNext`. PURE — `at` is
   * the ledger-write clock (the entry never expires in practice; a large TTL
   * keeps the idempotency window open for the reconcile's lifetime).
   *
   * `change` is the SAME change the consumer's apply handler settled (echoed back
   * on the settle Msg) — its id is computed from the change's own identity (NOT a
   * cursor position), so the ledger key matches the skip check in `applyNext`
   * regardless of where the change sits in the plan. A no-op unless `applying` (a
   * late settle after `done` is ignored). PURE.
   */
  applied: (s: State, change: Change, at: number) => readonly [State, readonly OutCmd[]];
  /**
   * Emit the apply Cmd for the next not-yet-applied change in the plan, skipping
   * any whose id is already in the applied ledger (idempotent re-apply after
   * eviction). Advances `appliedCursor` past skipped + the emitted change. When
   * the cursor reaches the end of the plan, settles `done`. A no-op unless
   * `applying`. PURE — `at` is read only for the ledger lookup clock; `idOf`
   * keys the skip check.
   *
   * Emits at most ONE apply Cmd per call (the loop is sequential: each `applied`
   * drives the next `applyNext`). This keeps the actual-world mutation
   * one-at-a-time, matching a controller's serial reconcile.
   */
  applyNext: (s: State, at: number) => readonly [State, readonly OutCmd[]];
  /**
   * The scan's deadlines — exactly paginated-walk's: a retry timer while a scan
   * page is `waiting_retry`, and (with the `deadline` brick) a per-page deadline
   * timer while a scan fetch is active. The apply loop emits no timers (each
   * apply settles via the consumer's own Msg), so once the scan finishes the
   * list empties.
   */
  deadlines: (s: State) => readonly DeadlineSub[];
  /** The starting slice: idle, fresh walk + empty accumulator / plan / ledger. */
  init: () => State;
  /**
   * Whether the reconcile has fully settled — every planned change applied (or an
   * empty plan: already in sync). PURE, read-only. Lets a consumer's reducer fire
   * a "reconcile complete" Cmd without re-checking the phase by hand.
   */
  isComplete: (s: State) => boolean;
  /**
   * A scan retry / deadline timer fired. Defers to paginated-walk's `onTimer`: a
   * retry timer re-issues the SAME scan-page fetch (re-fetching the parked
   * cursor); a deadline timer settles the scan call failed. A deadline-driven
   * terminal scan failure escalates the whole reconcile to `failed`. A stale fire
   * is a pure no-op (inherited identity). PURE.
   */
  onTimer: (s: State, msg: PaginatedWalkTimerMsg) => readonly [State, readonly OutCmd[]];
  /**
   * Record a failed scan-page fetch and back off via the inherited resilience:
   * schedule a retry (the scan cursor stays parked — no advance) or, once the
   * page-fetch retries are exhausted, the underlying call settles `failed`. When
   * the scan call is terminally failed, the whole reconcile enters `failed`.
   * PURE — `msg.at` stamps the breaker trip + the retry-delay base.
   */
  pageErr: (s: State, msg: PageErrMsg) => readonly [State, readonly OutCmd[]];
  /**
   * Record a successfully fetched actual-list `page`: append its items to the
   * `actual` accumulator and advance the walk. When the walk finishes (the
   * listing is exhausted), the full actual snapshot is in hand → compute the
   * plan (`planned`) and start applying. PURE — `msg.at` is the scan clock.
   *
   * A stray `pageOk` while not `scanning` (a late duplicate after the scan
   * completed) is absorbed by the walk (no cursor advance) and contributes no
   * items — the reconcile never re-accumulates after the plan is computed.
   */
  pageOk: (s: State, msg: ScanPageOkMsg<Page>) => readonly [State, readonly OutCmd[]];
  /**
   * Compute the remediation plan from the accumulated `actual` snapshot and the
   * configured `desired`, store it, and enter `applying`. Normally driven
   * internally by `pageOk` when the scan finishes, but exposed as a
   * verb so a consumer can force planning from an externally-supplied actual
   * snapshot (e.g. a single-shot actual fetch outside the paginated scan), or
   * re-plan after a desired change. An empty plan settles straight to `done`
   * (already in sync). PURE — `at` only stamps the (empty) apply-loop clock.
   *
   * `changes` is optional: omit it to diff the slice's own accumulated `actual`
   * against `config.desired`; pass an explicit plan to install it directly
   * (skipping the diff — the consumer computed it elsewhere).
   */
  planned: (
    s: State,
    at: number,
    changes?: readonly Change[],
  ) => readonly [State, readonly OutCmd[]];
  /**
   * Begin the reconcile: start the paginated walk over the ACTUAL world and
   * enter `scanning`. Issues the first scan-page fetch (gated through the
   * inherited resilience). A no-op on any non-`idle` phase — re-scanning a
   * reconcile already in flight would restart the actual walk and double-count,
   * so a stray `scan` is absorbed. PURE — `at` threads into the fetch gate.
   */
  scan: (s: State, at: number) => readonly [State, readonly OutCmd[]];
  /** The scan's page-fetch Cmd def — list it in the machine's `cmds`. */
  scanPage: CmdDef<"resilient_run", { readonly input: Cursor; readonly key: string }, Page, {
    readonly [detail: string]: unknown;
    readonly _tag: "deadline_exceeded";
  } | {
    readonly [detail: string]: unknown;
    readonly _tag: "port_rejected";
  }>;
  /**
   * The built-in `timer` Sub's deps for the scan. Declare
   * `{ type: "timer", deps: (s) => rec.timer(s.rec) }`.
   */
  timer: (s: State) => TimerDeps<ResilientTimerMsg<"resilient">> | null;
}
```

<a id="createSaga"></a>

### `createSaga`

```ts
function createSaga<D extends Cmd, U extends Cmd>(
  config: SagaConfig<D, U>,
): {
  /**
   * The starting slice: idle, nothing run, winding-forward direction. `items` is
   * empty until `start` stamps one ledger record per configured step — the slice
   * is generic in the ledger payload `I`, defaulting to the positional `StepId`
   * since a saga's "input" per step is just its index (the consumer's real inputs
   * ride on its own Msgs).
   */
  init: () => SagaState<number>;
  /** Whether the saga has terminated in failure, fully unwound (every completed step undone). */
  isAborted: <I>(state: SagaState<I>) => boolean;
  /** Whether the saga has terminated successfully (every step committed). */
  isCommitted: <I>(state: SagaState<I>) => boolean;
  /**
   * Whether the saga has terminated in failure with an UNFINISHED rollback: an
   * `undo` itself failed, so some completed steps were never compensated and need
   * hand reconciliation. Terminal, but distinct from `aborted` (fully unwound).
   */
  isCompensationFailed: <I>(state: SagaState<I>) => boolean;
  /**
   * Whether the saga has reached a terminal phase (success, fully-unwound
   * failure, or compensation-failed). Derived — reads the slice, never mutates.
   * Consumers branch their own phase off this; no further verb has any effect
   * once it holds (the verbs guard on phase and no-op).
   */
  isSettled: <I>(state: SagaState<I>) => boolean;
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
  start: (state: SagaState<number>) => readonly [SagaState<number>, readonly D[]];
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
  stepErr: (
    state: SagaState<number>,
    error: unknown,
  ) => readonly [SagaState<number>, readonly U[]];
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
  stepOk: (state: SagaState<number>) => readonly [SagaState<number>, readonly D[]];
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
  undoErr: (
    state: SagaState<number>,
    error: unknown,
  ) => readonly [SagaState<number>, readonly U[]];
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
  undoOk: (state: SagaState<number>) => readonly [SagaState<number>, readonly U[]];
}
```

<a id="createWorkflow"></a>

### `createWorkflow`

```ts
function createWorkflow<A, R, F>(
  restore?: {
    readonly events?: Iterable<EffectLedgerEvent<WorkflowCmd<A>>, any, any>;
    readonly lastId?: number;
  },
): Workflow<A, R, F>
```

<a id="debounce"></a>

### `debounce`

```ts
function debounce<A extends readonly unknown[]>(
  fn: (...args: A) => void,
  ms: number,
  opts?: {
    /**
     * Fire on the FIRST call of a burst (the leading edge),
     *             with that first call's args. Default `false`.
     */
    leading?: boolean;
    /**
     * Fire on the trailing edge with the LAST call's args.
     *             Default `true`.
     *
     * Edge combinations (matching lodash's settled semantics, the de-facto
     * standard the ecosystem rediscovered):
     *
     *   - `{ trailing: true }` (default): one fire, after the burst, last args.
     *   - `{ leading: true, trailing: false }`: one fire, at the burst START,
     *     first args. Subsequent calls within the window are swallowed; the timer
     *     only re-opens the "can lead again" latch after `ms` of quiet.
     *   - `{ leading: true, trailing: true }`: fires at the start AND end of a
     *     burst — BUT the trailing fire is SUPPRESSED for a burst of exactly ONE
     *     call (the leading fire already covered it, so a lone call doesn't
     *     double-fire). This matches lodash and is the behavior tests pin.
     *   - `{ leading: false, trailing: false }`: never fires. Degenerate but legal;
     *     we don't throw — the caller asked for a no-op transformer.
     *
     * WHY a default of trailing-only: a debounce's whole job is "act after the
     * activity settles." The trailing edge IS that semantic — fire with the final
     * state of the burst (the last keystroke, the final scroll position). Leading
     * is the opt-in for "respond instantly, then go quiet."
     */
    trailing?: boolean;
  },
): Debounced<A>
```

<a id="Debounced"></a>

### `Debounced`

```ts
interface Debounced<A extends readonly unknown[]> {
  (...args: A): void;
  /**
   * Drop any pending trailing fire WITHOUT invoking `fn`. Clears the timer and
   * forgets the captured args. Idempotent — calling it with nothing pending is
   * a no-op. The leading-edge latch (if `leading` is enabled) also resets, so
   * the next call after `cancel` is treated as a fresh burst.
   *
   * The host-cleanup partner of `removeEventListener`: cancel the pending fire
   * when the component unmounts / the listener detaches, so a queued
   * `dispatch` can't land after teardown.
   */
  cancel(): void;
  /**
   * Fire any pending trailing call IMMEDIATELY with its captured args, then
   * clear the timer. No-op when nothing is pending. Use to force the last
   * coalesced call out early — e.g. flush a debounced save on `beforeunload`,
   * or flush a debounced search when the user presses Enter.
   */
  flush(): void;
}
```

<a id="DeliveryId"></a>

### `DeliveryId`

```ts
type DeliveryId = number
```

<a id="EffectConfirmed"></a>

### `EffectConfirmed`

```ts
interface EffectConfirmed extends Cmd<"effect_confirmed"> {
  readonly id: number;
}
```

<a id="EffectLedgerEvent"></a>

### `EffectLedgerEvent`

```ts
type EffectLedgerEvent<E> = EffectOwed<E> | EffectConfirmed
```

<a id="EffectOwed"></a>

### `EffectOwed`

```ts
interface EffectOwed<E> extends Cmd<"effect_owed"> {
  readonly effect: E;
  readonly id: number;
}
```

<a id="emptyLedger"></a>

### `emptyLedger`

```ts
function emptyLedger<E>(): PendingEffectsLedger<E>
```

<a id="EndedRun"></a>

### `EndedRun`

```ts
type EndedRun<Stage> = Extract<MonitoredRunState<Stage>, { readonly phase: "done" | "cancelled" }>
```

<a id="EnqueueInput"></a>

### `EnqueueInput`

```ts
type EnqueueInput<I> = I
```

<a id="FailedCompensatedWorkflow"></a>

### `FailedCompensatedWorkflow`

```ts
interface FailedCompensatedWorkflow<A, R, F> {
  /** The forward steps that completed (and were each compensated), in execution order. */
  readonly completed: readonly CompletedStep<A, R>[];
  /** The step whose forward activity failed, triggering the (now-finished) unwind. */
  readonly failedStep: WorkflowStep<A>;
  /** The opaque forward failure that triggered compensation. Carried, never interpreted. */
  readonly failure: F;
  readonly status: "failed_compensated";
  readonly steps: readonly WorkflowStep<A>[];
}
```

<a id="FailedWorkflow"></a>

### `FailedWorkflow`

```ts
interface FailedWorkflow<A, R, F> {
  /** Empty by construction — a failure with completed steps compensates instead. */
  readonly completed: readonly CompletedStep<A, R>[];
  /** The step whose activity failed. */
  readonly failedStep: WorkflowStep<A>;
  /** The opaque failure the activity reported. */
  readonly failure: F;
  readonly status: "failed";
  readonly steps: readonly WorkflowStep<A>[];
}
```

<a id="FanOutConfig"></a>

### `FanOutConfig`

```ts
interface FanOutConfig<I, R, C extends Cmd, J extends Cmd> {
  /** Max in-flight `of(item)` effects. Clamped to `>= 1` (a 0/negative cap would deadlock). */
  readonly concurrency: number;
  /**
   * Stable, deterministic identity for an item. PURE — no clock, no RNG. The
   * id is what `itemOk` / `itemErr` address, so it must survive a round-trip
   * through the durable slice and match across the launch → settle gap. For
   * value-unique inputs (URLs, ids) this is often the identity function; for
   * structural inputs, a content hash or a caller-assigned key.
   */
  readonly idOf: (item: I) => string;
  /**
   * Optional: fold the gathered done-results into a single completion Cmd,
   * fired exactly once at the transition that empties `pending` + `running`.
   * Omit to drive completion off `isComplete` (or the `completion` Port) instead.
   */
  readonly join?: (results: readonly R[]) => J;
  /** The per-item effect, as data. Performed by the consumer's own `interpret`. */
  readonly of: (item: I) => C;
}
```

<a id="FanOutDone"></a>

### `FanOutDone`

```ts
interface FanOutDone<I, R> {
  /** The original scattered input value. */
  readonly item: I;
  /** The result the item's effect produced, routed in via `itemOk`. */
  readonly result: R;
}
```

<a id="FanOutFailed"></a>

### `FanOutFailed`

```ts
interface FanOutFailed<I> {
  /** The error the item's effect surfaced, routed in via `itemErr`. Carried, never interpreted. */
  readonly error: unknown;
  /** The original scattered input value. */
  readonly item: I;
}
```

<a id="FanOutPorts"></a>

### `FanOutPorts`

```ts
interface FanOutPorts<R> {
  /** Fires once with every gathered done-result when the batch completes. */
  readonly complete: Port<readonly R[]>;
}
```

<a id="FanOutState"></a>

### `FanOutState`

```ts
interface FanOutState<I, R> {
  /** Items whose effect resolved OK, with the result it produced. */
  readonly done: readonly FanOutDone<I, R>[];
  /** Items whose effect failed, with the error it surfaced. */
  readonly failed: readonly FanOutFailed<I>[];
  /**
   * The work-queue ledger: one record per scattered item, keyed by the
   * caller's `idOf`. The single source of truth the four arrays project from.
   */
  readonly items: readonly QueueItem<I>[];
  /**
   * Whether the current wave has already fired its `join`. `join` fires at most
   * once per wave — set `true` at the completion edge so a stale settle that
   * re-reaches `isComplete` cannot re-fire it. A new `scatter` that opens a wave
   * resets it to `false`.
   */
  readonly joined: boolean;
  /** Items accepted but not yet launched (queue back-pressure beyond `concurrency`). */
  readonly pending: readonly I[];
  /** Items whose `of(item)` effect is in flight (size never exceeds `concurrency`). */
  readonly running: readonly I[];
  /**
   * Index into `done` where the CURRENT wave's OK results begin. `done` is
   * append-only and accumulates across every wave (so a consumer reading
   * `done` sees the full history), but `join` must fold only the wave that
   * just drained — not the cumulative total. A wave opens when `scatter`
   * enqueues into a slice with nothing in flight; this marks `done.length` at
   * that moment so `join` receives exactly `done.slice(waveDoneFrom)`.
   */
  readonly waveDoneFrom: number;
  /**
   * Index into `failed` where the current wave's failures begin. Symmetric to
   * `waveDoneFrom` — the wave boundary over the failure partition. Carried for
   * a consumer that wants to read only the current wave's failures; `join`
   * itself folds only OK results.
   */
  readonly waveFailedFrom: number;
}
```

<a id="foldWorkflow"></a>

### `foldWorkflow`

```ts
function foldWorkflow<A, R, F>(
  steps: WorkflowSteps<A>,
  msgs: Iterable<WorkflowMsg<R, F>>,
): WorkflowState<A, R, F>
```

<a id="InFlightActivity"></a>

### `InFlightActivity`

```ts
interface InFlightActivity<A> {
  /** The #67 ledger delivery id this activity was owed under (the dedup key). */
  readonly id: number;
  /** The 0-based index of this step in the workflow's step sequence. */
  readonly index: number;
  /** The step whose activity is in flight. */
  readonly step: WorkflowStep<A>;
}
```

<a id="InFlightCompensation"></a>

### `InFlightCompensation`

```ts
interface InFlightCompensation<A> {
  /** The #67 ledger delivery id this compensation was owed under (the dedup key). */
  readonly id: number;
  /** The 0-based index (into the step sequence) of the step being compensated. */
  readonly index: number;
  /** The step whose compensation is in flight. */
  readonly step: WorkflowStep<A>;
}
```

<a id="initBatchWindow"></a>

### `initBatchWindow`

```ts
function initBatchWindow<I>(): BatchWindow<I>
```

<a id="initFanOut"></a>

### `initFanOut`

```ts
function initFanOut<I, R>(): FanOutState<I, R>
```

<a id="initSaga"></a>

### `initSaga`

```ts
function initSaga<I = number>(): SagaState<I>
```

<a id="isAborted"></a>

### `isAborted`

```ts
function isAborted<I>(state: SagaState<I>): boolean
```

<a id="isCommitted"></a>

### `isCommitted`

```ts
function isCommitted<I>(state: SagaState<I>): boolean
```

<a id="isCompensationFailed"></a>

### `isCompensationFailed`

```ts
function isCompensationFailed<I>(state: SagaState<I>): boolean
```

<a id="isComplete"></a>

### `isComplete`

```ts
function isComplete<I, R>(state: FanOutState<I, R>): boolean
```

<a id="isSettled"></a>

### `isSettled`

```ts
function isSettled<I>(state: SagaState<I>): boolean
```

<a id="liftReconciler"></a>

### `liftReconciler`

```ts
function liftReconciler<
  S extends {
    rec: ReconcilerState<Actual, Change, Page, Cursor>;
  },
  Actual,
  Change,
  Page,
  Cursor,
  C extends Cmd,
>(
  state: S,
  __namedParameters: readonly [ReconcilerState<Actual, Change, Page, Cursor>, readonly C[]],
): readonly [S, readonly C[]]
```

<a id="liftRun"></a>

### `liftRun`

```ts
function liftRun<
  S extends { run: MonitoredRunState<Stage> },
  Stage,
  C extends Cmd,
>(
  state: S,
  __namedParameters: readonly [MonitoredRunState<Stage>, readonly C[]],
): readonly [S, readonly C[]]
```

<a id="MonitoredRunCmd"></a>

### `MonitoredRunCmd`

```ts
type MonitoredRunCmd<V> = SnapshotWriteCmd<V>
```

<a id="MonitoredRunConfig"></a>

### `MonitoredRunConfig`

```ts
interface MonitoredRunConfig<Stage> {
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
  /**
   * The ordered stages of the pipeline. Position survives eviction (lives in
   * the Model's stage queue). Omit for a single-shot run. An empty array is
   * treated as single-shot too — there is nothing to pipeline through.
   */
  readonly stages?: readonly Stage[];
}
```

<a id="MonitoredRunState"></a>

### `MonitoredRunState`

```ts
type MonitoredRunState<Stage> =
  | RunCore<Stage> & { readonly phase: "idle" }
  | RunCore<Stage> & {
    readonly phase: "running";
    readonly runId: string;
  }
  | RunCore<Stage> & {
    readonly phase: "stale";
    readonly runId: string;
  }
  | RunCore<Stage> & {
    readonly phase: "done";
    readonly runId: string;
  }
  | RunCore<Stage> & {
    readonly failure: RunFailure<Stage>;
    readonly phase: "failed";
    readonly runId: string;
  }
  | RunCore<Stage> & {
    readonly at: number;
    readonly phase: "cancelled";
    readonly runId: string | null;
  }
```

<a id="MonitoredRunTimerMsg"></a>

### `MonitoredRunTimerMsg`

```ts
type MonitoredRunTimerMsg = DeadlineExceeded
```

<a id="onWindow"></a>

### `onWindow`

```ts
function onWindow<I, C extends Cmd>(
  config: BatchWindowConfig<I, C>,
  state: BatchWindow<I>,
  _at: number,
): readonly [BatchWindow<I>, readonly C[]]
```

<a id="Poller"></a>

### `Poller`

```ts
interface Poller<State, R> {
  /** Seed the Model slice. Idle until `start(...)` arms the first tick. */
  init(): PollerCore<R> & {
    readonly nextAtMs: number | null;
    readonly phase: "polling";
  };
  /**
   * Arm the first tick. `at` is the current clock (carried in from the Msg /
   * runtime that kicks the poller off — never read inside the verb). Returns
   * the slice with the first deadline target set to `at + everyMs` and emits NO
   * Cmd. The cadence has ONE source — the deadline Sub — so `start` does not
   * perform the first observation itself (an immediate `onTick` here would race
   * the timer and poll as fast as the source responds). The first observation
   * fires when the deadline crosses `at + everyMs` and the consumer routes
   * `deadline_exceeded` → `tick`.
   */
  start(
    state: PollerState<R>,
    at: number,
  ): readonly [PollerCore<R> & {
    readonly nextAtMs: number | null;
    readonly phase: "polling";
  }, readonly Cmd[]];
  /**
   * The tick deadline, listed while the poller is `"polling"` with an armed
   * `nextAtMs`; `[]` once `"done"` / `"gave_up"` (the timer disarms) or before
   * `start`. Declare it on the machine:
   * `subs: [deadlinesSub((s) => poll.subs(s.poll))]`.
   *
   * The list is armed by `../deadline`'s `subscribeDeadline` runner, which the
   * consumer passes to `run` as `subscribe.deadline` — the poller does not
   * redraw the timer lifecycle.
   */
  subs(state: PollerState<R>): readonly PollerSub[];
  /**
   * Perform one observation — the cadence verb. The consumer routes the
   * deadline Sub's `deadline_exceeded` Msg here; `tick` emits the single
   * `config.onTick()` Cmd that goes and reads the source. This is the ONLY
   * next-tick mechanism: the timer fires, the consumer calls `tick`, the fetch
   * runs, and the observation comes back through `tickResult` / `tickErr`
   * (which re-arm the next deadline). A no-op on a finished poller — a stale
   * deadline fire racing a terminal transition the reconcile pass has not yet
   * retired emits nothing.
   *
   * Takes no `at`: `tick` does not touch the schedule (the just-fired deadline
   * is exhausted; the next target is set when the result lands), so it needs no
   * clock — keeping it trivially pure.
   */
  tick(state: PollerState<R>): readonly [PollerState<R>, readonly Cmd[]];
  /**
   * Record a FAILED tick at clock `at`. Backs off instead of holding the
   * steady cadence:
   *
   * - Advances the retry counter (`recordFailure`).
   * - If `shouldRetry` still permits another attempt, arms the next tick at
   *   `at + nextDelayMs(retry, policy)` (the backoff curve) and emits NO Cmd —
   *   the retry observation fires when that backoff deadline crosses and the
   *   consumer routes `deadline_exceeded` → `tick`. The timer is the single
   *   next-tick mechanism, on the backoff curve here instead of `everyMs`.
   * - If backoff is exhausted (`!shouldRetry`), enters `"gave_up"`, disarms
   *   (`nextAtMs: null`), and emits no Cmd.
   *
   * `at` is both the backoff anchor AND the streak clock: it is passed to
   * `recordFailure` (starting / preserving `firstFailureAtMs`) and to
   * `shouldRetry`, so a `DurationRetryPolicy` on `config.retry` is honoured
   * with no extra wiring. Under a duration bound the poller keeps retrying
   * however many attempts the outage takes, and stops at the declared
   * wall-clock budget measured from the streak's FIRST failure.
   *
   * The backoff jitter uses the `rng` injected ONCE at `createPoller` (default
   * `Math.random` at the effect boundary, a fixed value in tests); the verb
   * body never names the global RNG, so a poller built with a fixed `rng`
   * replays a failure-and-backoff run bit-for-bit.
   */
  tickErr(
    state: PollerState<R>,
    error: unknown,
    at: number,
  ): readonly [PollerCore<R> & {
    readonly nextAtMs: number | null;
    readonly phase: "polling";
  } | PollerCore<R> & { readonly phase: "gave_up" }, readonly Cmd[]];
  /**
   * Record a successful tick observation at clock `at`.
   *
   * - Resets the retry counter (a success clears consecutive-failure state).
   * - Stores `result` as `lastResult` and bumps `tick`.
   * - Re-arms the next tick at the absolute target `at + everyMs` (the steady
   *   cadence). It emits NO cadence `onTick` — the next observation fires from
   *   the deadline Sub via `tick`, never immediately from a result.
   * - Dedupe (opt-in, orthogonal to cadence): when `dedupeKey` is set, a FRESH
   *   observation emits one `onTick` FOLLOW-UP (the consumer's "run the
   *   downstream side effect once per distinct observation" hook) and a
   *   DUPLICATE key records the sighting but suppresses the follow-up. With no
   *   `dedupeKey`, `tickResult` emits nothing — the cadence `tick` is the only
   *   `onTick`, so an unconfigured poller never double-fetches.
   * - UNLESS `untilHeld` is `true` (the consumer evaluated `config.until`
   *   against the post-result Model) — then the poller enters `"done"`,
   *   disarms (`nextAtMs: null`), and emits no Cmd, dedupe or otherwise.
   *
   * `untilHeld` is passed in rather than computed here because `until` reads
   * the consumer's WHOLE Model, which this verb does not hold — the consumer
   * evaluates it at the call site after folding `result` into its Model and
   * passes the boolean. (`subs` re-checks `phase` to decide arming, so a
   * mis-passed `untilHeld` cannot leave a "done" poller arming timers.)
   */
  tickResult(
    state: PollerState<R>,
    result: R,
    at: number,
    untilHeld: boolean,
  ): readonly [PollerCore<R> & {
    readonly nextAtMs: number | null;
    readonly phase: "polling";
  } | PollerCore<R> & { readonly phase: "done" }, readonly Cmd[]];
}
```

<a id="PollerConfig"></a>

### `PollerConfig`

```ts
interface PollerConfig<State, R> {
  /**
   * Optional dedupe key derived from a tick result. When provided, a result
   * whose key was already `seen` records the observation but emits NO fresh
   * `onTick` follow-up — the side effect runs once per distinct observation.
   * Omit to treat every tick result as fresh (no dedupe). The dedupe store is
   * bounded by `dedupeTtlMs` if set; otherwise it grows with distinct keys.
   */
  readonly dedupeKey?: (result: R) => string;
  /**
   * TTL for the dedupe store, in milliseconds. Only meaningful when
   * `dedupeKey` is set. An observation older than `dedupeTtlMs` is forgotten,
   * so a key seen long ago is treated as fresh again. Omit for an unbounded
   * dedupe window (every distinct key remembered for the poller's lifetime).
   */
  readonly dedupeTtlMs?: number;
  /**
   * The steady cadence, in milliseconds, between successful ticks. The next
   * tick is armed at the absolute target `at + everyMs` (computed from the
   * `at` the prior tick's Msg carried), NOT `everyMs` from when the Sub
   * happens to be reconciled — so the cadence does not drift across resumes.
   */
  readonly everyMs: number;
  /**
   * The effect to run on each tick — the actual "go observe the source" Cmd
   * (a fetch, a status read, a list call). The knob returns it from
   * `tickResult` when the run continues; the consumer's `interpret` performs
   * it and routes the observation back as the next tick-result Msg.
   *
   * Nullary by contract: a tick carries no per-call argument (the poller
   * re-reads the same source every cadence). Capture any target in the Cmd
   * literal the consumer's `onTick` returns.
   */
  readonly onTick: () => Cmd;
  /**
   * Backoff policy for FAILED ticks. Omit to use `defaultRetryPolicy`
   * (full-jitter, 5 attempts). A success resets the retry counter, so the
   * policy only governs consecutive failures.
   *
   * Any bound the `../retry-backoff` union admits: a count (`RetryPolicy`), a
   * wall-clock outage budget (`DurationRetryPolicy`), or explicit
   * `unbounded: true`. The duration bound needs no extra wiring here — every
   * failure already arrives through `tickErr(state, error, at)` carrying the
   * instant it was observed, so the streak clock is fed from the Msg's own
   * data and the poller never reads a clock of its own (invariant 2).
   */
  readonly retry?: AnyRetryPolicy;
  /**
   * The stop predicate, read against the consumer's whole Model. When it
   * returns `true`, the poller is DONE: `subs` returns `[]` (the timer
   * disarms) and no further tick is scheduled. Pure — it must not read the
   * clock or mutate; the consumer's reducer cell calls it (`untilHeld`).
   */
  readonly until: (state: State) => boolean;
}
```

<a id="PollerDone"></a>

### `PollerDone`

```ts
type PollerDone<R> = Extract<PollerState<R>, { phase: "done" }>
```

<a id="PollerGaveUp"></a>

### `PollerGaveUp`

```ts
type PollerGaveUp<R> = Extract<PollerState<R>, { phase: "gave_up" }>
```

<a id="PollerPolling"></a>

### `PollerPolling`

```ts
type PollerPolling<R> = Extract<PollerState<R>, { phase: "polling" }>
```

<a id="PollerState"></a>

### `PollerState`

```ts
type PollerState<R> =
  | PollerCore<R> & {
    readonly nextAtMs: number | null;
    readonly phase: "polling";
  }
  | PollerCore<R> & { readonly phase: "done" }
  | PollerCore<R> & { readonly phase: "gave_up" }
```

<a id="PollerSub"></a>

### `PollerSub`

```ts
type PollerSub = DeadlineSub
```

<a id="ReconcilePhase"></a>

### `ReconcilePhase`

```ts
type ReconcilePhase = "idle" | "scanning" | "applying" | "done" | "failed"
```

<a id="ReconcilerConfig"></a>

### `ReconcilerConfig`

```ts
interface ReconcilerConfig<Actual, Desired, Page, Change, ApplyCmd extends Cmd, Cursor = number> {
  /**
   * Realize one `Change` as the Cmd that mutates the actual world. Returns plain
   * data (a `{ type, ... }` Cmd the consumer's interpret handler performs).
   * PURE — the side effect happens when the runtime performs the emitted Cmd,
   * never here.
   */
  readonly apply: (change: Change) => ApplyCmd;
  /** Circuit breaker around the scan fetch (one upstream → one breaker). */
  readonly circuit?: CircuitConfig;
  /** Overall wall-clock deadline per individual scan-page fetch. */
  readonly deadline?: DeadlineConfig;
  /**
   * The DESIRED spec to converge on. Held verbatim and handed to `diff` once the
   * scan completes. Any JSON-serializable value — a list of specs, a target map,
   * a single target object — `diff` alone interprets it.
   */
  readonly desired: Desired;
  /**
   * Compute the remediation plan: the ordered `Change[]` that moves `actual` to
   * `desired`. Called once when the scan finishes (the full actual snapshot is in
   * hand). An empty plan means "already in sync — nothing to apply". PURE +
   * consumer-specific (only the consumer knows the domain's reconcile rules).
   */
  readonly diff: (desired: Desired, actual: readonly Actual[]) => readonly Change[];
  /**
   * The cursor the actual-list scan fetches first. For an offset API typically
   * `0`; for a token API whatever sentinel the API treats as page one.
   */
  readonly firstPage: Cursor;
  /**
   * Stable identity for a `Change` — the applied-ledger cache key. A re-`applyNext`
   * after eviction (or after a re-plan) skips a change whose id is already in the
   * ledger (idempotent re-apply). MUST be a property of the change itself, NOT its
   * position in the plan: the ledger has to survive re-planning. When omitted the
   * default keys by the change's serialized CONTENT (`JSON.stringify(change)`) —
   * a stable per-change identity that is unchanged by where the change sits in the
   * plan. Supply a domain id (the target node id, the resource key) when one
   * exists; it is cheaper than serializing and dedupes two changes that differ
   * only in fields irrelevant to identity. PURE.
   *
   * Why NOT positional: keying by index silently drops changes on the documented
   * re-plan path. After applying the index-0 change, its `"0"` ledger entry would
   * match WHATEVER different, never-applied change lands at index 0 in the next
   * plan — the apply loop skips it as "already done". Identity must be intrinsic
   * to the change so the ledger means "this change settled", not "slot N settled".
   */
  readonly idOf?: (change: Change) => string;
  /**
   * Extract the actual items from one fetched page. Each page's items are
   * appended to the running `actual` accumulator. PURE.
   */
  readonly itemsOf: (page: Page) => readonly Actual[];
  /**
   * Extract the next scan cursor from a fetched page — a `Cursor` to keep
   * scanning, or `null` when the actual listing is exhausted (scan finishes,
   * plan computed). PURE + consumer-specific.
   */
  readonly nextCursor: (page: Page) => Cursor | null;
  /** Token-bucket rate limit on the scan — the "don't 429 the listing API" knob. */
  readonly rateLimit?: RateLimitConfig;
  /** Exponential-backoff retry policy for a transient scan-page failure. */
  readonly retry?: RetryPolicy;
}
```

<a id="ReconcilerState"></a>

### `ReconcilerState`

```ts
interface ReconcilerState<Actual, Change, Page, Cursor = number> {
  readonly actual: readonly Actual[];
  readonly applied: TtlCache<Change>;
  readonly appliedCursor: number;
  readonly phase: ReconcilePhase;
  readonly plan: readonly Change[];
  readonly walk: PaginatedWalkState<Cursor, Page>;
}
```

<a id="ReconcilerTimerMsg"></a>

### `ReconcilerTimerMsg`

```ts
type ReconcilerTimerMsg = PaginatedWalkTimerMsg
```

<a id="routeWorkflowMsg"></a>

### `routeWorkflowMsg`

```ts
function routeWorkflowMsg<A, R, F>(
  wf: Workflow<A, R, F>,
  state: WorkflowState<A, R, F>,
  msg: WorkflowMsg<R, F>,
): WorkflowReducerStep<A, R, F>
```

<a id="RunFailure"></a>

### `RunFailure`

```ts
type RunFailure<Stage> =
  | {
    readonly at: number;
    readonly reason: "deadline";
  }
  | {
    readonly error: unknown;
    readonly reason: "stage";
    readonly stage: Stage | undefined;
  }
```

<a id="RunningWorkflow"></a>

### `RunningWorkflow`

```ts
interface RunningWorkflow<A, R> {
  /** Steps that have produced a result, in execution order. */
  readonly completed: readonly CompletedStep<A, R>[];
  /** The single activity in flight right now. */
  readonly current: InFlightActivity<A>;
  readonly status: "running";
  /** The full, static step sequence this workflow runs. */
  readonly steps: readonly WorkflowStep<A>[];
}
```

<a id="runToTerminal"></a>

### `runToTerminal`

```ts
function runToTerminal<
  S,
  M extends { type: string },
  C extends Cmd,
  U extends Sub,
  Ctx,
>(
  machine: Machine<S, M, C, U, Ctx>,
  seed: CtxArg<Ctx> & NoInfer<RunHandlers<M, C, U, Ctx>> & { readonly msgs: readonly M[] },
  isTerminal: (state: S) => boolean,
  opts?: AwaitTerminalOptions,
): Promise<S>
```

<a id="SagaConfig"></a>

### `SagaConfig`

```ts
interface SagaConfig<D extends Cmd, U extends Cmd> {
  /** The steps, in forward order. `do` runs `0 → n-1`; `undo` runs the completed prefix `n-1 → 0`. */
  readonly steps: readonly SagaStep<D, U>[];
}
```

<a id="SagaPhase"></a>

### `SagaPhase`

```ts
type SagaPhase =
  | "idle"
  | "running"
  | "compensating"
  | "committed"
  | "aborted"
  | "compensation_failed"
```

<a id="SagaState"></a>

### `SagaState`

```ts
interface SagaState<I = StepId> {
  /** Direction bit: `false` winding forward, `true` unwinding. */
  readonly compensating: boolean;
  /** The failure of an `undo` itself (only when `compensation_failed`). Carried, never interpreted. */
  readonly compensationError?: unknown;
  /** The compensation log: ids of completed-forward steps, in completion order. */
  readonly done: readonly number[];
  /** The forward failure that triggered compensation, if any. Carried, never interpreted. */
  readonly error?: unknown;
  /** The work-queue ledger: one record per step, keyed by positional id. */
  readonly items: readonly QueueItem<I>[];
  /** The derived lifecycle tag (see `SagaPhase`). */
  readonly phase: SagaPhase;
  /** The step in flight (`running`) or being compensated (`compensating`). */
  readonly position: number;
}
```

<a id="SagaStep"></a>

### `SagaStep`

```ts
interface SagaStep<D extends Cmd, U extends Cmd> {
  /** The forward effect, performed while the saga winds forward. */
  readonly do: D;
  /** The compensating inverse, performed (in reverse) while the saga unwinds. */
  readonly undo: U;
}
```

<a id="ScanPageCmd"></a>

### `ScanPageCmd`

```ts
type ScanPageCmd<Cursor> = FetchPageCmd<Cursor>
```

<a id="ScanPageErrMsg"></a>

### `ScanPageErrMsg`

```ts
type ScanPageErrMsg = PageErrMsg
```

<a id="ScanPageOkMsg"></a>

### `ScanPageOkMsg`

```ts
type ScanPageOkMsg<Page> = PageOkMsg<Page>
```

<a id="SnapshotSavedMsg"></a>

### `SnapshotSavedMsg`

```ts
type SnapshotSavedMsg<V = unknown> = SettledOk<"snapshot_write", SnapshotWriteCmd<V>, undefined>
```

<a id="SnapshotWriteCmd"></a>

### `SnapshotWriteCmd`

```ts
type SnapshotWriteCmd<V> = CmdOf<ReturnType<typeof snapshotWriteDef>>
```

<a id="StageResult"></a>

### `StageResult`

```ts
type StageResult =
  | { readonly kind: "ok" }
  | {
    readonly error: unknown;
    readonly kind: "fail";
  }
```

<a id="StepId"></a>

### `StepId`

```ts
type StepId = number
```

<a id="subscribeBatchWindow"></a>

### `subscribeBatchWindow`

```ts
const subscribeBatchWindow: Subscribe<BatchWindowExpired, DeadlinesSub, unknown>["deadline"]
```

<a id="subsFor"></a>

### `subsFor`

```ts
function subsFor<I, C extends Cmd>(
  config: BatchWindowConfig<I, C>,
  state: BatchWindow<I>,
  id?: string,
): readonly BatchWindowSub[]
```

<a id="TerminalTimeoutError"></a>

### `TerminalTimeoutError`

```ts
class TerminalTimeoutError extends Error {
  constructor(timeoutMs: number);
  readonly _tag: "TerminalTimeoutError";
  readonly name: "TerminalTimeoutError";
  readonly timeoutMs: number;
}
```

<a id="timerFor"></a>

### `timerFor`

```ts
function timerFor<I, C extends Cmd>(
  config: BatchWindowConfig<I, C>,
  state: BatchWindow<I>,
  id?: string,
): TimerDeps<BatchWindowExpired> | null
```

<a id="Workflow"></a>

### `Workflow`

```ts
interface Workflow<A, R, F> {
  /**
   * Seed a fresh workflow over `steps` (a NON-EMPTY WorkflowSteps) and
   * dispatch its first activity → `running` with `current` = step 0, owed on the
   * ledger. The "≥ 1 step" precondition is carried by the tuple type: an empty
   * sequence is a compile error at the call site, not a runtime throw here — a
   * workflow with nothing to do could never reach `completed` (no final result
   * to carry), so it is unrepresentable by construction.
   */
  init(steps: WorkflowSteps<A>): WorkflowReducerStep<A, R, F>;
  /**
   * Fold an activity failure (#125). Same id-match idempotency guard as
   * onActivityOk. On a match: confirm the owed activity on the ledger,
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
  ): WorkflowReducerStep<A, R, F>;
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
  ): WorkflowReducerStep<A, R, F>;
  /**
   * Fold a compensation failure (#125). Same id-match idempotency guard. On a
   * match: confirm the owed compensation and HALT the rollback at the terminal
   * `compensation_failed` state — a bounced compensation is visible terminal
   * state to reconcile by hand, never a workflow wedged in `compensating`
   * forever. Mirrors `../saga/`'s `undoErr`.
   */
  onCompensationErr(
    state: WorkflowState<A, R, F>,
    msg: CompensationErr<F>,
  ): WorkflowReducerStep<A, R, F>;
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
  ): WorkflowReducerStep<A, R, F>;
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
```

<a id="WORKFLOW_MSG_TYPES"></a>

### `WORKFLOW_MSG_TYPES`

```ts
const WORKFLOW_MSG_TYPES: ReadonlySet<string>
```

<a id="WORKFLOW_STATUSES"></a>

### `WORKFLOW_STATUSES`

```ts
const WORKFLOW_STATUSES: ReadonlySet<string>
```

<a id="workflowActivityDef"></a>

### `workflowActivityDef`

```ts
function workflowActivityDef<A>(): CmdDef<"workflow_activity", {
  /** The opaque activity to perform. */
  readonly activity: A;
  /** The #67 delivery id the result Msg must echo (the dedup key). */
  readonly id: number;
  /** The 0-based step index this activity belongs to. */
  readonly index: number;
}, undefined, never>
```

<a id="WorkflowCmd"></a>

### `WorkflowCmd`

```ts
type WorkflowCmd<A> = ActivityCmd<A> | CompensationCmd<A>
```

<a id="workflowCompensationDef"></a>

### `workflowCompensationDef`

```ts
function workflowCompensationDef<A>(): CmdDef<"workflow_compensation", {
  /** The opaque compensating (inverse) activity to perform. */
  readonly compensation: A;
  /** The #67 delivery id the result Msg must echo (the dedup key). */
  readonly id: number;
  /** The 0-based step index whose compensation this is. */
  readonly index: number;
}, undefined, never>
```

<a id="WorkflowMsg"></a>

### `WorkflowMsg`

```ts
type WorkflowMsg<R, F> = ActivityOk<R> | ActivityErr<F> | CompensationOk | CompensationErr<F>
```

<a id="WorkflowMsgType"></a>

### `WorkflowMsgType`

```ts
type WorkflowMsgType = WorkflowMsg<unknown, unknown>["type"]
```

<a id="WorkflowReducerStep"></a>

### `WorkflowReducerStep`

```ts
interface WorkflowReducerStep<A, R, F> {
  /** Activity dispatch Cmds, after the ledger events are durable. */
  readonly cmds: readonly WorkflowCmd<A>[];
  /** Ledger events to persist into the event log, in order, BEFORE `cmds`. */
  readonly ledger: readonly EffectLedgerEvent<WorkflowCmd<A>>[];
  readonly state: WorkflowState<A, R, F>;
}
```

<a id="WorkflowState"></a>

### `WorkflowState`

```ts
type WorkflowState<A, R, F> =
  | RunningWorkflow<A, R>
  | CompletedWorkflow<A, R>
  | FailedWorkflow<A, R, F>
  | CompensatingWorkflow<A, R, F>
  | FailedCompensatedWorkflow<A, R, F>
  | CompensationFailedWorkflow<A, R, F>
```

<a id="WorkflowStatus"></a>

### `WorkflowStatus`

```ts
type WorkflowStatus = WorkflowState<unknown, unknown, unknown>["status"]
```

<a id="WorkflowStep"></a>

### `WorkflowStep`

```ts
interface WorkflowStep<A> {
  /** The opaque activity this step performs. Interpreted by the consumer. */
  readonly activity: A;
  /**
   * The opaque compensating (inverse) activity, performed in reverse order on a
   * downstream failure (#125). Optional: a step with no compensation is skipped
   * during the unwind. Interpreted by the consumer's interpret cell, exactly
   * like activity.
   */
  readonly compensation?: A;
  /** Stable, human-readable step name — appears in the completed-step record. */
  readonly name: string;
}
```

<a id="WorkflowSteps"></a>

### `WorkflowSteps`

```ts
type WorkflowSteps<A> = readonly [WorkflowStep<A>, ...WorkflowStep<A>[]]
```
