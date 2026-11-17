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
 *   - `arbGuidedSequence` — draw Msg lists whose answers each fit a Cmd really
 *     sent, by folding blind picks through the machine.
 *   - `propertyTerminates` / `propertyInvariant` / `propertyTrace` — wrap
 *     `fc.check(fc.property(...))` with a TEA-shaped fold over Msg sequences,
 *     returning a `PropertyRun` and throwing a `PropertyFailure` that carries one.
 *   - `lawTerminates` / `lawInvariant` / `lawTrace` — the laws those runners
 *     judge each fold by, as plain check functions over one `foldEvents` result.
 *     They import no `fast-check`, so `@demlik/tea/testing/effect` exports them
 *     too, for Effect's `Arbitrary.checkEffect`. Experimental.
 *   - `stubCtxThrowingProxy<Ctx>()` — type-shaped Ctx value whose every access
 *     throws (PBT runs the reducer; Ctx must never be touched).
 *   - `journalConformance` — check a host-written journal driver against K1–K8
 *     through a fixture that owns interruption and storage controls. Experimental.
 *
 * Resolves the decoupling target: PBT
 * lives as a sibling package, never inside the substrate.
 *
 * Machine checks exercise the pure reducer surface; `interpret` and subscription
 * handlers are never invoked. Journal checks exercise the fixture's driver I/O.
 */

import * as JournalKit from "../internal/journal/conformance";

/** Check a journal driver against K1–K8 and return passed, failed or skipped cases.
 * @experimental
 */
export const journalConformance = JournalKit.journalConformance;
/** A fixture's fresh driver handles and physical interruption controls.
 * @experimental
 */
export type JournalKitFixture = JournalKit.JournalKitFixture;
/** Create isolated storage and controls for one conformance history.
 * @experimental
 */
export type JournalKitFactory = JournalKit.JournalKitFactory;
/** The outcome of one named journal conformance case, with diagnostic detail.
 * @experimental
 */
export type KitResult = JournalKit.KitResult;
/** The K1–K8 journal contract case identifiers.
 * @experimental
 */
export type KitCase = JournalKit.KitCase;
/** Scale, clock, generation and replay options for journal conformance.
 * @experimental
 */
export type KitOptions = JournalKit.KitOptions;

export {
  type AnswerCell,
  arbConstantMsg,
  arbGuidedSequence,
  arbMsg,
  arbMsgSequence,
  arbRecordMsg,
  type GuidedCells,
  type MsgArbitraryTable,
  stubCtxThrowingProxy,
} from "./arbitraries";
export { type LawBreak, lawInvariant, lawTerminates, lawTrace } from "./laws";
export {
  type Fold,
  foldEvents,
  type MsgCount,
  PropertyFailure,
  type PropertyOpts,
  type PropertyRun,
  propertyInvariant,
  propertyTerminates,
  propertyTrace,
  type Step,
} from "./runners";
export { msgTypeKeys } from "./util/msg-keys";
