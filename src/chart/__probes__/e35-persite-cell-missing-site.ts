// PROBE 35: the per-site form with a site MISSING. The bag is a mapped type
// over the closed set of use sites, so an omitted site is a missing property
// tsc names — the per-site form is TOTAL, not a partial override table, and a
// site added to the chart later turns exactly this red.
import type { PG, PMsg, PState } from "../assert";
import type { Cells } from "../graph";
export const bad: Cells<PG, PState, PMsg> = {
  decide: {
    "a.X": (s) => [{ ...s, type: "b" }, []],
  },
};
