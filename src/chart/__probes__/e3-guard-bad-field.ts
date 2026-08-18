// PROBE 3: a guard body reading a field that does not exist on its NARROWED msg.
// `retriesRemaining` is referenced only at `review.FAIL`, so `m` is the FAIL msg
// ({ at, reason }) and `s` is the `review` state ({ retries, maxRetries }).
// @expect-error: TS2339

import type { LaneG, LaneMsg, LaneState } from "../__fixtures__/lane";
import type { Guards } from "../graph";
export const guards: Guards<LaneG, LaneState, LaneMsg> = {
  retriesRemaining: (s, m) => s.retries < s.maxRetries && m.approvedBy !== "",
};
