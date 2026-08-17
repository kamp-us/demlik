// PROBE 36: the per-site form offered where it is not needed. `retryNow` is
// reached from ONE edge, so the function form is already exact in both
// directions and the second form is deliberately not offered — the common case
// keeps exactly one shape to learn, and the bag stays a function.
// @expect-error: TS2353 TS7006

import {
  cells,
  type FG,
  type FMsg,
  type FState,
} from "../__fixtures__/resilient-fetch-chart";
import type { Cells } from "../graph";
export const bad: Cells<FG, FState, FMsg> = {
  ...cells,
  retryNow: {
    "waiting_retry.deadline_exceeded": (s) => [{ ...s, type: "fetching" }, []],
  },
};
