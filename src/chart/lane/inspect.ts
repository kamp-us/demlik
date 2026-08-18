// ═══════════════════════════════════════════════════════════════════════════
// THE LANE, ASKED ABOUT ITSELF — the headless description a UI needs.
//
// `@demlik/tea/chart/inspect` already answers every question about ONE chart at
// ONE state: which events are legal here, which are refused and why, what each
// edge would do. A lane needs all of that, N times over, plus the four
// questions that only exist because there is more than one machine:
//
//   which phase is running, and what are the others doing
//   what state is each task in
//   what is each task waiting on
//   which tasks are stuck
//
// So this file composes rather than duplicates: `describeChart` and
// `inspectState` are called per task, `waitingOn` is the report's OWN
// derivation (one site, not two — and since that answer is itself derived from
// the events' declared `from`, there is no vocabulary anywhere on this path to
// keep in step), and `phaseStandings` is the same walk `deriveLaneStatus`
// makes. The only thing invented here is `stuck`, and it is defined below
// rather than felt.
//
// PURE, framework-free, and it never runs the lane. Fold in, description out.
// ═══════════════════════════════════════════════════════════════════════════

import type { Chart } from "../graph";
import {
  type ChartDescription,
  type ChartRefusal,
  describeChart,
  type EventPreview,
  inspectState,
} from "../inspect";
import {
  foldLane,
  type LogEntry,
  type PhaseStand,
  type PhaseStanding,
  phaseStandings,
  type TaskState,
  trippedTasks,
} from "../report/fold";
import { waitingOn } from "../report/report";
import {
  endPolarityOf,
  type ImportedChart,
  type ImportedLane,
  statesOf,
} from "../report/workflow";

/**
 * An `ImportedChart` IS the runtime shape `describeChart` walks — the same
 * `events`/`states` records, narrowed to the three edge forms a lane region can
 * produce. The cast is here rather than in `describeChart`, because widening
 * the inspector's parameter to accept a runtime-typed chart would cost every
 * OTHER caller the literal types that are the point of a chart.
 */
const describe = (chart: ImportedChart): ChartDescription =>
  describeChart(chart as unknown as Chart<never>);

/** Why a task cannot move. `null` when it can. */
export type StuckReason =
  | {
      /** It reached an error final: as finished as a shipped task, and lost. */
      readonly kind: "tripped";
      readonly state: string;
    }
  | {
      /**
       * A non-final state that routes NOTHING. The chart's totality means this
       * cannot happen on a chart that compiled — it is reported rather than
       * swallowed because reaching it means a document declared a dead end, and
       * a lane parked there will sit forever with no one to say why.
       */
      readonly kind: "dead-end";
      readonly state: string;
    }
  | {
      /** The retry budget is spent: the next guarded event is a one-way door. */
      readonly kind: "budget-spent";
      readonly state: string;
      readonly event: string;
      readonly landsOn: string;
    };

/** One task of a lane, inspected. */
export interface LaneTaskInspection {
  readonly task: string;
  readonly phase: string;
  /** The leaf it is in right now, out of the fold. */
  readonly state: string;
  /** `false` still running, `true` a success final, `"error"` tripped. */
  readonly endPolarity: false | true | "error";
  /** The state it will resume to, while it is parked. `undefined` otherwise. */
  readonly was?: string;
  readonly retries: number;
  readonly maxRetries: number;
  /**
   * The events this state routes, grouped by who sends them — {@link waitingOn},
   * read rather than recomputed. `null` at a final. On a lane imported without
   * a provenance map it degrades to the events alone, and says so.
   */
  readonly waitingOn: string | null;
  readonly stuck: StuckReason | null;
  /** Every event of this task's alphabet, legal or refused, with the reason. */
  readonly events: readonly EventPreview[];
  /** The refused half of {@link LaneTaskInspection.events}, pulled out. */
  readonly refusals: readonly ChartRefusal[];
  /** The legal half, as names — the button row. */
  readonly legal: readonly string[];
}

/** One phase of a lane, inspected. */
export interface LanePhaseInspection {
  readonly name: string;
  readonly index: number;
  readonly standing: PhaseStanding;
  /** The phase's tasks, each inspected — running concurrently, all of them. */
  readonly tasks: readonly LaneTaskInspection[];
  /** The tasks in this phase sitting on an error final. */
  readonly tripped: readonly string[];
}

