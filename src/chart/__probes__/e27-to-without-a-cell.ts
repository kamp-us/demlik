// PROBE 27: `to` with no `cell` to pick from it. A fan-out nobody chooses among
// is not a transition; without the check it would satisfy the constraint
// structurally and compile into an edge the walk cannot execute.
import { defineChart } from "../graph";
export const g = defineChart({
  events: { GO: { scope: "edges" } },
  states: { only: { a: { on: { GO: { to: ["a", "b"] } } }, b: { end: true } } },
});
