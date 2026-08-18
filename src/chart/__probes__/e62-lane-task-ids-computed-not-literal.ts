// PROBE 62: a phase whose task keys are computed, so the lane's alphabet stops
// being a union of literals.
//
// `graph.ts` refuses this one level down and the lane had no equivalent. The
// damage is the same: `LaneTaskId<L>` degenerates from a union of literals to
// `string`, so `LaneHands<L>` demands NO hand, an invented task id is accepted
// and `__laneHandNamesAnUnknownTask` is dead code. The chart was not weakened,
// the lane was switched OFF, and nothing said so.
//
// It also used to fail for the WRONG REASON. With two phases, `Omit<P, K>` over
// a record with an index signature is that record again, so every task read as
// declared twice and the author was told `__taskDeclaredInTwoPhases` about a
// task they had declared exactly once. The literal gate is ordered ahead of the
// duplicate check so the accusation is true.
// @expect-error: TS2345
import { defineChart } from "../graph";
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

const id = "issue_1" as string;

export const epic = defineLane({
  phases: { phase1: { [id]: build }, phase2: { issue_2: build } },
  terminals: { complete: "complete", tripped: "tripped" },
});
