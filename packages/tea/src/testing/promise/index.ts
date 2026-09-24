/**
 * @packageDocumentation
 * @demlik/tea/testing/promise — `drive` for the Promise engine: a machine run
 * against its real `interpret` handlers, round by round, until it goes quiet,
 * returning `{ state, trace }` so a test asserts on the sequence as well as
 * the endpoint.
 *
 * The engine-neutral helpers (`expectFinalState`, `step`,
 * `expectReplayDeterministic`, …) stay at `@demlik/tea/testing`; the Effect
 * engine's `drive` is at `@demlik/tea/testing/effect`. Nothing here imports
 * `effect`.
 */

export {
  DEFAULT_MAX_ROUNDS,
  type DriveCtxArg,
  DriveNoHandlerError,
  type DriveOptions,
  type DriveResult,
  DriveRoundsExceededError,
  type DriveTraceEntry,
  driveTraceOf,
} from "../drive-loop";
export { drive } from "./drive";
