# @demlik/tea/workflow

> the durable-workflow runtime core (#124, the first Phase-1 slice of the Temporal-style durable-workflow engine, epic #118).

```ts
import { … } from "@demlik/tea/workflow";
```

## Exports (32)

| Symbol | Kind | Summary |
| --- | --- | --- |
| `ActivityCmd` | Interface | Dispatch the in-flight activity. |
| `ActivityErr` | Interface | An activity failed (retries already exhausted by the consumer's interpret cell — this module does not retry). |
| `ActivityOk` | Interface | An activity succeeded: `id` echoes the ActivityCmd it answers; the reducer matches it against `current.id`, records the completed step, and advances. |
| `CompensatingWorkflow` | Interface | A workflow unwinding after a forward failure (#125): the compensations of the `completed` steps are being emitted in STRICT REVERSE order, one at a time, on the same #67 ledger. |
| `CompensationCmd` | Interface | Dispatch a compensation (#125). |
| `CompensationErr` | Interface | A compensation itself failed (#125): the inverse activity bounced (a refund that won't go through). |
| `CompensationFailedWorkflow` | Interface | A workflow whose ROLLBACK itself failed: a compensation activity reported a failure mid-unwind. |
| `CompensationOk` | Interface | A compensation succeeded (#125): the inverse activity took. |
| `CompletedStep` | Interface | A completed step: the step that ran plus the result its activity produced. |
| `CompletedWorkflow` | Interface | A workflow that ran every step to completion. |
| `createWorkflow` | Function |  |
| `DeliveryId` | Reference |  |
| `EffectConfirmed` | Reference |  |
| `EffectLedgerEvent` | Reference |  |
| `EffectOwed` | Reference |  |
| `emptyLedger` | Reference |  |
| `FailedCompensatedWorkflow` | Interface | A workflow that failed forward and then fully unwound: every completed step's compensation confirmed, in reverse order. |
| `FailedWorkflow` | Interface | A workflow that failed on an activity with NOTHING to compensate — the forward failure happened with zero completed steps (the first activity failed). |
| `foldWorkflow` | Function |  |
| `InFlightActivity` | Interface | The activity currently in flight on a `running` workflow. |
| `InFlightCompensation` | Interface | The compensation currently in flight on a `compensating` workflow (#125). |
| `RunningWorkflow` | Interface | A workflow in progress. |
| `Workflow` | Interface | The hook bag returned by createWorkflow. |
| `WORKFLOW_MSG_TYPES` | Variable | The runtime accept-set of every WorkflowMsgType — the single source of truth the boundary replay parse keys off (see `do.ts`). |
| `WORKFLOW_STATUSES` | Variable | The runtime accept-set of every WorkflowStatus — the single source of truth the boundary snapshot parse keys off (see `do.ts`). |
| `WorkflowCmd` | Type | The Cmd union this module emits: forward activity dispatches AND (#125) reverse compensation dispatches. |
| `WorkflowMsg` | Type | The Msg union the reducer folds: forward activity results AND (#125) reverse compensation results. |
| `WorkflowMsgType` | Type | Every `type` discriminant tag of the WorkflowMsg union. |
| `WorkflowReducerStep` | Interface | A workflow reducer step: the next state, the ledger events to persist (owed-before-dispatch), and the activity Cmds to dispatch. |
| `WorkflowState` | Type | The workflow's state — a discriminated union on `status`. |
| `WorkflowStatus` | Type | Every `status` discriminant of the WorkflowState union. |
| `WorkflowStep` | Interface | One step of a workflow: a named activity descriptor. |
