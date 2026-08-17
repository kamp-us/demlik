// PROBE 14: `end: true` means "accepts nothing", so it cannot also accept
// something. Declaring both is an invalid state, and unrepresentable.
import { defineChart } from "../graph";
export const g = defineChart({
  events: { WIP: { scope: "edges" }, REOPEN: { scope: "edges" } },
  states: {
    only: {
      queued: { on: { WIP: "shipped" } },
      shipped: { end: true, on: { REOPEN: "queued" } }, // ← both
    },
  },
});
