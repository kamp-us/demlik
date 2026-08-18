// PROBE 41: a `resume` edge that ALSO declares `when`/`otherwise`/`target`.
// `buildCell` tests `edge.resume` FIRST, so all three are dead code — but
// `GuardName<C>` still listed "gate", so the author wrote, typed and maintained
// a guard body that was never once called. Same rule, same shape as
// `__cellEdgeCannotAlsoDeclare`: an edge that owns its own target cannot also
// have one declared beside it.
// @expect-error: TS2322
import { defineChart, ty } from "../graph";
export const g = defineChart({
  ctx: ty<{ readonly n: number }>(),
  events: { PARK: { scope: "edges" }, BACK: { scope: "edges" } },
  states: {
    only: {
      s1: { initial: true, on: { PARK: "hold" } },
      s2: { on: { PARK: "hold" } },
      hold: {
        on: {
          BACK: {
            resume: { fallback: "s1" },
            when: "gate",
            otherwise: "s2",
            target: "s2",
          },
        },
      },
    },
  },
});
