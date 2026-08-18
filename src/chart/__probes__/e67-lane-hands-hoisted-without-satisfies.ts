// PROBE 67: the hands hoisted to a variable, without a `satisfies`.
//
// The spec side of this mistake is probe 63. This is the OTHER half, and it is
// the one an author hits first, because hoisting the hands is what assembling a
// lane from a helper looks like. Without the annotation, `boot()`'s return
// widens from `{ type: "queued" }` to `{ type: string }`.
//
// What used to happen then is the whole point of this probe: the boot check
// could no longer answer "is this a state of that chart", so it answered a
// different question and named `issue_1` as booting OUTSIDE its chart. Every
// boot state here is correct. The author was sent to look at the one thing that
// was right, and the actual fix — an annotation on a line the error never
// mentioned — is not reachable from that sentence.
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
} as const);

// `"queued"` IS a state of that chart. The only thing wrong here is the missing
// `satisfies LaneHands<typeof epic>`.
const hands = {
  issue_1: {
    parts: { assign: { "queued.GO": () => ({}) } },
    boot: () => ({ type: "queued" }),
  },
};

export const rt = runLane(epic, hands);
