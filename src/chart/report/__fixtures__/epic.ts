/**
 * A MULTI-PHASE lane document, emitted by fabrika's own emitter — plus the runs
 * through it, walked off the emitted grammar rather than written down.
 *
 * WHY THIS FILE EXISTS. Both committed templates (`coder`, `chore`) are
 * single-phase, so `deriveLaneStatus`'s phase-advance half — the loop that
 * decides the active phase, the `"waiting"` label on the phases below it, and
 * the `noErrors` gate that trips on a completed phase — had no document to be
 * tested against. It was reviewed, not tested. This is the document that tests
 * it, and it is not one this repo drew: `emitMachine` in
 * `vendor/fabrika-emit.ts` is fabrika's own, and what it is handed is a
 * `## Dependencies` block, which is the plan-layer grammar `build eligible`
 * already gates on.
 *
 * NOTHING HERE NAMES A STATE OF THE EPIC MACHINE, and that is deliberate.
 * `emit.ts` is being rewritten upstream (phoenix #5800 — an epic run is moving
 * from one-PR-per-child to one-PR-per-run), so a fixture that hardcoded
 * `integrate` or `landed` would be a fixture with a known expiry date. What is
 * NOT changing is the grammar the document is written in: parallel phase
 * regions, a phase's `onDone` pair, guarded two-arm arrays, history targets,
 * `final` nodes. So the runs below are WALKED — {@link runEvents} searches each
 * task's imported region for the shortest event path to a final of the
 * requested polarity and emits the events along it. Re-vendor a differently
 * shaped emitter and this file needs no edit; the run re-walks.
 *
 * The one thing supplied rather than derived is the OUTCOME: which tasks land
 * and which ones freeze. That is a choice about the run, not a fact about the
 * machine, and there is nowhere to read it from.
 */
import {
  type ImportedChart,
  type ImportedLane,
  chartFromWorkflow,
  endPolarityOf,
  initialOf,
  statesOf,
} from "../workflow";
import type { LogEntry, TaskState } from "../fold";
import { stepTask } from "../fold";
import { emitMachine, type SubIssueLink } from "./vendor/fabrika-emit";

/** The epic, and the three children the topology places into two phases. */
export const EPIC_NUMBER = 5728;

/**
 * The emitter's INPUT — the plan-layer `## Dependencies` grammar, which is the
 * half of this that is stable. Two phases plus a `requires:` edge inside them,
 * so the emitted machine is genuinely multi-phase and the phase order is not an
 * accident of iteration.
 */
export const EPIC_BODY = [
  "## Dependencies",
  "",
  "- phase 1: #5729, #5730",
  "- phase 2: #5731",
  "- #5731 requires: #5729",
  "",
].join("\n");

/** Every child open, so every region boots at its own initial. */
export const EPIC_CHILDREN: readonly SubIssueLink[] = [
  { number: 5729, state: "open", stateReason: null },
  { number: 5730, state: "open", stateReason: null },
  { number: 5731, state: "open", stateReason: null },
];

function emitted(children: readonly SubIssueLink[]): unknown {
  const result = emitMachine(EPIC_NUMBER, EPIC_BODY, children);
  if (result._tag !== "Emitted") {
    throw new Error(
      `the vendored emitter no longer emits this epic: ${result._tag}`,
    );
  }
  return JSON.parse(result.text);
}

/** The multi-phase `workflow.json`, as fabrika's emitter wrote it. */
export const EPIC_DOCUMENT: unknown = emitted(EPIC_CHILDREN);

/**
 * The same epic with one child closed without landing — the emitter boots that
 * region in an error final, so the lane trips before a single event is logged.
 * A phase-gate case no run of events can produce.
 */
export const EPIC_DOCUMENT_ABANDONED_CHILD: unknown = emitted([
  { number: 5729, state: "open", stateReason: null },
  { number: 5730, state: "closed", stateReason: "not_planned" },
  { number: 5731, state: "open", stateReason: null },
]);

// ── walking a run off the emitted grammar ──────────────────────────────────

/** How one task's run should end. `true` a success final, `"error"` the trip. */
export type Outcome = true | "error";

export interface RunPlan {
  /** Per task id. A task the plan does not name is driven to a success final. */
  readonly outcomes?: Readonly<Record<string, Outcome>>;
  /**
   * Task ids that take the park-and-resume detour first — one plain edge into a
   * state that carries a `resume` out-edge, then the resume. Found by SHAPE, so
   * no parked state is ever named here.
   */
  readonly park?: readonly string[];
  /** The instant the first event is logged. One minute per event after it. */
  readonly startedAt?: string;
}

const key = (state: TaskState): string =>
  `${state.type}|${state.retries}|${state.was ?? ""}`;

