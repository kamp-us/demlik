// PROBE 8: `end: true` means "accepts nothing", so it cannot also accept
// something. Declaring both is an invalid state, and unrepresentable.
import { defineGraph } from "../graph";
export const g = defineGraph({
  queued: { on: { WIP: "shipped" }, ignore: ["REOPEN"] },
  shipped: { end: true, on: { REOPEN: "queued" } }, // ← both
});
