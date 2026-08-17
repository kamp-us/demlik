// PROBE 31: the `to` clamp, unchanged by dropping the phase dimension. `onErr`
// declares `to: ["failed", "waiting_retry"]`, so returning `circuit_open` — a
// real state of this machine, just not one this edge admits — is rejected.
import type { RCells } from "../graph";
import {
  type RFG,
  type RFMsg,
  type RFState,
  cells,
} from "../resilient-fetch-reducer";
export const bad: RCells<RFG, RFState, RFMsg> = {
  ...cells,
  onErr: (s) => [{ ...s, type: "circuit_open" }, []],
};
