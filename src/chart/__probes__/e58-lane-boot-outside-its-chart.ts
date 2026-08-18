// PROBE 58: an instance booted into a state its OWN chart never declares.
//
// The mistake per-instance boot introduces, and the reason the boot state is
// typed rather than taken as a string. An emitted epic boots each child where
// its sub-issue actually is — `queued`, `landed`, `frozen` — so the entry state
// is DATA; data naming a state the chart does not have is a region no edge can
// ever leave, in a phase that can therefore never complete.
//
// The lane holds two DIFFERENT templates on purpose: `landed` is a real state,
// for `issue_2`. Booting `issue_1` into it is exactly as wrong as booting it
// into a name nothing declares, and the diagnostic names `issue_1`.
// The hands are HOISTED rather than written inline at the call, and that is
// the shape a real lane has (parts are shared, boots are per instance). It is
// also what puts the MARKER in the diagnostic — checked as a whole value, the
// intersection reports `__laneTaskBootsIntoAStateItsChartDoesNotDeclare:
// "issue_1"`. Written inline, tsc elaborates into the offending property and
// reports the state union at `issue_1`'s own boot instead; both name the task,
// one by name and one by location.
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

const deploy = defineChart({
  events: { ROLL: { scope: "edges" } },
  states: {
    only: {
      landed: { initial: true, on: { ROLL: "live" } },
      live: { end: true },
    },
  },
});

const epic = defineLane({
  phases: { phase1: { issue_1: build, issue_2: deploy } },
  terminals: { complete: "complete", tripped: "tripped" },
});

const hands = {
  issue_1: {
    parts: { assign: { "queued.GO": () => ({}) } },
    boot: () => ({ type: "landed" }) as const,
  },
  issue_2: {
    parts: { assign: { "landed.ROLL": () => ({}) } },
    boot: () => ({ type: "landed" }) as const,
  },
};

export const rt = runLane(epic, hands);
