// PROBE 6: a typo'd edge FIELD. Without the `Strict` F-bound this compiled
// silently — `{target, whn, otherwise}` structurally satisfies
// `{target: SN; cmd?: …}` — and the guard was dropped with no diagnostic.
// @expect-error: TS2322
import { defineChart } from "../graph";
export const g = defineChart({
  events: { FAIL: { scope: "edges" } },
  states: {
    only: {
      review: {
        on: {
          FAIL: {
            target: "build",
            whn: "retriesRemaining",
            otherwise: "frozen",
          },
        },
      },
      build: { end: true },
      frozen: { end: true },
    },
  },
});
