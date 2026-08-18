// PROBE 59: a hand written for a task the lane does not declare.
//
// Silently ignored otherwise — the parts and the boot state authored for
// `issue_9` are simply never reached, and the lane runs the regions it does
// have while its author believes there is one more. The typo class is the same
// one `__retryBudgetNamesAnUnknownTask` catches on the spec; this is its half
// on the code.
// @expect-error: TS2345
import { defineChart } from "../graph";
import { runLane } from "../lane/run";
import { defineLane } from "../lane/structure";

const build = defineChart({
  events: { GO: { scope: "edges" } },
  states: {
    only: {
      queued: { initial: true, on: { GO: "shipped" } },
      shipped: { end: true },
    },
  },
});

const epic = defineLane({
  phases: { phase1: { issue_1: build } },
  terminals: { complete: "complete", tripped: "tripped" },
});

const hands = {
  issue_1: {
    parts: { assign: { "queued.GO": () => ({}) } },
    boot: () => ({ type: "queued" }) as const,
  },
  issue_9: {
    parts: { assign: { "queued.GO": () => ({}) } },
    boot: () => ({ type: "queued" }) as const,
  },
};

export const rt = runLane(epic, hands);
