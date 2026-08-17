// PROBE 22: a MULTI-SITE cell body reading a field from the WRONG site, after
// correctly discriminating on `at` — the exact twin of PROBE 7 for guards,
// because the escape hatch reuses `SitesWhere`/`SiteArgs` rather than inventing
// a second narrowing mechanism. `decide` is reached from `a.X` and `b.Y`; inside
// the `a.X` branch `m` is pinned to the `X` msg, so `m.hi` (a `Y` field) is
// rejected against that ONE narrowed member.
//
// NOTE what this probe does NOT catch: `type: "c"` inside the `a.X` branch. The
// PARAMETERS narrow per site, the RETURN does not — one rest signature over a
// union of tuples has no dependent return type — so the clamp here is the union
// of both sites' `to`, and `c` (which only `b.Y` admits) slips through. PROBE 25
// is that case, in the per-site form that does catch it; `CellTargetError` is
// what catches it at runtime in this form.
import type { PG, PMsg, PState } from "../assert";
import type { Cells } from "../graph";
export const bad: Cells<PG, PState, PMsg> = {
  decide: (s, m, at) => {
    switch (at) {
      case "a.X":
        return [{ ...s, type: m.hi === "" ? "a" : "c" }, []];
      case "b.Y":
        return [{ ...s, type: "a" }, []];
    }
  },
};
