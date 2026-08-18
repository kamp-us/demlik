// PROBE 60: a lane region whose chart declares a FOREIGN event.
//
// `keyOf` leaves a foreign event's name BARE under a namespace, deliberately:
// `deadline_exceeded` is the same event for every instance of a chart and its
// name was never the author's to rename. A lane message is addressed to ONE
// region, so a bare event addresses none of them — the routing has no answer,
// and inventing one (deliver it to every region at once) would be a different
// machine than the phases describe. Refused, with the task named.
// @expect-error: TS2345
import { defineChart, ty } from "../graph";
import { runLane } from "../lane/run";
import { defineLane } from "../lane/structure";

const listening = defineChart({
  events: {
    GO: { scope: "edges" },
    deadline_exceeded: {
      data: ty<{ readonly atMs: number }>(),
      scope: "edges",
      foreign: true,
    },
  },
  states: {
    only: {
      queued: { initial: true, on: { GO: "shipped" } },
      shipped: { end: true },
    },
  },
});

const lane = defineLane({
  phases: { p1: { t1: listening } },
  terminals: { complete: "complete", tripped: "tripped" },
});

export const rt = runLane(lane, {
  t1: {
    parts: { assign: { "queued.GO": () => ({}) } },
    boot: () => ({ type: "queued" }) as const,
  },
});
