/**
 * @packageDocumentation
 * @demlik/tea/pbt — Property-based testing primitives for `@demlik/tea` machines.
 *
 * The sibling-package shape to `@demlik/tea/testing`. Where the testing subpath
 * ships example-based assertions over `replay`, this package ships
 * arbitrary-driven fold-and-check primitives over the same pure substrate:
 *
 *   - `arbMsg` / `arbMsgSequence` — build `fc.Arbitrary<M>` and `Arbitrary<M[]>`
 *     from a strict, mapped-type Msg-variant table.
 *   - `propertyTerminates` / `propertyInvariant` / `propertyTrace` — wrap
 *     `fc.assert(fc.property(...))` with a TEA-shaped fold over Msg sequences.
 *   - `stubCtxThrowingProxy<Ctx>()` — type-shaped Ctx value whose every access
 *     throws (PBT runs the reducer; Ctx must never be touched).
 *
 * Resolves the decoupling target: PBT
 * lives as a sibling package, never inside the substrate.
 *
 * Substrate dependency: types only (`Machine`, `Cmd`, `Sub`, `replay`). The
 * pure reducer surface is the only thing PBT exercises; `interpret` and
 * subscription handlers are never invoked.
 */

export {
  arbConstantMsg,
  arbGuidedSequence,
  arbMsg,
  arbMsgSequence,
  arbRecordMsg,
  type MsgArbitraryTable,
  stubCtxThrowingProxy,
} from "./arbitraries";
export {
  foldEvents,
  propertyInvariant,
  propertyTerminates,
  propertyTrace,
  type Step,
} from "./runners";
export { msgTypeKeys } from "./util/msg-keys";
