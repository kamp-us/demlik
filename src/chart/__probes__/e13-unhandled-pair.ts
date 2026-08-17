// PROBE 13: a (state × event) pair that is neither declared nor refused.
// THE regression this file exists for: `review` decides nothing about three
// events that its phase is IN SCOPE for, and the pair would otherwise fall
// through to a global policy — the `_ -> (state, [])` default `Transitions`
// forbids.
import { defineChart } from "../graph";
export const g = defineChart({
  events: {
    WIP: { scope: "lane" },
    DONE: { scope: "lane" },
    UNBLOCKED: { scope: "lane" },
  },
  states: {
    lane: {
      queued: { on: { WIP: "build" }, ignore: ["UNBLOCKED", "DONE"] },
      build: { on: { DONE: "queued" }, ignore: ["WIP", "UNBLOCKED"] },
      // ← `review` decides nothing about WIP, DONE or UNBLOCKED.
      review: { on: {}, ignore: [] },
      blocked: { on: { UNBLOCKED: "queued" }, ignore: ["WIP", "DONE"] },
    },
  },
});