/**
 * The shortest event path from `start` to a final of `want`, or `null`.
 *
 * A breadth-first walk over (leaf, retries, `was`) applying the SAME
 * {@link stepTask} the fold applies — so a path this returns is a path the fold
 * replays by construction, and the retry budget is walked rather than assumed
 * (reaching an error final means spending it, which takes as many rounds as the
 * document says it takes).
 */
function pathToFinal(
  chart: ImportedChart,
  start: TaskState,
  want: Outcome,
): readonly string[] | null {
  const states = statesOf(chart);
  const reached = (state: TaskState): boolean =>
    endPolarityOf(states.get(state.type)) === want;
  if (reached(start)) return [];
  const seen = new Set([key(start)]);
  let frontier: { state: TaskState; path: readonly string[] }[] = [
    { state: start, path: [] },
  ];
  while (frontier.length > 0) {
    const next: { state: TaskState; path: readonly string[] }[] = [];
    for (const { state, path } of frontier) {
      for (const event of Object.keys(states.get(state.type)?.on ?? {})) {
        const stepped = stepTask(chart, state, event);
        if (seen.has(key(stepped))) continue;
        seen.add(key(stepped));
        const walked = [...path, event];
        if (reached(stepped)) return walked;
        next.push({ state: stepped, path: walked });
      }
    }
    frontier = next;
  }
  return null;
}

/**
 * The park-and-resume detour, found by shape: a plain edge into a state that
 * carries a `resume` out-edge, and that resume event back out of it.
 */
function parkDetour(
  chart: ImportedChart,
  state: TaskState,
): readonly string[] | null {
  const states = statesOf(chart);
  for (const [event, edge] of Object.entries(states.get(state.type)?.on ?? {})) {
    if (!("target" in edge) || "when" in edge) continue;
    for (const [back, out] of Object.entries(
      states.get(edge.target)?.on ?? {},
    )) {
      if ("resume" in out) return [event, back];
    }
  }
  return null;
}

/**
 * A whole run through a lane, phase by phase, as `events.jsonl` entries.
 *
 * Phases are driven IN ORDER and a phase's tasks are driven to a final before
 * the next phase's first event — which is what makes the log one fabrika's own
 * driver would have appended (`applyEvent` refuses an event for a task outside
 * the active phase). Once a phase trips, the run STOPS: a tripped lane accepts
 * no further events, so continuing would produce a log no driver could write.
 */
export function runEvents(
  lane: ImportedLane,
  plan: RunPlan = {},
): readonly LogEntry[] {
  const started = Date.parse(plan.startedAt ?? "2026-08-17T09:00:00.000Z");
  const park = new Set(plan.park ?? []);
  const entries: LogEntry[] = [];
  const emit = (taskId: string, event: string): void => {
    entries.push({
      task: taskId,
      event: `${taskId.toUpperCase()}.${event}`,
      at: new Date(started + entries.length * 60_000).toISOString(),
    });
  };

  for (const phase of lane.phases) {
    let tripped = false;
    for (const taskId of phase.tasks) {
      const chart = lane.charts[taskId];
      if (chart === undefined) continue;
      let state: TaskState = {
        type: initialOf(chart),
        retries: 0,
        maxRetries: lane.context[taskId]?.maxRetries ?? 2,
      };
      const want = plan.outcomes?.[taskId] ?? true;
      if (park.has(taskId)) {
        for (const event of parkDetour(chart, state) ?? []) {
          emit(taskId, event);
          state = stepTask(chart, state, event);
        }
      }
      const path = pathToFinal(chart, state, want);
      if (path === null) {
        throw new Error(
          `task "${taskId}" has no path to a ${want === true ? "success" : "error"} final`,
        );
      }
      for (const event of path) {
        emit(taskId, event);
        state = stepTask(chart, state, event);
      }
      if (want === "error") tripped = true;
    }
    if (tripped) break;
  }
  return entries;
}

/** The lane, imported once — the runs below are walked off it. */
export const EPIC_LANE: ImportedLane = chartFromWorkflow(EPIC_DOCUMENT);

/** Every task lands: phase 1, then phase 2, then the epic tail — `complete`. */
export const EPIC_RUN_COMPLETE = runEvents(EPIC_LANE, {
  park: [EPIC_LANE.phases[0]?.tasks[1] ?? ""],
});

/** The same run, stopped where the second phase's first task freezes — `tripped`. */
export const EPIC_RUN_TRIPPED = runEvents(EPIC_LANE, {
  outcomes: { [EPIC_LANE.phases[1]?.tasks[0] ?? ""]: "error" },
});

/** `events.jsonl` bytes, for the halves that take text. */
export const asJsonl = (entries: readonly LogEntry[]): string =>
  entries.map((entry) => JSON.stringify(entry)).join("\n");
