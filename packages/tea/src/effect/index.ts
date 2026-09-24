/**
 * @packageDocumentation
 * @demlik/tea/effect — the Effect engine: `run` boots a machine with Effect
 * handlers and sub runners, the caller's Layers and interruption on stop, and
 * yields the same run handle the Promise engine returns.
 *
 * The machine you hand it is built from the neutral core at `@demlik/tea` —
 * the same file runs on `@demlik/tea/promise`. `effect` is an optional peer
 * dependency, and this entry is the only place in the package allowed to
 * import it.
 */

export {
  type EffectInterpret,
  type EffectInterpretCell,
  type EffectRunner,
  type EffectRunOptions,
  type EffectSubscribe,
  type InterpretServices,
  run,
  type SubscribeServices,
} from "./run";
