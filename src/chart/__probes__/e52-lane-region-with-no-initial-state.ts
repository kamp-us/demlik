// PROBE 52: a lane region whose chart marks no `initial: true`.
//
// The fold has no zero to start from, so `initialStates` cannot name where this
// task stands before its first event. `defineLane` has always refused this — at
// RUNTIME, because an `ImportedChart`'s states are `string` by construction and
// the question could not be asked in the type layer. It can be asked of a
// `defineChart` literal, so at the typed door it is asked, and the imported
// door keeps the throw.
// @expect-error: TS2345
import { defineChart } from "../graph";
import { defineLane } from "../lane/structure";

const noStart = defineChart({
  events: { GO: { scope: "edges" } },
  states: {
    only: {
      queued: { on: { GO: "shipped" } },
      shipped: { end: true },
    },
  },
});

export const epic = defineLane({
  phases: { phase1: { issue_1: noStart } },
  terminals: { complete: "complete", tripped: "tripped" },
});
