// PROBE 54: a lane message addressed to a task the lane does not run.
//
// `LaneMsg` is derived from the spec's own nesting, so the address space IS the
// task set — no second list to keep in step, and a typo'd or stale region id is
// the compile error it should be rather than a message the router silently
// drops.
// @expect-error: TS2322
import { defineChart } from "../graph";
import { defineLane, type LaneMsg } from "../lane/structure";

const work = defineChart({
  events: { GO: { scope: "edges" }, DONE: { scope: "edges" } },
  states: {
    only: {
      queued: { initial: true, on: { GO: "build" } },
      build: { on: { DONE: "shipped" } },
      shipped: { end: true },
    },
  },
});

export const epic = defineLane({
  phases: { phase1: { issue_1: work } },
  terminals: { complete: "complete", tripped: "tripped" },
});

export const msg: LaneMsg<typeof epic> = { task: "issue_2", event: "GO" };
