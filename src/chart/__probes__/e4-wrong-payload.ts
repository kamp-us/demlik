// PROBE 4: an `assign` returning the wrong payload shape for its target state.
import type { Assigns } from "../graph";
import type { LaneG, LaneMsg, LaneState } from "../lane";
type A = Assigns<LaneG, LaneState, LaneMsg>;
export const queuedWip: A["queued.WIP"] = (s) => ({
  retries: s.retries,
  maxRetries: "two", // ← target `build` wants number
});
