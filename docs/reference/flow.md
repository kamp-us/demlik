# @demlik/tea/flow

> the multi-step control-flow batteries: fan a batch out, run steps in order and compensate on failure, poll until a predicate holds, reconcile desired against actual.

```ts
import { … } from "@demlik/tea/flow";
```

## Exports (110)

| Symbol | Kind | Summary |
| --- | --- | --- |
| `ActivityCmd` | Type |  |
| `ActivityErr` | Interface | An activity failed (retries already exhausted by the consumer's interpret cell — this module does not retry). |
| `ActivityOk` | Interface | An activity succeeded: `id` echoes the ActivityCmd it answers; the reducer matches it against `current.id`, records the completed step, and advances. |
| `addItem` | Function | Buffer `item` and decide whether the size trigger fires. |
| `awaitTerminal` | Function | Attach to an ALREADY-RUNNING `Runtime<S, M, E>` and resolve with the terminal `S` on the first transition for which `isTerminal(state)` is true. |
| `AwaitTerminalOptions` | Interface | Options shared by `awaitTerminal` and `runToTerminal`. |
| `BatchWindow` | Interface | The Model slice a batch window owns. |
| `BatchWindowConfig` | Interface | Configuration for a batch window — the knob. |
| `batchWindowExpired` | Function | Construct the window-expired Msg for the window identified by `id`, flushing by `atMs`. |
| `BatchWindowExpired` | Type | The Msg a closed-by-time window dispatches. |
| `BatchWindowKnob` | Interface | The bound knob returned by `createBatchWindow`. |
| `BatchWindowSub` | Type | The deadline a batch window's open timer lists: it IS `../deadline`'s `DeadlineSub`, not a re-tagged copy. |
| `CompensatingWorkflow` | Interface | A workflow unwinding after a forward failure (#125): the compensations of the `completed` steps are being emitted in STRICT REVERSE order, one at a time, on the same #67 ledger. |
| `CompensationCmd` | Type |  |
| `CompensationErr` | Interface | A compensation itself failed (#125): the inverse activity bounced (a refund that won't go through). |
| `CompensationFailedWorkflow` | Interface | A workflow whose ROLLBACK itself failed: a compensation activity reported a failure mid-unwind. |
| `CompensationOk` | Interface | A compensation succeeded (#125): the inverse activity took. |
| `CompletedStep` | Interface | A completed step: the step that ran plus the result its activity produced. |
| `CompletedWorkflow` | Interface | A workflow that ran every step to completion. |
| `createBatchWindow` | Function | Build a batch window knob from a config. |
| `createFanOut` | Function | Build the fan-out knob from `config`. |
| `createMonitoredRun` | Function | Build a monitored-run knob from `config`. |
| `createPoller` | Function | Build a poller knob from `config`. |
| `createReconciler` | Function | Build a reconciler knob from `config`. |
| `createSaga` | Function | Build the saga knob from `config`. |
| `createWorkflow` | Function | Build a workflow hook bag. |
| `DeadlineExceeded` | Type | The Msg the deadline dispatches when the wall clock crosses `atMs`. |
| `deadlinesSub` | Function | Re-export the deadline primitives so consumers (and tests) wire one import: `subscribeDeadline` is the `deadline` runner, `deadlinesSub` a machine's `subs` entry, and `deadlineSub` builds the entry both composed wrappers' `subs` list. |
| `DeadlinesSub` | Type | The running `"deadline"` Sub: its `deps` is the non-empty list of deadlines to arm. |
| `deadlineSub` | Function | Re-export the deadline primitives so consumers (and tests) wire one import: `subscribeDeadline` is the `deadline` runner, `deadlinesSub` a machine's `subs` entry, and `deadlineSub` builds the entry both composed wrappers' `subs` list. |
| `DeadlineSub` | Type | One deadline, as a battery lists it. |
| `debounce` | Function | Wrap `fn` so a BURST of calls collapses to a single invocation. |
| `Debounced` | Interface | A debounced wrapper around `fn`. |
| `DeliveryId` | Type | Monotonic, gap-free delivery id — the single correlation + dedup key. |
| `EffectConfirmed` | Interface | An owed effect has been CONFIRMED delivered. |
| `EffectLedgerEvent` | Type | The event union the ledger folds over. |
| `EffectOwed` | Interface | An effect is now OWED: it has been decided but its delivery is not yet confirmed. |
| `emptyLedger` | Function | The empty ledger — the fold's starting value (a fresh actor owes nothing). |
| `EndedRun` | Type | The ENDED phases — a run that finished (`done`) or was stopped from outside (`cancelled`). |
| `EnqueueInput` | Type | Caller-facing enqueue payload. |
| `FailedCompensatedWorkflow` | Interface | A workflow that failed forward and then fully unwound: every completed step's compensation confirmed, in reverse order. |
| `FailedWorkflow` | Interface | A workflow that failed on an activity with NOTHING to compensate — the forward failure happened with zero completed steps (the first activity failed). |
| `FanOutConfig` | Interface | The knob. |
| `FanOutDone` | Interface | One settled-OK item: the original `input` and the `result` its effect produced. |
| `FanOutFailed` | Interface | One settled-error item: the original `input` and the `error` its effect surfaced. |
| `FanOutPorts` | Interface | Optional Port for observing batch completion out-of-band. |
| `FanOutState` | Interface | The slice this knob owns — four partitions over the work-queue item lifecycle, plus the work-queue records the verbs thread the lifecycle through. |
| `foldWorkflow` | Function | Replay a workflow from its event log: seed over `steps`, then fold each activity-result `Msg` in order. |
| `InFlightActivity` | Interface | The activity currently in flight on a `running` workflow. |
| `InFlightCompensation` | Interface | The compensation currently in flight on a `compensating` workflow (#125). |
| `initBatchWindow` | Function | The starting slice: closed window, empty buffer. |
| `initFanOut` | Function | The starting slice: nothing scattered yet. |
| `initSaga` | Function | The starting slice: idle, nothing run, winding-forward direction. |
| `isAborted` | Function | Whether the saga has terminated in failure, fully unwound (every completed step undone). |
| `isCommitted` | Function | Whether the saga has terminated successfully (every step committed). |
| `isCompensationFailed` | Function | Whether the saga has terminated in failure with an UNFINISHED rollback: an `undo` itself failed, so some completed steps were never compensated and need hand reconciliation. |
| `isComplete` | Function | Whether every scattered item has settled (no `pending`, no `running`). |
| `isSettled` | Function | Whether the saga has reached a terminal phase (success, fully-unwound failure, or compensation-failed). |
| `liftReconciler` | Function | Lift a knob result `[slice, cmds]` into a host `[State, cmds]` where the slice lives at `state.rec`. |
| `liftRun` | Function | Lift a knob result `[slice, cmds]` into a host `[State, cmds]` where the slice lives at `state.run`. |
| `MonitoredRunCmd` | Type | The checkpoint-write Cmd, generic over the consumer's checkpoint value `V`. |
| `MonitoredRunConfig` | Interface | The monitored-run knob. |
| `MonitoredRunPorts` | Interface | Ports the consumer supplies to `handlers` — just the checkpoint store. |
| `MonitoredRunState` | Type | The slice — a discriminated union on `phase` so each phase carries ONLY its own data and impossible combinations are unrepresentable (pattern 11), the same idiom the sibling `CircuitState` / `PaginatorState` / `RunFailure` follow: - `idle` — created but never started. |
| `MonitoredRunTimerMsg` | Type | The deadline Msg the safety alarm dispatches when the watchdog fires. |
| `onWindow` | Function | Flush the open window because its time bound was reached. |
| `Poller` | Interface | The knob handle returned by `createPoller`. |
| `PollerConfig` | Interface | The poller knob's config — the single object you hand `createPoller`. |
| `PollerDone` | Type |  |
| `PollerGaveUp` | Type |  |
| `PollerPolling` | Type | The three arms, named — so a verb can DECLARE the phases it can actually reach instead of the whole union. |
| `PollerState` | Type | The Model field the poller knob owns — its visible slice (the knob principle: managed state lives in the Model, never a closure, so it is durable and replayable). |
| `PollerSub` | Type | The deadline the poller lists — a `../deadline` entry under the `poller:tick:` id family (see `pollerSubId`). |
| `ReconcilePhase` | Type | Reconcile lifecycle phase. |
| `ReconcilerConfig` | Interface | The reconciler knob. |
| `ReconcilerPorts` | Interface | Ports the consumer supplies to `handlers`. |
| `ReconcilerState` | Interface | The slice. |
| `ReconcilerTimerMsg` | Type | The scan retry / deadline timer Msg — inherited from paginated-walk. |
| `routeWorkflowMsg` | Function |  |
| `RunFailure` | Type | Why a run terminated as `failed`. |
| `RunningWorkflow` | Interface | A workflow in progress. |
| `runToTerminal` | Function | Fire-and-await convenience: `run()` the machine, dispatch the seed `msgs`, and resolve with the terminal state — then tear the runtime down (`runtime.stop()`) on BOTH the resolve and reject paths. |
| `SagaConfig` | Interface | The knob. |
| `SagaPhase` | Type | The lifecycle phase of a saga, narrowed at the type level so a consumer can branch on `state.phase` (and a Transitions-table reducer can key on it). |
| `SagaState` | Interface | The slice this knob owns. |
| `SagaStep` | Interface | One step of the saga: the forward effect and its compensating inverse, both as data (plain Cmds). |
| `ScanPageCmd` | Type | The actual-list page-fetch effect: the inherited `resilient_run` Cmd from paginated-walk, whose `input` is the `Cursor` to fetch and whose `key` is the fixed `PAGE_KEY`. |
| `ScanPageErrMsg` | Type |  |
| `ScanPageOkMsg` | Type | Page-settled Msgs the scan `handlers` port dispatches back (inherited verbatim). |
| `SnapshotSavedMsg` | Type | The Msg the write handler dispatches on a SUCCESSFUL `put`. |
| `SnapshotWriteCmd` | Type |  |
| `StageResult` | Type | The outcome a consumer reports to `advance`: the current stage either succeeded (retire it, claim the next) or failed (terminate the run). |
| `StepId` | Type | A step's stable identity. |
| `subscribeBatchWindow` | Variable | The `deadline` runner for a batch window's timer — the exact `../deadline` runner. |
| `subscribeDeadline` | Variable | The `deadline` runner for the DEFAULT `setTimeout` backing. |
| `subsFor` | Function | The window timer deadline, derived from the slice. |
| `TerminalTimeoutError` | Class | Raised when `awaitTerminal` / `runToTerminal` is wired with a `timeoutMs` and the deadline elapses before any terminal state is reached. |
| `Workflow` | Interface | The hook bag returned by createWorkflow. |
| `WORKFLOW_MSG_TYPES` | Variable | The runtime accept-set of every WorkflowMsgType — the single source of truth the boundary replay parse keys off (see `do.ts`). |
| `WORKFLOW_STATUSES` | Variable | The runtime accept-set of every WorkflowStatus — the single source of truth the boundary snapshot parse keys off (see `do.ts`). |
| `workflowActivityDef` | Function | Dispatch the in-flight activity. |
| `WorkflowCmd` | Type | The Cmd union this module emits: forward activity dispatches AND (#125) reverse compensation dispatches. |
| `workflowCompensationDef` | Function | Dispatch a compensation (#125). |
| `WorkflowMsg` | Type | The Msg union the reducer folds: forward activity results AND (#125) reverse compensation results. |
| `WorkflowMsgType` | Type | Every `type` discriminant tag of the WorkflowMsg union. |
| `WorkflowReducerStep` | Interface | A workflow reducer step: the next state, the ledger events to persist (owed-before-dispatch), and the activity Cmds to dispatch. |
| `WorkflowState` | Type | The workflow's state — a discriminated union on `status`. |
| `WorkflowStatus` | Type | Every `status` discriminant of the WorkflowState union. |
| `WorkflowStep` | Interface | One step of a workflow: a named activity descriptor. |
| `WorkflowSteps` | Type | A workflow's step sequence at construction — a NON-EMPTY tuple. |
