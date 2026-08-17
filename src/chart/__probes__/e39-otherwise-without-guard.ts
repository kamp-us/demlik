// PROBE 39: the mirror of probe 38 — `otherwise` with no `when`. There is no
// guard to fail, so the second arm can never be taken. Before this the type
// layer keyed the `{ then, else }` assign shape off `{ target, otherwise }` and
// demanded two builders, while the walk keyed off `when` and called the bag
// entry as a function: compiled clean, `TypeError` on the first message.
// @expect-error: TS2322
import { defineChart, ty } from "../graph";
export const g = defineChart({
  ctx: ty<{ readonly n: number }>(),
  events: { A: { scope: "edges" } },
  states: {
    only: {
      s0: { initial: true, on: { A: { target: "s1", otherwise: "s2" } } },
      s1: {},
      s2: {},
    },
  },
});
