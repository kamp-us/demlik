// PROBE 23: a CELL returning a state that is not in its edge's `to`.
// This is the bargain the escape hatch is built on: code may choose the
// target, but only from the set the chart declared. `onErr` is reached from a
// `to: ["failed", "waiting_retry"]` edge, so returning `circuit_open` — a real
// state of this machine, just not one this edge admits — is rejected, and the
// diagnostic names the offending literal.
// @expect-error: TS2322

import {
  cells,
  type FG,
  type FMsg,
  type FState,
} from "../__fixtures__/resilient-fetch-chart";
import type { Cells } from "../graph";
export const bad: Cells<FG, FState, FMsg> = {
  ...cells,
  onErr: (s) => [{ ...s, type: "circuit_open" }, []],
};
