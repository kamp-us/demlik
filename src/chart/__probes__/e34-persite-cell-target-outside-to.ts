// PROBE 34: the PER-SITE form of a multi-site cell, returning a target that
// some OTHER site admits but THIS one does not.
//
// This is the hole PROBE 22 does not close. `decide` is reached from `a.X`
// (`to: ["a","b"]`) and from `b.Y` (`to: ["a","c"]`). Written in the function
// form, `return [{...s, type: "c"}, []]` inside the `at === "a.X"` branch
// COMPILES: one rest signature over a union of tuples has no dependent return
// type, so the clamp is the union of both sites' `to`. Written per site, each
// entry is clamped to its own `to` and tsc names the offending literal.
// @expect-error: TS2322
import type { PG, PMsg, PState } from "../assert.test-d";
import type { Cells } from "../graph";
export const bad: Cells<PG, PState, PMsg> = {
  decide: {
    "a.X": (s) => [{ ...s, type: "c" }, []],
    "b.Y": (s) => [{ ...s, type: "a" }, []],
  },
};
