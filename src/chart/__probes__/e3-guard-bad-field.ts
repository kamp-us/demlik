// PROBE 3: a guard body reading a field that does not exist on its NARROWED msg.
// `retriesRemaining` is referenced only at `review.FAIL`, so `m` is the FAIL msg
// ({ at, reason }) and `s` is the `review` state ({ retries, maxRetries }).
import type { Guards } from "../graph";
import type { LaneG, LaneMsg, LaneState } from "../lane";
export const guards: Guards<LaneG, LaneState, LaneMsg> = {
  retriesRemaining: (s, m) => s.retries < s.maxRetries && m.approvedBy !== "",
};
