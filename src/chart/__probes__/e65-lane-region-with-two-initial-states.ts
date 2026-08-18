// PROBE 65: a lane region marking TWO states `initial: true`.
//
// Zero was caught and two was not, and two is the worse of the pair because it
// does not fail — it SPLITS. `laneShape` walked the states and kept the LAST
// one it saw; `initialOf`, and therefore the fold, and therefore every report
// built on the fold, takes the FIRST. So the report printed a start state the
// run never booted into, and both halves were internally consistent.
//
// `graph.ts` refuses the same thing on a single chart with
// `__chartDeclaresManyInitialStates`. The lane door had dropped that net when a
// region's entry became per-instance (`boot()`), which is exactly when it stops
// being a fact the chart alone can be trusted to hold.
// @expect-error: TS2345
import { defineChart } from "../graph";
import { defineLane } from "../lane/structure";

const forked = defineChart({
  events: { GO: { scope: "edges" } },
  states: {
    only: {
      queued: { initial: true, on: { GO: "shipped" } },
      warming: { initial: true, on: { GO: "shipped" } },
      shipped: { end: true },
    },
  },
});

export const epic = defineLane({
  phases: { phase1: { issue_1: forked } },
  terminals: { complete: "complete", tripped: "tripped" },
});
