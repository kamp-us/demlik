// PROBE 45: probe 42's hole in the REDUCER form. Same typo, same silence, same
// consequence — `RStateOf<C>` collapsed to `{ type: "idle" | "busy" }` with no
// `ctx` at all, so `assign: { GO: () => ({}) }` type-checked and every payload
// obligation the chart existed to state was deleted.
// @expect-error: TS2345
import { defineReducerChart, ty } from "../graph";
export const r = defineReducerChart({
  cxt: ty<{ readonly n: number }>(),
  states: ["idle", "busy"],
  initial: "idle",
  events: { GO: {} },
  on: { GO: "busy" },
});
