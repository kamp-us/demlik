// PROBE 52: a lane region whose chart declares no final, in either polarity.
//
// A phase completes when EVERY region in it reaches a final. A region that
// declares none never does, so the phase never completes, so the lane never
// advances past it — a lane that is drawable, foldable and permanently stuck,
// which is the worst of the three.
// @expect-error: TS2345
import { defineChart } from "../graph";
import { defineLane } from "../lane/structure";

const endless = defineChart({
  events: { GO: { scope: "edges" }, BACK: { scope: "edges" } },
  states: {
    only: {
      queued: { initial: true, on: { GO: "build" } },
      build: { on: { BACK: "queued" } },
    },
  },
});

export const epic = defineLane({
  phases: { phase1: { issue_1: endless } },
  terminals: { complete: "complete", tripped: "tripped" },
});
