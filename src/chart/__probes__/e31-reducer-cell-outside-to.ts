// PROBE 31: the `to` clamp, unchanged by dropping the phase dimension. `onErr`
// declares `to: ["failed", "waiting_retry"]`, so returning `circuit_open` — a
// real state of this machine, just not one this edge admits — is rejected.
// @expect-error: TS2322

import {
  cells,
  type RFG,
  type RFMsg,
  type RFState,
} from "../__fixtures__/resilient-fetch-reducer";
import type { RCells } from "../graph";
export const bad: RCells<RFG, RFState, RFMsg> = {
  ...cells,
  onErr: (s) => [{ ...s, type: "circuit_open" }, []],
};
