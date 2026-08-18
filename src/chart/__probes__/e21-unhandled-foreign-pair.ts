// PROBE 21: totality is UNCHANGED for a foreign event. `foreign: true` says
// whose NAME it is, nothing else — the event still declares a `scope`, and every
// state that scope makes it live in still owes a decision about it.
//
// Here `deadline_exceeded` is live across the whole `live` phase and `parked`
// neither routes nor ignores it.
// @expect-error: TS2322
import { defineChart, ty } from "../graph";

export const g = defineChart({
  events: {
    GO: { scope: "edges" },
    deadline_exceeded: {
      data: ty<{ readonly id: string; readonly atMs: number }>(),
      foreign: true,
      scope: "live",
    },
  },
  states: {
    live: {
      idle: {
        initial: true,
        on: { GO: "parked" },
        ignore: ["deadline_exceeded"],
      },
      parked: { on: { GO: "idle" } },
    },
  },
});
