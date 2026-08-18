// PROBE 63: the terminals hoisted to a variable, without `as const`.
//
// Hoisting is what every author does the second a lane is built by a helper,
// and it silently widens `complete`/`tripped` to `string`. Nothing complained:
// `LaneTerminal<L>` became the bare `string`, so a lane's ending stopped being
// one of two names, and `__terminalCollidesWithAPhase` — which is an
// intersection of the terminals with the phase names — went `never` and stopped
// checking. The lane looked fine and had lost its endings.
//
// The marker says what actually happened ("this object lost its literal types")
// instead of accusing the author of a different mistake, because "add `as
// const`" is the fix and no amount of staring at the terminals reveals it.
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

const terminals = { complete: "complete", tripped: "tripped" };

export const epic = defineLane({
  phases: { phase1: { issue_1: build } },
  terminals,
});
