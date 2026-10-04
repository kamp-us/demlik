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
  readonly flush: (items: readonly I[]) => C;
  readonly maxItems: number;
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
  add(
    state: BatchWindow<I>,
    item: I,
    at: number,
  ): readonly [BatchWindow<I>, readonly C[]];
  init(): BatchWindow<I>;
  onWindow(state: BatchWindow<I>, at: number): readonly [BatchWindow<I>, readonly C[]];
  subs(state: BatchWindow<I>, id?: string): readonly BatchWindowSub[];
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
  readonly compensated: readonly CompletedStep<A, R>[];
  readonly completed: readonly CompletedStep<A, R>[];
  readonly current: InFlightCompensation<A>;
  readonly failedStep: WorkflowStep<A>;
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
  readonly compensated: readonly CompletedStep<A, R>[];
  readonly compensationFailure: F;
  readonly completed: readonly CompletedStep<A, R>[];
  readonly failedCompensationStep: WorkflowStep<A>;
  readonly failedStep: WorkflowStep<A>;
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
  readonly completed: readonly CompletedStep<A, R>[];
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
  completion: (
    ports: FanOutPorts<R>,
  ) => {
    emitOnComplete(emit: <T>(port: Port<T>, value: T) => void, state: FanOutState<I, R>): void;
  };
  init: () => FanOutState<I, R>;
  isComplete: <I, R>(state: FanOutState<I, R>) => boolean;
  itemErr: (
    state: FanOutState<I, R>,
    id: string,
    error: unknown,
  ) => readonly [FanOutState<I, R>, readonly (C | J)[]];
  itemOk: (
    state: FanOutState<I, R>,
    id: string,
    result: R,
  ) => readonly [FanOutState<I, R>, readonly (C | J)[]];
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
  advance: (
    s: MonitoredRunState<Stage>,
    payload: V,
    result: StageResult,
    at: number,
  ) => readonly [MonitoredRunState<Stage>, readonly MonitoredRunCmd<V>[]];
  boot: (
    s: MonitoredRunState<Stage>,
    at: number,
  ) => readonly [MonitoredRunState<Stage>, readonly MonitoredRunCmd<V>[]];
  cancel: (
    s: MonitoredRunState<Stage>,
    at: number,
  ) => readonly [MonitoredRunState<Stage>, readonly MonitoredRunCmd<V>[]];
  checkpoint: CmdDef<"snapshot_write", {
    readonly at: number;
    readonly key: string;
    readonly payload: V;
    readonly seq: number;
  }, undefined, {
    readonly [detail: string]: unknown;
    readonly _tag: "snapshot_write_failed";
  }>;
  confirmSnapshot: (
    s: MonitoredRunState<Stage>,
    msg: SnapshotSavedMsg<V>,
  ) => MonitoredRunState<Stage>;
  deadlines: (s: MonitoredRunState<Stage>) => readonly DeadlineSub[];
  init: () => MonitoredRunState<Stage>;
  markStale: (
    s: MonitoredRunState<Stage>,
  ) => readonly [MonitoredRunState<Stage>, readonly MonitoredRunCmd<V>[]];
  onDeadline: (
    s: MonitoredRunState<Stage>,
    msg: MonitoredRunTimerMsg,
  ) => readonly [MonitoredRunState<Stage>, readonly MonitoredRunCmd<V>[]];
  progress: (
    s: MonitoredRunState<Stage>,
    payload: V,
    at: number,
  ) => readonly [MonitoredRunState<Stage>, readonly MonitoredRunCmd<V>[]];
  start: (
    s: MonitoredRunState<Stage>,
    runId: string,
    at: number,
  ) => readonly [MonitoredRunState<Stage>, readonly MonitoredRunCmd<V>[]];
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
  applied: (s: State, change: Change, at: number) => readonly [State, readonly OutCmd[]];
  applyNext: (s: State, at: number) => readonly [State, readonly OutCmd[]];
  deadlines: (s: State) => readonly DeadlineSub[];
  init: () => State;
  isComplete: (s: State) => boolean;
  onTimer: (s: State, msg: PaginatedWalkTimerMsg) => readonly [State, readonly OutCmd[]];
  pageErr: (s: State, msg: PageErrMsg) => readonly [State, readonly OutCmd[]];
  pageOk: (s: State, msg: ScanPageOkMsg<Page>) => readonly [State, readonly OutCmd[]];
  planned: (
    s: State,
    at: number,
    changes?: readonly Change[],
  ) => readonly [State, readonly OutCmd[]];
  scan: (s: State, at: number) => readonly [State, readonly OutCmd[]];
  scanPage: CmdDef<"resilient_run", { readonly input: Cursor; readonly key: string }, Page, {
    readonly [detail: string]: unknown;
    readonly _tag: "deadline_exceeded";
  } | {
    readonly [detail: string]: unknown;
    readonly _tag: "port_rejected";
  }>;
  timer: (s: State) => TimerDeps<ResilientTimerMsg<"resilient">> | null;
}
```

<a id="createSaga"></a>

### `createSaga`

```ts
function createSaga<D extends Cmd, U extends Cmd>(
  config: SagaConfig<D, U>,
): {
  init: () => SagaState<number>;
  isAborted: <I>(state: SagaState<I>) => boolean;
  isCommitted: <I>(state: SagaState<I>) => boolean;
  isCompensationFailed: <I>(state: SagaState<I>) => boolean;
  isSettled: <I>(state: SagaState<I>) => boolean;
  start: (state: SagaState<number>) => readonly [SagaState<number>, readonly D[]];
  stepErr: (
    state: SagaState<number>,
    error: unknown,
  ) => readonly [SagaState<number>, readonly U[]];
  stepOk: (state: SagaState<number>) => readonly [SagaState<number>, readonly D[]];
  undoErr: (
    state: SagaState<number>,
    error: unknown,
  ) => readonly [SagaState<number>, readonly U[]];
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
  opts?: { leading?: boolean; trailing?: boolean },
): Debounced<A>
```

<a id="Debounced"></a>

### `Debounced`

```ts
interface Debounced<A extends readonly unknown[]> {
  (...args: A): void;
  cancel(): void;
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
  readonly completed: readonly CompletedStep<A, R>[];
  readonly failedStep: WorkflowStep<A>;
  readonly failure: F;
  readonly status: "failed_compensated";
  readonly steps: readonly WorkflowStep<A>[];
}
```

<a id="FailedWorkflow"></a>

### `FailedWorkflow`

```ts
interface FailedWorkflow<A, R, F> {
  readonly completed: readonly CompletedStep<A, R>[];
  readonly failedStep: WorkflowStep<A>;
  readonly failure: F;
  readonly status: "failed";
  readonly steps: readonly WorkflowStep<A>[];
}
```

<a id="FanOutConfig"></a>

### `FanOutConfig`

```ts
interface FanOutConfig<I, R, C extends Cmd, J extends Cmd> {
  readonly concurrency: number;
  readonly idOf: (item: I) => string;
  readonly join?: (results: readonly R[]) => J;
  readonly of: (item: I) => C;
}
```

<a id="FanOutDone"></a>

### `FanOutDone`

```ts
interface FanOutDone<I, R> {
  readonly item: I;
  readonly result: R;
}
```

<a id="FanOutFailed"></a>

### `FanOutFailed`

```ts
interface FanOutFailed<I> {
  readonly error: unknown;
  readonly item: I;
}
```

<a id="FanOutPorts"></a>

### `FanOutPorts`

```ts
interface FanOutPorts<R> {
  readonly complete: Port<readonly R[]>;
}
```

<a id="FanOutState"></a>

### `FanOutState`

```ts
interface FanOutState<I, R> {
  readonly done: readonly FanOutDone<I, R>[];
  readonly failed: readonly FanOutFailed<I>[];
  readonly items: readonly QueueItem<I>[];
  readonly joined: boolean;
  readonly pending: readonly I[];
  readonly running: readonly I[];
  readonly waveDoneFrom: number;
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
  readonly id: number;
  readonly index: number;
  readonly step: WorkflowStep<A>;
}
```

<a id="InFlightCompensation"></a>

### `InFlightCompensation`

```ts
interface InFlightCompensation<A> {
  readonly id: number;
  readonly index: number;
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
  readonly deadlineMs?: number;
  readonly snapshotEvery?: number;
  readonly snapshotKey?: string;
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
  init(): PollerCore<R> & {
    readonly nextAtMs: number | null;
    readonly phase: "polling";
  };
  start(
    state: PollerState<R>,
    at: number,
  ): readonly [PollerCore<R> & {
    readonly nextAtMs: number | null;
    readonly phase: "polling";
  }, readonly Cmd[]];
  subs(state: PollerState<R>): readonly PollerSub[];
  tick(state: PollerState<R>): readonly [PollerState<R>, readonly Cmd[]];
  tickErr(
    state: PollerState<R>,
    error: unknown,
    at: number,
  ): readonly [PollerCore<R> & {
    readonly nextAtMs: number | null;
    readonly phase: "polling";
  } | PollerCore<R> & { readonly phase: "gave_up" }, readonly Cmd[]];
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
  readonly dedupeKey?: (result: R) => string;
  readonly dedupeTtlMs?: number;
  readonly everyMs: number;
  readonly onTick: () => Cmd;
  readonly retry?: AnyRetryPolicy;
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
  readonly apply: (change: Change) => ApplyCmd;
  readonly circuit?: CircuitConfig;
  readonly deadline?: DeadlineConfig;
  readonly desired: Desired;
  readonly diff: (desired: Desired, actual: readonly Actual[]) => readonly Change[];
  readonly firstPage: Cursor;
  readonly idOf?: (change: Change) => string;
  readonly itemsOf: (page: Page) => readonly Actual[];
  readonly nextCursor: (page: Page) => Cursor | null;
  readonly rateLimit?: RateLimitConfig;
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
  readonly completed: readonly CompletedStep<A, R>[];
  readonly current: InFlightActivity<A>;
  readonly status: "running";
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
  readonly compensating: boolean;
  readonly compensationError?: unknown;
  readonly done: readonly number[];
  readonly error?: unknown;
  readonly items: readonly QueueItem<I>[];
  readonly phase: SagaPhase;
  readonly position: number;
}
```

<a id="SagaStep"></a>

### `SagaStep`

```ts
interface SagaStep<D extends Cmd, U extends Cmd> {
  readonly do: D;
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
  init(steps: WorkflowSteps<A>): WorkflowReducerStep<A, R, F>;
  onActivityErr(
    state: WorkflowState<A, R, F>,
    msg: ActivityErr<F>,
  ): WorkflowReducerStep<A, R, F>;
  onActivityOk(
    state: WorkflowState<A, R, F>,
    msg: ActivityOk<R>,
  ): WorkflowReducerStep<A, R, F>;
  onCompensationErr(
    state: WorkflowState<A, R, F>,
    msg: CompensationErr<F>,
  ): WorkflowReducerStep<A, R, F>;
  onCompensationOk(
    state: WorkflowState<A, R, F>,
    msg: CompensationOk,
  ): WorkflowReducerStep<A, R, F>;
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
  readonly activity: A;
  readonly id: number;
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
  readonly compensation: A;
  readonly id: number;
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
  readonly cmds: readonly WorkflowCmd<A>[];
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
  readonly activity: A;
  readonly compensation?: A;
  readonly name: string;
}
```

<a id="WorkflowSteps"></a>

### `WorkflowSteps`

```ts
type WorkflowSteps<A> = readonly [WorkflowStep<A>, ...WorkflowStep<A>[]]
```
