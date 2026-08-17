// PROBE 43: a typo'd NODE-level key. `dta` is not `data`, so the state silently
// lost its extra payload. Worse than silent: it was INCONSISTENT — the same
// typo on a node with no `on` did get caught (TS2561, via the object-literal
// check against `StrictNode`'s lone `on?`), while this one, with an `on`
// present, sailed through. An author cannot rely on a rule that fires on half
// the nodes. `KnownNodeField` makes it fire on all of them, by name.
// @expect-error: TS2322
import { defineChart, ty } from "../graph";
export const g = defineChart({
  events: { Y: { scope: "edges" } },
  states: {
    only: {
      a: {
        initial: true,
        dta: ty<{ readonly extra: string }>(),
        on: { Y: "b" },
      },
      b: {},
    },
  },
});
