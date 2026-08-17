// PROBE 20: a FOREIGN (un-namespaced) event whose name collides with the shape
// of a NAMESPACED key. A namespaced key is `${ns}.${event}`, so a foreign event
// literally named `"JOB_A.START"` would be indistinguishable from instance A's
// own `START` — two different events, one table key, last one wins.
//
// `Total<C>` bans the dot on a foreign name, so the collision is unrepresentable
// for EVERY namespace at once rather than caught per-`compile`.
import { defineChart, ty } from "../graph";

export const g = defineChart({
  events: {
    START: { scope: "edges" },
    "JOB_A.START": {
      data: ty<{ readonly n: number }>(),
      foreign: true,
      scope: "edges",
    },
  },
  states: {
    only: {
      a: { initial: true, on: { START: "b", "JOB_A.START": "b" } },
      b: { end: true },
    },
  },
});
