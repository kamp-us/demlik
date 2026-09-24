/**
 * @packageDocumentation
 * @demlik/tea/testing/effect — `drive` for the Effect engine: a machine run
 * against its real Effect `interpret` handlers and its Subs, round by round,
 * until it goes quiet, yielding `{ state, trace }`. The services the handlers
 * read come from the caller's Layers.
 *
 * The rounds, trace and failures are the Promise `drive`'s
 * (`@demlik/tea/testing/promise`); the engine-neutral helpers stay at
 * `@demlik/tea/testing`. `effect` is an optional peer dependency, and this is
 * the one entry outside `@demlik/tea/effect` that imports it.
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
export {
  drive,
  type EffectDriveError,
  type EffectDriveOptions,
} from "./drive";
