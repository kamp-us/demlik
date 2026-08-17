// PROBE 32: `initial` naming a state the chart never declared. The entry is a
// REFERENCE into `states`, exactly as an edge target is, so a typo is caught
// the same way — with tsc's "Did you mean …?" against the real names.
// @expect-error: TS2322
import { defineReducerChart, ty } from "../graph";
export const bad = defineReducerChart({
  ctx: ty<{ readonly n: number }>(),
  states: ["idle", "busy"],
  initial: "idel",
  events: { X: {} },
  on: { X: "busy" },
});
