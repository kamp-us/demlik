// PROBE 17 (new): an `ignore` entry naming an event that is NOT live at this
// state. It refuses nothing — it is the paste-the-error-back reflex applied to
// a pair that was never open. Caught, so `ignore` cannot decay into noise.
import { defineChart } from "../graph";
export const g = defineChart({
  events: { WIP: { scope: "edges" }, UNBLOCKED: { scope: "parked" } },
  states: {
    working: { queued: { on: { WIP: "queued" }, ignore: ["UNBLOCKED"] } }, // ← not live here
    parked: { blocked: { on: { UNBLOCKED: "queued" } } },
  },
});
