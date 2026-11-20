// Type-level test for `stepHost`'s optional `beforeResume` admission hook.
// Compiled by `pnpm typecheck` (tsc over `src/**` INCLUDES `*.test-d.ts`). Every
// `@ts-expect-error` MUST sit on a line that genuinely fails to type-check; every
// undirected line is a positive case that must compile.
//
// The contract: the hook is additive. An engine written before it compiles
// unchanged, the inline response keeps its two arms, only a deferred host can
// answer with the not-ready arm, and the hook can answer with the terminal arm
// and nothing else.

import {
  type DeferredStepOutcome,
  type DeferredStepResponse,
  type NextStep,
  type StepEngine,
  type StepOutcome,
  type StepRequest,
  type StepResponse,
  type StepWorking,
  stepHost,
} from "./step-host";

type Result = string;
type Input = { readonly arg: string };
type Output = string;

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
const same = <A, B>(_proof: Equal<A, B>) => {};

const ctx = { storage: { setAlarm() {} } };
declare const request: StepRequest<Result>;

// An engine written before the hook existed compiles unchanged.
const before: StepEngine<Result, Input, Output> = {
  tokenFor: () => "token",
  resume: () => {},
  nextStep: (): NextStep<Input> | null => null,
  terminalOutput: () => "output",
};
stepHost(ctx, before);

// The hook answers null, the terminal arm, or either one asynchronously.
const nullHook: StepEngine<Result, Input, Output> = {
  ...before,
  beforeResume: () => null,
};
const terminalHook: StepEngine<Result, Input, Output> = {
  ...before,
  beforeResume: () => ({ done: true, output: "stopped" }),
};
const asyncHook: StepEngine<Result, Input, Output> = {
  ...before,
  beforeResume: async (runId) =>
    runId === "stopped" ? { done: true, output: "stopped" } : null,
};
stepHost(ctx, nullHook);
stepHost(ctx, terminalHook);
stepHost(ctx, asyncHook);

// It cannot answer with the step arm, the not-ready arm, or a bare error.
const stepArm: StepEngine<Result, Input, Output> = {
  ...before,
  // @ts-expect-error a step is not an admission answer
  beforeResume: () => ({
    done: false,
    step: { callId: "c", tool: "t", input: { arg: "a" } },
  }),
};
const workingArm: StepEngine<Result, Input, Output> = {
  ...before,
  // @ts-expect-error the not-ready arm is not an admission answer
  beforeResume: () => ({ done: false, working: true }),
};
const wrongOutput: StepEngine<Result, Input, Output> = {
  ...before,
  // @ts-expect-error the output is the run's own output type
  beforeResume: () => ({ done: true, output: 42 }),
};
void [stepArm, workingArm, wrongOutput];

// The inline response keeps exactly its two arms, and the hook widens nothing.
same<
  StepResponse<Input, Output>,
  | { readonly done: false; readonly step: NextStep<Input> }
  | { readonly done: true; readonly output: Output }
>(true);
same<
  StepOutcome<Input, Output>["body"],
  StepResponse<Input, Output> | { readonly error: string }
>(true);

const inline = stepHost(ctx, terminalHook);
const inlineOutcome: Promise<StepOutcome<Input, Output>> = inline.handle(
  request,
  0,
);
void inlineOutcome;

// A deferred caller keeps the not-ready arm; an inline caller never sees it.
const deferred = stepHost(ctx, terminalHook, {
  deferResume: { settled: () => false, enqueue: () => {} },
});
const deferredOutcome: Promise<DeferredStepOutcome<Input, Output>> =
  deferred.handle(request, 0);
void deferredOutcome;
same<
  DeferredStepResponse<Input, Output>,
  StepResponse<Input, Output> | StepWorking
>(true);

async function narrow(): Promise<void> {
  const outcome = await inline.handle(request, 0);
  if (outcome.status !== 200) return;
  if (outcome.body.done) {
    const output: Output = outcome.body.output;
    void output;
  } else {
    const step: NextStep<Input> = outcome.body.step;
    void step;
  }
}
void narrow;
