// PROBE 33: an `assign` entry for a CELL event. The cell returns the whole
// next state, so a builder for it would be dead code the walk never calls.
// `RAssigns` is keyed by the DECLARATIVE events only, so writing it is an
// excess property and tsc names it.
import type { RAssigns } from "../graph";
import {
  type RFG,
  type RFMsg,
  type RFState,
  assign,
} from "../resilient-fetch-reducer";
export const bad: RAssigns<RFG, RFState, RFMsg> = {
  ...assign,
  fetch: (s) => s,
};
