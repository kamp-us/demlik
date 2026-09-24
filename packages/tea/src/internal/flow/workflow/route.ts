// ---------------------------------------------------------------------------
// routeWorkflowMsg — the ONE WorkflowMsg → verb routing table.
//
// Two call sites fold a `WorkflowMsg` into a workflow's next step: the pure
// replay `foldWorkflow` (a `switch`) and the durable grain's `defineMachine`
// update map in `do.ts` (one cell per Msg tag). Both encode the SAME mapping
// (`activity_ok` → `onActivityOk`, `activity_err` → `onActivityErr`,
// `compensation_ok` → `onCompensationOk`, `compensation_err` →
// `onCompensationErr`). Left duplicated, adding a fifth Msg variant meant
// editing the routing decision in two places. This dispatcher owns the table
// once; each call site delegates. The `switch` is exhaustive over the
// `WorkflowMsg` union, so a new variant is a compile error here until routed.
// ---------------------------------------------------------------------------

import type {
  Workflow,
  WorkflowMsg,
  WorkflowReducerStep,
  WorkflowState,
} from "./index";

export function routeWorkflowMsg<A, R, F>(
  wf: Workflow<A, R, F>,
  state: WorkflowState<A, R, F>,
  msg: WorkflowMsg<R, F>,
): WorkflowReducerStep<A, R, F> {
  switch (msg.type) {
    case "activity_ok":
      return wf.onActivityOk(state, msg);
    case "activity_err":
      return wf.onActivityErr(state, msg);
    case "compensation_ok":
      return wf.onCompensationOk(state, msg);
    case "compensation_err":
      return wf.onCompensationErr(state, msg);
  }
}
