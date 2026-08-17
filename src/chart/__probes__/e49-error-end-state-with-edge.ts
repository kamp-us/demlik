// PROBE 49: probe 14's rule, at the OTHER polarity. `end: "error"` is a final
// — it accepts nothing — so it cannot declare an edge either.
//
// This is not probe 14 written twice. `end` widened from `true` to
// `true | "error"`, and every rule that keys off finality reads one predicate
// (`IsEndOf`). Had that predicate kept testing `end: true` alone, the widening
// would have made an error final a NON-final everywhere it matters: free to
// declare edges, and back on the hook for every live pair. Both halves fail
// silently and neither shows up in a passing test — an error final is a state
// nothing is supposed to leave, so nothing exercises the edge it just gained.
// @expect-error: TS2322
import { defineChart } from "../graph";
export const g = defineChart({
  events: { WIP: { scope: "edges" }, REOPEN: { scope: "edges" } },
  states: {
    only: {
      queued: { on: { WIP: "frozen" } },
      frozen: { end: "error", on: { REOPEN: "queued" } }, // ← both
    },
  },
});
