// PROBE 50: a lane region whose chart hands a transition to a cell.
//
// `{ to, cell }` is the chart's escape hatch: the author declares the reachable
// SET and hand-written code picks one at runtime. A lane region has no such
// runtime — nothing in `chart/lane` runs a cell, and the lowered representation
// the fold reads holds ONE declared target per edge — so a region with a cell
// edge is a lane whose topology cannot be drawn and whose log cannot be
// replayed. Caught by the shape, naming the task, rather than by a fold that
// throws on the first `PICK` in production.
// @expect-error: TS2345
import { defineChart } from "../graph";
import { defineLane } from "../lane/structure";

const picky = defineChart({
  events: { GO: { scope: "edges" }, DONE: { scope: "edges" } },
  states: {
    only: {
      queued: { initial: true, on: { GO: { to: ["build"], cell: "pick" } } },
      build: { on: { DONE: "shipped" } },
      shipped: { end: true },
    },
  },
});

export const epic = defineLane({
  phases: { phase1: { issue_1: picky } },
  terminals: { complete: "complete", tripped: "tripped" },
});
