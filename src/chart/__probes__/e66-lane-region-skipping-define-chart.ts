// PROBE 66: a lane region written as a bare object literal, never passed
// through `defineChart`.
//
// `LaneRegion` is the structural minimum BOTH doors satisfy — that is what lets
// one type parameter carry either a `defineChart` literal or an
// `ImportedChart` — and it was also a hole: a hand-written object of that shape
// passed it, so `Strict` and `Total` never ran. The target below is a typo
// (`shippd`), nothing checked it, `defineLane` accepted the lane, and the fold
// walked the task into a state that does not exist and left it there forever
// with no diagnostic at all.
//
// A brand stamped by `defineChart` would be the tighter fix and is not
// available from `lane/structure.ts`; putting the region through the checking
// door from here is the same guarantee by the other route — a chart that
// satisfies its own F-bounded constraint plus `Strict` and `Total` is a chart
// `defineChart` would have accepted, whatever produced it.
// @expect-error: TS2345
import { defineLane } from "../lane/structure";

const handWritten = {
  events: { GO: { scope: "edges" } },
  states: {
    only: {
      queued: { initial: true, on: { GO: "shippd" } },
      shipped: { end: true },
    },
  },
} as const;

export const epic = defineLane({
  phases: { phase1: { issue_1: handWritten } },
  terminals: { complete: "complete", tripped: "tripped" },
});
