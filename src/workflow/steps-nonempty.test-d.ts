// Type-level test for the non-empty `WorkflowSteps` construction invariant.
// Compiled by `pnpm typecheck` (tsc over `src/**`, which INCLUDES `*.test-d.ts`;
// `*.test.ts` is excluded by tsconfig). Each `@ts-expect-error` MUST sit on a
// line that genuinely fails to type-check — if the non-empty encoding regresses
// and the line stops erroring, the directive becomes "unused" and `tsc` fails
// the whole package. Every line without a directive is a positive case that
// must compile.
//
// The contract (parse-don't-validate): a workflow must have ≥ 1 step, because a
// workflow with nothing to do can never reach `completed` (no final result to
// carry). `init` / `foldWorkflow` take a NON-EMPTY tuple `WorkflowSteps<A>`, so
// an empty sequence is a COMPILE error at the construction boundary — there is
// no runtime throw to reject it (the invariant is unrepresentable, not guarded).

import { createWorkflow, foldWorkflow, type WorkflowStep } from "./index";

type Activity = { readonly op: string };
const step: WorkflowStep<Activity> = { name: "s0", activity: { op: "go" } };

const wf = createWorkflow<Activity, string, string>();

// A single-step tuple compiles — one step is the minimum valid sequence.
export function initSingle() {
  return wf.init([step]);
}

// A multi-step tuple compiles.
export function initMany() {
  return wf.init([step, step, step]);
}

// An empty sequence is a COMPILE error — the non-empty tuple has no match for
// its required first element. This is the runtime throw the type replaced.
export function initEmpty() {
  // @ts-expect-error — `WorkflowSteps` requires at least one step
  return wf.init([]);
}

// `foldWorkflow` shares the same non-empty construction boundary.
export function foldEmpty() {
  // @ts-expect-error — `WorkflowSteps` requires at least one step
  return foldWorkflow<Activity, string, string>([], []);
}
