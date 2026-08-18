// PROBE 54: a lane message carrying an event THAT task's chart never declares.
//
// This is the narrowing a union across the lane's charts would lose. `LaneMsg`
// is built per task, so the event alphabet is the one that task's own chart
// declares — which is what makes a lane of two different templates safe:
// sending the reviewer's event to the builder is exactly as wrong as sending an
// event nothing declares, and it fails the same way.
// @expect-error: TS2322
import { defineChart } from "../graph";
import { defineLane, type LaneMsg } from "../lane/structure";

const build = defineChart({
  events: { GO: { scope: "edges" }, DONE: { scope: "edges" } },
  states: {
    only: {
      queued: { initial: true, on: { GO: "working" } },
      working: { on: { DONE: "shipped" } },
      shipped: { end: true },
    },
  },
});

const review = defineChart({
  events: { PASS: { scope: "edges" }, FAIL: { scope: "edges" } },
  states: {
    only: {
      waiting: { initial: true, on: { PASS: "approved", FAIL: "rejected" } },
      approved: { end: true },
      rejected: { end: "error" },
    },
  },
});

export const epic = defineLane({
  phases: { phase1: { issue_1: build, issue_2: review } },
  terminals: { complete: "complete", tripped: "tripped" },
});

// `PASS` is real — for `issue_2`. `issue_1` has never heard of it.
export const msg: LaneMsg<typeof epic> = { task: "issue_1", event: "PASS" };
