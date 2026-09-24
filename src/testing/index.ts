/**
 * @packageDocumentation
 * @demlik/tea/testing — test-side ergonomics over @demlik/tea's pure substrate.
 *
 * Four concerns share the subpath:
 *
 *   - Assertions — `expectFinalState`, `expectCmdEmitted`,
 *     `expectCmdSequence`, `expectActiveSubs`, `step` (assertions.ts), and
 *     `expectReplayDeterministic`, the clock/RNG replay check
 *     (expect-replay-deterministic.ts).
 *   - Driving — `drive`, the runtime's Cmd→handler→settle-Msg loop said once,
 *     returning `{ state, trace }` so a test asserts on the sequence as well
 *     as the endpoint (drive.ts).
 *   - Runtime hole — `noopRuntime` for ctx slots that demand a `Runtime<...>`
 *     reference replay never dereferences (noop-runtime.ts).
 *   - State scaffolding — `stateFactory` for typed phase-constructor APIs
 *     over discriminated-union State (state-factory.ts).
 *
 * Subpath separation rationale: every helper here depends on `vitest`. The
 * main `@demlik/tea` entry MUST stay vitest-free so production builds (service
 * workers, durable objects, Next.js worker runtimes) never accidentally pull
 * in test-only code. Promoting `vitest` to a peer dep on this package pins the
 * requirement at the package boundary instead of hiding it in devDependencies.
 *
 * Strengthens invariant 9 (the testing surface is named and small).
 */

export {
  expectActiveSubs,
  expectCmdEmitted,
  expectCmdSequence,
  expectFinalState,
  type ReplayOpts,
  step,
} from "./assertions";
export { type BoundMachine, bindMachine } from "./bind-machine";
export {
  DEFAULT_MAX_ROUNDS,
  type DriveCtxArg,
  DriveNoHandlerError,
  type DriveOptions,
  type DriveResult,
  DriveRoundsExceededError,
  type DriveTraceEntry,
  drive,
  driveTraceOf,
} from "./drive";
export { expectReplayDeterministic } from "./expect-replay-deterministic";
export { noopRuntime } from "./noop-runtime";
export {
  type StateFactoryAPI,
  type StateFactoryDefaults,
  stateFactory,
} from "./state-factory";
