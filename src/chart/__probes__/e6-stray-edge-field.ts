// PROBE 6 (bonus): a typo'd edge FIELD. Without the `StrictEdges` F-bound this
// compiled silently — `{target, whn, otherwise}` structurally satisfies
// `{target: SN; cmd?: string}` — and the guard was dropped with no diagnostic.
import { defineGraph } from "../graph";
export const g = defineGraph({
  review: { on: { FAIL: { target: "build", whn: "retriesRemaining", otherwise: "frozen" } } },
  build: {},
  frozen: {},
});
