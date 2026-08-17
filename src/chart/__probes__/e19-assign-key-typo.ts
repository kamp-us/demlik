// PROBE 19 (new): a typo'd `assign` key. `Assigns` is total over `EdgeKey<C>`,
// the DECLARED edges — so a key naming a pair with no edge is rejected and the
// real edge is reported missing.
import type { Assigns } from "../graph";
import type { LaneG, LaneMsg, LaneState } from "../lane";
declare const rest: Omit<Assigns<LaneG, LaneState, LaneMsg>, "review.PASS">;
export const assign: Assigns<LaneG, LaneState, LaneMsg> = {
  ...rest,
  "review.PSAS": (s) => ({ retries: s.retries, maxRetries: s.maxRetries }),
};
