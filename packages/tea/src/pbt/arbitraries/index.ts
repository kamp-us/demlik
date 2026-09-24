// ---------------------------------------------------------------------------
// `fc.Arbitrary<...>` builders for Msg variants, Msg sequences, and Ctx stubs —
// published on the `@demlik/tea/pbt` door, which re-exports this barrel.
// ---------------------------------------------------------------------------

export { stubCtxThrowingProxy } from "./ctx";
export {
  arbConstantMsg,
  arbMsg,
  arbRecordMsg,
  type MsgArbitraryTable,
} from "./msg";
export { arbGuidedSequence, arbMsgSequence } from "./sequence";
