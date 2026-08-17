// PROBE 2: a declared edge with no `assign` entry.
// @expect-error: TS2741

import type { LaneG, LaneMsg, LaneState } from "../__fixtures__/lane";
import type { Assigns } from "../graph";
export const assign: Assigns<LaneG, LaneState, LaneMsg> = {
  "queued.WIP": (s) => ({ retries: s.retries, maxRetries: s.maxRetries }),
  "queued.BLOCKED": (s) => ({ retries: s.retries, maxRetries: s.maxRetries }),
  "build.DONE": (s) => ({ retries: s.retries, maxRetries: s.maxRetries }),
  "build.BLOCKED": (s) => ({ retries: s.retries, maxRetries: s.maxRetries }),
  "review.PASS": (s) => ({ retries: s.retries, maxRetries: s.maxRetries }),
  "review.BLOCKED": (s) => ({ retries: s.retries, maxRetries: s.maxRetries }),
  "review.FAIL": {
    // biome-ignore lint/suspicious/noThenProperty: the chart's guarded-assign shape is `{ then, else }` — the two arms of one edge's guard, never a thenable
    then: (s) => ({ retries: s.retries + 1, maxRetries: s.maxRetries }),
    else: (s) => ({ retries: s.retries, maxRetries: s.maxRetries }),
  },
  "ship.DONE": (s) => ({ retries: s.retries, maxRetries: s.maxRetries }),
  // ← "ship.BLOCKED" deliberately omitted
  "blocked.UNBLOCKED": (s) => ({
    retries: s.retries,
    maxRetries: s.maxRetries,
  }),
  "human:cp-approval.UNBLOCKED": (s) => ({
    retries: s.retries,
    maxRetries: s.maxRetries,
  }),
};
