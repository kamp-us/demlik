// PROBE 18 (new): a typo'd `scope`. The phase universe is `keyof states` — the
// phases are declared by BEING keys — so a scope naming a phase that does not
// exist is a name error, not a silently-empty obligation.
import { defineChart } from "../graph";
export const g = defineChart({
  events: { UNBLOCKED: { scope: "prakedd" } }, // ← typo: phase is "parked"
  states: {
    working: { queued: {} },
    parked: { blocked: { on: { UNBLOCKED: "queued" } } },
  },
});
