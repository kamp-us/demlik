// PROBE 4: an `assign` returning the wrong payload shape for its target state.
// @expect-error: TS2322

import type { LaneG, LaneMsg, LaneState } from "../__fixtures__/lane";
import type { Assigns } from "../graph";

type A = Assigns<LaneG, LaneState, LaneMsg>;
export const queuedWip: A["queued.WIP"] = (s) => ({
  retries: s.retries,
  maxRetries: "two", // ← target `build` wants number
});
