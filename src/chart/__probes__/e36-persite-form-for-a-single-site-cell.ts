// PROBE 36: the per-site form offered where it is not needed. `retryNow` is
// reached from ONE edge, so the function form is already exact in both
// directions and the second form is deliberately not offered — the common case
// keeps exactly one shape to learn, and the bag stays a function.
import type { Cells } from "../graph";
import {
  cells,
  type FG,
  type FMsg,
  type FState,
} from "../resilient-fetch-chart";
export const bad: Cells<FG, FState, FMsg> = {
  ...cells,
  retryNow: {
    "waiting_retry.deadline_exceeded": (s) => [{ ...s, type: "fetching" }, []],
  },
};
