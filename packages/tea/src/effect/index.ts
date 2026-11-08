/**
 * @packageDocumentation
 * @demlik/tea/effect — the Effect engine: `run` boots a machine with Effect
 * handlers and sub runners, the caller's Layers and interruption on stop, and
 * yields an Effect handle: the Promise engine's member names, with Effects
 * that fail with `Stopped`, `StoreFailed` or a cell's declared failure where
 * the Promise engine returns Promises. `spawn`, `stop` and `tell` are for a
 * host that runs child machines under a parent: it keeps its own table of
 * children, and they run the steps that race.
 *
 * `Machine.make` builds a machine from required `model` and `msg` Effect
 * schemas and a required `cmds` list. Its readonly `model` and `msg` properties
 * expose the same schemas for explicit host validation of decoded values;
 * construction, boot and dispatch perform no automatic schema decoding.
 * The neutral core's `defineMachine` is
 * also accepted; either result runs on `@demlik/tea/promise`. `effect` is an
 * optional peer dependency, and this entry is the only place in the package
 * allowed to import it.
 */

export type { TellAnswer } from "../internal/engine/loop";
export { type SpawnSteps, spawn, stop, tell } from "./children";
export { type CheckingSchema, Cmd } from "./cmd";
export { Stopped, StoreFailed, SubFailed } from "./failures";
export type {
  EffectBootingRun,
  EffectBootingRuntime,
  EffectRun,
  EffectRuntime,
} from "./handle";
export { Machine } from "./machine";
export {
  type CellErrors,
  type EffectInterpret,
  type EffectInterpretCell,
  type EffectRunner,
  type EffectRunOptions,
  type EffectSubscribe,
  type InterpretServices,
  run,
  type SubscribeServices,
} from "./run";
export {
  type BridgedRun,
  type EffectHandlers,
  type EffectHandlerTables,
  runIn,
} from "./run-in";
