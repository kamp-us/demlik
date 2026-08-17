// PROBE 28: `resume` on a REDUCER-form edge. `was` is derived from "the states
// with an edge INTO the parking state", and with no phase dimension every edge
// is reachable from every state — so the derivation degenerates to "all of
// them" and the fallback means nothing. Rejected by name rather than accepted
// and silently ignored by the walk.
import { defineReducerChart, ty } from "../graph";
export const bad = defineReducerChart({
  ctx: ty<{ readonly n: number }>(),
  states: ["a", "b"],
  initial: "a",
  events: { X: {} },
  on: { X: { resume: { fallback: "a" } } },
});
