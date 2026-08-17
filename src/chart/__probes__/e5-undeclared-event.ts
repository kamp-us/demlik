// PROBE 5: an event used in `on` that is not declared in `events`. Before the
// chart owned the alphabet this silently INVENTED an event, and the hole only
// surfaced later as a missing payload in a parallel type map.
import { defineChart, ty } from "../graph";
export const g = defineChart({
  events: { WIP: { data: ty<{ readonly at: number }>(), scope: "edges" } },
  states: {
    only: {
      queued: { on: { WIP: "build", ESCALATE: "build" } }, // ← ESCALATE undeclared
      build: { end: true },
    },
  },
});
