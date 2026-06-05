// ---------------------------------------------------------------------------
// @demlik/tea/testing — test-side ergonomics over @demlik/tea's pure substrate.
//
// Three concerns share the subpath:
//
//   - Assertions   — `expectFinalState`, `expectCmdEmitted`,
//                    `expectCmdSequence`, `expectActiveSubs`, `step`
//                    (assertions.ts)
//   - Runtime hole — `noopRuntime` for ctx slots that demand a Runtime<...>
//                    reference replay never dereferences (noop-runtime.ts)
//   - State scaffolding — `stateFactory` for typed phase-constructor APIs
//                         over discriminated-union State (state-factory.ts)
//
// Subpath separation rationale: every helper here depends on `vitest`. The
// main `@demlik/tea` entry MUST stay vitest-free so production builds (service
// workers, durable objects, Next.js worker runtimes) never accidentally pull
// in test-only code. Promoting `vitest` to a peer dep on this package pins
// the requirement at the package boundary instead of hiding it in
// devDependencies.
//
// Strengthens invariant 9 (the testing surface is named and small).
// ---------------------------------------------------------------------------

export {
  type AssertWrapperFaithfulOpts,
  assertWrapperFaithful,
  type InterceptingOpt,
  type WrapperModel,
} from "./assert-wrapper-faithful";
export {
  expectActiveSubs,
  expectCmdEmitted,
  expectCmdSequence,
  expectFinalState,
  type ReplayOpts,
  step,
} from "./assertions";
export { type BoundMachine, bindMachine } from "./bind-machine";
export { noopRuntime } from "./noop-runtime";
export {
  type StateFactoryAPI,
  type StateFactoryDefaults,
  stateFactory,
} from "./state-factory";
