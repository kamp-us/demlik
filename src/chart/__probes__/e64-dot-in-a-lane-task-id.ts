// PROBE 64: a dot in a lane task id.
//
// `${task}.${event}` IS the lane's wire key — `runLane` compiles each region
// under `ns = taskId`, and the fold splits an incoming name at the FIRST dot —
// so a dot on the task side re-partitions the key space. Task `a` with event
// `b.GO` and task `a.b` with event `GO` both register `"a.b.GO"`: last writer
// wins, one task's event is unreachable forever, and a message addressed to `a`
// moves `a.b`. Separately, task `epic.issue_1` emits a log line the splitter can
// never route back to it.
//
// Banned rather than deconflicted, for the reason `graph.ts` bans a dot in a
// state name and in a foreign event name: it makes the collision unrepresentable
// for every pairing at once, instead of deferring it to a per-lane check that
// only fires for the one pairing that happens to collide.
// @expect-error: TS2345
import { defineChart } from "../graph";
import { defineLane } from "../lane/structure";

const build = defineChart({
  events: { GO: { scope: "edges" } },
  states: {
    only: {
      queued: { initial: true, on: { GO: "shipped" } },
      shipped: { end: true },
    },
  },
});

export const epic = defineLane({
  phases: { phase1: { "epic.issue_1": build } },
  terminals: { complete: "complete", tripped: "tripped" },
});
