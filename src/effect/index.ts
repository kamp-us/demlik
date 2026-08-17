/**
 * @packageDocumentation
 * `@demlik/tea/effect` — the two-way bridge between `@demlik/tea` and Effect.
 *
 * Direction 1 (Effect → tea): author interpret handlers as `Effect`s with a
 * Layer-provided service environment, and lower them into tea's
 * `Interpret<M, C, Ctx>` with `toInterpret` / `effectCell`. tea keeps owning
 * the serial Cmd loop; Effect owns dependency injection inside a handler.
 *
 * Direction 2 (tea → Effect): host a running tea machine as a scoped Effect
 * resource with `make` / `layer` / `runToTerminal`, so an Effect app can boot,
 * drive, observe, and tear down a machine without touching promises.
 *
 * `effect` is an OPTIONAL peer dependency. Nothing in the tea core imports it —
 * only this subpath does.
 */

export type {
  TeaCtxId,
  TeaDispatchId,
  TeaDispatchShape,
  TeaEnv,
  TeaServices,
} from "./services";
export { teaServices } from "./services";
export type {
  TeaDefect,
  TeaMachine,
  TeaMakeOptions,
  TeaRunOptions,
} from "./tea-machine";
export {
  layer,
  make,
  runToTerminal,
  TeaBootError,
  TeaDispatchError,
  TeaQuiescenceError,
} from "./tea-machine";
export type {
  EffectHandler,
  EffectHandlers,
  EffectRunner,
  LoweringOptions,
} from "./to-interpret";
export { effectCell, toInterpret } from "./to-interpret";
