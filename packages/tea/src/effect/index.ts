/**
 * @packageDocumentation
 * @demlik/tea/effect — the Effect engine: `run` boots a machine with Effect
 * handlers and sub runners, the caller's Layers and interruption on stop, and
 * yields an Effect handle: the Promise engine's member names, with Effects
 * that fail with `Stopped`, `StoreFailed` or a cell's declared failure where
 * the Promise engine returns Promises.
 *
 * The machine you hand it is built from the neutral core at `@demlik/tea` —
 * the same file runs on `@demlik/tea/promise`. `effect` is an optional peer
 * dependency, and this entry is the only place in the package allowed to
 * import it.
 */

export { Stopped, StoreFailed } from "./failures";
export type { EffectBootingRuntime, EffectRuntime } from "./handle";
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