/** A whole lane, as data a UI can build itself from. */
export interface LaneInspection {
  readonly id?: string;
  readonly status: "active" | "done";
  /** The terminal it landed on, or `null` while it is still running. */
  readonly terminal: string | null;
  /** The phase running right now, or `null` once the lane has ended. */
  readonly activePhase: string | null;
  readonly phases: readonly LanePhaseInspection[];
  /** Every task on an error final, lane-wide — fabrika's `context.errors`. */
  readonly tripped: readonly string[];
  /** Every task that cannot move, and why. The list a human is paged on. */
  readonly stuck: readonly {
    readonly task: string;
    readonly reason: StuckReason;
  }[];
}

/**
 * Why this task cannot move, or `null`.
 *
 * THREE KINDS, and the third is the one worth having. "Tripped" and "dead end"
 * are stuck in the ordinary sense — nothing can happen next. A task with its
 * retry budget spent CAN still move, and it is stuck in the sense that matters
 * operationally: the next `FAIL` is no longer a retry, it is the error final,
 * and a reader who cannot see that finds out afterwards.
 */
function stuckAt(chart: ImportedChart, state: TaskState): StuckReason | null {
  const node = statesOf(chart).get(state.type);
  const polarity = endPolarityOf(node);
  if (polarity === "error") return { kind: "tripped", state: state.type };
  if (polarity === true) return null;
  const edges = Object.entries(node?.on ?? {});
  if (edges.length === 0) return { kind: "dead-end", state: state.type };
  if (state.retries >= state.maxRetries) {
    for (const [event, edge] of edges) {
      if ("when" in edge) {
        return {
          kind: "budget-spent",
          state: state.type,
          event,
          landsOn: edge.otherwise,
        };
      }
    }
  }
  return null;
}

/**
 * A whole lane, inspected at the state its log folds to.
 *
 * ```ts
 * const lane = chartFromWorkflow(JSON.parse(workflowJson));
 * const view = inspectLane(lane, parseEventsJsonl(eventsJsonl));
 * view.activePhase;            // "phase2"
 * view.phases[1]?.tasks[0];    // state, waiting-on, legal events, refusals
 * view.stuck;                  // what a human has to go and do
 * ```
 *
 * Takes the LOG rather than a folded state, deliberately: the fold is pure over
 * a prefix, so `inspectLane(lane, entries.slice(0, k))` is the exact view at
 * step k and time travel costs a `slice`.
 */
export function inspectLane(
  lane: ImportedLane,
  entries: readonly LogEntry[],
): LaneInspection {
  const states = foldLane(lane, entries);
  const stands = phaseStandings(lane, states);
  const active = stands.find((stand) => stand.standing === "active");
  const trippedPhase = stands.find((stand) => stand.standing === "tripped");
  const stuck: { task: string; reason: StuckReason }[] = [];

  const inspectTask = (
    stand: PhaseStand,
    taskId: string,
  ): LaneTaskInspection | null => {
    const chart = lane.charts[taskId];
    const state = states[taskId];
    if (chart === undefined || state === undefined) return null;
    const desc = describe(chart);
    const events = inspectState(desc, { type: state.type, was: state.was });
    const reason = stuckAt(chart, state);
    if (reason !== null) stuck.push({ task: taskId, reason });
    return {
      task: taskId,
      phase: stand.name,
      state: state.type,
      endPolarity: endPolarityOf(statesOf(chart).get(state.type)),
      ...(state.was === undefined ? {} : { was: state.was }),
      retries: state.retries,
      maxRetries: state.maxRetries,
      waitingOn: waitingOn(chart, state.type),
      stuck: reason,
      events,
      refusals: events.flatMap((preview) =>
        preview.status === "refused" && preview.reason !== undefined
          ? [{ from: state.type, event: preview.event, reason: preview.reason }]
          : [],
      ),
      legal: events
        .filter((preview) => preview.status === "legal")
        .map((preview) => preview.event),
    };
  };

  const phases = stands.map((stand) => ({
    name: stand.name,
    index: stand.index,
    standing: stand.standing,
    tripped: stand.tripped,
    tasks: stand.tasks.flatMap((taskId) => inspectTask(stand, taskId) ?? []),
  }));

  return {
    ...(lane.id === undefined ? {} : { id: lane.id }),
    status: active === undefined ? "done" : "active",
    terminal:
      active !== undefined
        ? null
        : trippedPhase !== undefined
          ? lane.terminals.tripped
          : lane.terminals.complete,
    activePhase: active?.name ?? null,
    phases,
    tripped: trippedTasks(lane, states),
    stuck,
  };
}
