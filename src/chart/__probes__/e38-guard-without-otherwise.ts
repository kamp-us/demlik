// PROBE 38: `when` with no `otherwise`. The guard has nowhere to fail to, and
// the two layers used to disagree about what that means: the type layer read
// the edge as UNGUARDED (a plain assign fn) while the walk read `when` and
// demanded `{ then, else }` — so the chart compiled and then died with
// `payloadFn is not a function` on the first message. `when` and `otherwise`
// are one fact; half of it is a hole, not a decision.
// @expect-error: TS2322
import { defineChart, ty } from "../graph";
export const g = defineChart({
  ctx: ty<{ readonly n: number }>(),
  events: { A: { scope: "edges" } },
  states: {
    only: {
      s0: { initial: true, on: { A: { target: "s1", when: "gate" } } },
      s1: {},
    },
  },
});
