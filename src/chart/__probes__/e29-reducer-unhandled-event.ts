// PROBE 29: TOTALITY, at the one dimension this form has. `on` is a REQUIRED
// mapped type over the event alphabet, so a declared event with no edge is a
// missing property and tsc names it. This is what replaces `scope`/`ignore`/
// `Total<C>`: the same obligation, one quantifier smaller, enforced for free.
import { defineReducerChart, ty } from "../graph";
export const bad = defineReducerChart({
  ctx: ty<{ readonly n: number }>(),
  states: ["a", "b"],
  initial: "a",
  events: { X: {}, Y: { data: ty<{ readonly k: number }>() } },
  on: { X: "b" },
});
