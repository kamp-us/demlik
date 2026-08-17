// PROBE 40: probe 38's hole in the REDUCER form. `RCell` had the same
// asymmetry as `Cell` — the shape keyed off `{ target, otherwise }`, the walk
// (`buildCell`, shared by both forms) keyed off `when` — so the same one-word
// omission produced the same runtime `TypeError` here.
// @expect-error: TS2322
import { defineReducerChart, ty } from "../graph";
export const r = defineReducerChart({
  ctx: ty<{ readonly n: number }>(),
  states: ["idle", "busy"],
  initial: "idle",
  events: { GO: {} },
  on: { GO: { target: "busy", when: "gate" } },
});
