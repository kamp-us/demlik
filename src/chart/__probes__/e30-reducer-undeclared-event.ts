// PROBE 30: an `on` key naming an event that was never declared. Constraint
// checking is plain assignability, so without `StrictR` this would silently
// invent an edge for a msg that can never arrive.
// @expect-error: TS2322
import { defineReducerChart, ty } from "../graph";
export const bad = defineReducerChart({
  ctx: ty<{ readonly n: number }>(),
  states: ["a", "b"],
  initial: "a",
  events: { X: {} },
  on: { X: "b", Z: "a" },
});
