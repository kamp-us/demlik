// PROBE 25: a MULTI-SITE cell body reading a field from the WRONG site, after
// correctly discriminating on `at` — the exact twin of PROBE 7 for guards,
// because the escape hatch reuses `SitesWhere`/`SiteArgs` rather than inventing
// a second narrowing mechanism. `decide` is reached from `a.X` and `b.Y`; inside
// the `a.X` branch `m` is pinned to the `X` msg, so `m.hi` (a `Y` field) is
// rejected against that ONE narrowed member, and `type: "c"` is rejected because
// `c` is in `b.Y`'s `to`, not `a.X`'s.
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
