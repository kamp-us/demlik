// ---------------------------------------------------------------------------
// @demlik/tea/pbt/arbitraries — `fc.Arbitrary<...>` builders for Msg variants,
// Msg sequences, and Ctx stubs.
// ---------------------------------------------------------------------------

export { stubCtxThrowingProxy } from "./ctx";
export {
  arbConstantMsg,
  arbMsg,
  arbRecordMsg,
  type MsgArbitraryTable,
} from "./msg";
export { arbGuidedSequence, arbMsgSequence } from "./sequence";
