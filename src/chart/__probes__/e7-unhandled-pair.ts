// PROBE 7: a (state × event) pair that is neither declared nor refused.
// THE regression this whole file exists for: before `Total<G>`, `review` said
// nothing about `UNBLOCKED` and the pair silently fell through to the global
// `unhandled` policy — the `_ -> (state, [])` default `Transitions` forbids.
import { defineGraph } from "../graph";
export const g = defineGraph({
  queued: { on: { WIP: "build" }, ignore: ["UNBLOCKED", "DONE"] },
  build: { on: { DONE: "queued" }, ignore: ["WIP", "UNBLOCKED"] },
  // ← `review` decides nothing about WIP, DONE or UNBLOCKED.
  review: { on: {}, ignore: [] },
  blocked: { on: { UNBLOCKED: "queued" }, ignore: ["WIP", "DONE"] },
});
