// ═══════════════════════════════════════════════════════════════════════════
// THE LANE, AS A STRUCTURE — N chart instances in parallel, grouped into
// phases that sequence.
//
// A chart describes ONE machine. A lane is not one machine and pretending it
// is costs you the two facts that matter most about it: WHICH tasks are running
// beside each other right now, and WHAT has to finish before the next group
// starts. So the lane is its own structure, and it is deliberately thin — two
// halves, no third:
//
//   `defineLane` — the AUTHORING door. Phases in order, each holding the tasks
//   that run concurrently in it, each task an instance of a chart. Everything
//   an author would otherwise repeat is DERIVED: the phase order is the
//   declaration order, a phase's task set is its keys, and which of a task's
//   finals are success and which are error is read off the charts themselves.
//
//   `laneShape` — the READING door, over ANY lane: one built here, or one
//   `chartFromWorkflow` imported from a `workflow.json` this repo has never
//   seen. Both produce the same `ImportedLane`, so the fold, the report and the
//   inspector take either without knowing which.
//
// WHAT THIS IS NOT, and the boundary is worth stating because it is the whole
// design: there is no lane RUNTIME here. No per-instance boot override, no
// router turning `ISSUE_5729.DONE` into a message for region 5729, nothing that
// makes a lane dispatchable as a `Machine`. fabrika folds its own log and this
// module reads the result. A lane you can DRAW is a smaller thing than a lane
// you can RUN, and it is the thing that was missing.
// ═══════════════════════════════════════════════════════════════════════════

import {
  endPolarityOf,
  type ImportedChart,
  type ImportedLane,
  type ImportedNode,
  statesOf,
} from "../report/workflow";

/** The retry budget a task inherits when the lane names none — fabrika's. */
const RETRY_BUDGET = 2;

// ── the authored form ──────────────────────────────────────────────────────

/**
 * A lane, as an author writes it.
 *
 * The nesting IS the structure: `phases` is an ordered record of phase name →
 * the tasks running concurrently in that phase → the chart each of those tasks
 * is an instance of. Nothing states the phase order (it is the key order),
 * nothing states a phase's task set (it is the keys), and nothing states which
 * finals are which (the charts say).
 */
export interface LaneSpec {
  /** The lane's own id — what a report titles itself with. */
  readonly id?: string;
  /** What fires this lane, when something does. */
  readonly trigger?: string;
  /** Phase name → task id → the chart that task runs. IN ORDER. */
  readonly phases: Readonly<
    Record<string, Readonly<Record<string, ImportedChart>>>
  >;
  /** The lane's two endings. `tripped` is where an error final lands it. */
  readonly terminals: {
    readonly complete: string;
    readonly tripped: string;
  };
  /**
   * The retry budget, per task, where it is not {@link RETRY_BUDGET}.
   *
   * SUPPLIED, not derived, and the one thing on this interface that is. The
   * guarded edge's predicate is `retries < maxRetries` and no chart declares
   * the right-hand side — it is a property of the RUN, which is why fabrika
   * keeps it in the document's `context` rather than in the machine.
   */
  readonly retries?: Readonly<Record<string, number>>;
  /** Anything else the lane carries per task, passed through untouched. */
  readonly extras?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

// ── the authoring mistakes the types can see ───────────────────────────────
//
// Constraint checking is plain assignability and does not run excess-property
// checks, so these map an offending SHAPE to a marker object naming the
// offender — which the object-literal check then rejects, with the rule in the
// diagnostic instead of a `never` the author has to reverse-engineer.

type TaskIdsIn<P> = { [K in keyof P]: keyof P[K] }[keyof P];

/** Task ids declared under more than one phase. */
type DuplicateTasks<P> = {
  [K in keyof P]: Extract<keyof P[K], TaskIdsIn<Omit<P, K>>>;
}[keyof P];

/** Phases whose task record is empty — a phase that completes on arrival. */
type EmptyPhases<P> = {
  [K in keyof P]: [keyof P[K]] extends [never] ? K : never;
}[keyof P];

type PhasesOf<S> = S extends { readonly phases: infer P } ? P : never;
type TerminalsOf<S> = S extends {
  readonly terminals: { readonly complete: infer C; readonly tripped: infer T };
}
  ? C | T
  : never;
type RetryKeysOf<S> = S extends { readonly retries: infer R } ? keyof R : never;

/**
 * The four lane-shaped mistakes assignability can catch on its own.
 *
 * The rest are RUNTIME checks in {@link defineLane}, and that is not laziness:
 * an `ImportedChart` is runtime-typed by construction (its whole point is to
 * carry a document this repo has never compiled), so "does this chart declare
 * an initial state" is not a question the type layer can be asked. Where a
 * guarantee cannot be had, it is thrown for rather than pretended.
 */
export type LaneChecks<S> = ([DuplicateTasks<PhasesOf<S>>] extends [never]
  ? unknown
  : {
      readonly __taskDeclaredInTwoPhases: DuplicateTasks<PhasesOf<S>>;
    }) &
  ([EmptyPhases<PhasesOf<S>>] extends [never]
    ? unknown
    : { readonly __phaseDeclaresNoTasks: EmptyPhases<PhasesOf<S>> }) &
  ([Extract<TerminalsOf<S>, keyof PhasesOf<S>>] extends [never]
    ? unknown
    : {
        readonly __terminalCollidesWithAPhase: Extract<
          TerminalsOf<S>,
          keyof PhasesOf<S>
        >;
      }) &
  ([Exclude<RetryKeysOf<S>, TaskIdsIn<PhasesOf<S>>>] extends [never]
    ? unknown
    : {
        readonly __retryBudgetNamesAnUnknownTask: Exclude<
          RetryKeysOf<S>,
          TaskIdsIn<PhasesOf<S>>
        >;
      });

/** The self-referential constraint `defineLane` binds its argument with. */
export type LaneOf<S> = LaneSpec & LaneChecks<S>;

/** The lane does not hold together — with every defect named, never a half-lane. */
export class LaneShapeError extends Error {
  override readonly name = "LaneShapeError";
  readonly _tag = "LaneShapeError" as const;
  constructor(public readonly defects: readonly string[]) {
    super(
      `@demlik/tea: this lane does not hold together —\n` +
        defects.map((d) => `  • ${d}`).join("\n"),
    );
  }
}

/**
 * A lane, from phases of charts.
 *
 * The result is an {@link ImportedLane} and nothing more — the SAME value
 * `chartFromWorkflow` returns for a `workflow.json`, so `foldLane`,
 * `deriveLaneStatus`, `laneReport` and `inspectLane` all take it without a
 * second code path. There is exactly one lane representation in this module and
 * two ways to obtain it.
 *
 * ```ts
 * const lane = defineLane({
 *   id: "epic-5728",
 *   phases: {
 *     phase1: { issue_5729: coderChart, issue_5730: coderChart },
 *     phase2: { issue_5731: coderChart },
 *   },
 *   terminals: { complete: "complete", tripped: "tripped" },
 * });
 * ```
 *
 * @throws {LaneShapeError} for the defects the type layer cannot see — a chart
 *   with no `initial: true`, a chart with no final at all (its phase could
 *   never complete, so the lane could never advance), and two terminals spelled
 *   the same way.
 */
export function defineLane<const S extends LaneOf<S>>(spec: S): ImportedLane {
  const defects: string[] = [];
  const phases: { name: string; tasks: string[] }[] = [];
  const charts: Record<string, ImportedChart> = {};
  const context: ImportedLane["context"] = {};

  if (spec.terminals.complete === spec.terminals.tripped) {
    defects.push(
      `both terminals are "${spec.terminals.complete}" — a lane that ended cannot say which ending it reached`,
    );
  }

  for (const [phaseName, tasks] of Object.entries(spec.phases)) {
    const ids: string[] = [];
    for (const [taskId, chart] of Object.entries(tasks)) {
      ids.push(taskId);
      charts[taskId] = chart;
      const nodes = [...statesOf(chart).values()];
      if (!nodes.some((node) => node.initial === true)) {
        defects.push(
          `task "${taskId}": its chart marks no state \`initial: true\` — the fold has no zero to start from`,
        );
      }
      if (!nodes.some((node) => node.end !== undefined)) {
        defects.push(
          `task "${taskId}": its chart declares no final — phase "${phaseName}" could never complete, so the lane could never advance`,
        );
      }
      (context as Record<string, unknown>)[taskId] = {
        maxRetries: spec.retries?.[taskId] ?? RETRY_BUDGET,
        extras: spec.extras?.[taskId] ?? {},
      };
    }
    phases.push({ name: phaseName, tasks: ids });
  }

  if (phases.length === 0) defects.push("the lane declares no phase");
  if (defects.length > 0) throw new LaneShapeError(defects);

  return {
    ...(spec.id === undefined ? {} : { id: spec.id }),
    ...(spec.trigger === undefined ? {} : { trigger: spec.trigger }),
    phases,
    terminals: spec.terminals,
    charts,
    context,
  };
}

// ── the reading form ───────────────────────────────────────────────────────

/** One task of a lane, with everything about it that is derivable. */
export interface LaneTaskShape {
  readonly id: string;
  /** The phase it runs in. */
  readonly phase: string;
  /** That phase's position in the sequence. */
  readonly phaseIndex: number;
  /** Where its fold starts — `initial: true`, read off the chart. */
  readonly initial: string;
  /** The right-hand side of the guarded edge's `retries < maxRetries`. */
  readonly maxRetries: number;
  /** `end: true` — the endings that let the phase complete. */
  readonly successFinals: readonly string[];
  /** `end: "error"` — the endings that trip the lane. */
  readonly errorFinals: readonly string[];
  /** The tasks running BESIDE this one, in the same phase. */
  readonly siblings: readonly string[];
}

/** One phase, and the tasks that run concurrently inside it. */
export interface LanePhaseShape {
  readonly name: string;
  readonly index: number;
  readonly tasks: readonly string[];
  /** The phase this one's `onDone` advances to, or the lane's ending. */
  readonly next: string;
}

/**
 * A whole lane, read as data. Nothing here is supplied — every field is a
 * derivation over the phases and the charts they hold.
 */
export interface LaneShape {
  readonly id?: string;
  readonly trigger?: string;
  readonly phases: readonly LanePhaseShape[];
  /** Every task, in phase order then declaration order. */
  readonly tasks: readonly LaneTaskShape[];
  readonly terminals: { readonly complete: string; readonly tripped: string };
  /**
   * Tasks whose chart declares NO error final.
   *
   * Not a defect — a lane may legitimately hold a task that cannot fail. It is
   * reported because it is invisible otherwise and it changes what the lane can
   * do: no run of that task can ever reach the `tripped` terminal.
   */
  readonly cannotTrip: readonly string[];
}

const finalsOf = (
  chart: ImportedChart,
  want: true | "error",
): readonly string[] => {
  const out: string[] = [];
  for (const [name, node] of statesOf(chart)) {
    if (endPolarityOf(node as ImportedNode) === want) out.push(name);
  }
  return out;
};

/**
 * Read a lane — imported or authored — into its {@link LaneShape}.
 *
 * Pure and total. It executes nothing, it validates nothing, and it refuses
 * nothing: it is the reader half, and a lane that is odd (a task with no error
 * final, say) comes back described rather than rejected. {@link defineLane} is
 * where an authoring mistake is refused; this is where any lane is read.
 */
export function laneShape(lane: ImportedLane): LaneShape {
  const phases: LanePhaseShape[] = lane.phases.map((phase, index) => ({
    name: phase.name,
    index,
    tasks: phase.tasks,
    // The `onDone` chain, as a reader sees it: every phase but the last hands
    // off to the next one, and the last hands off to the lane's own ending.
    next: lane.phases[index + 1]?.name ?? lane.terminals.complete,
  }));

  const tasks: LaneTaskShape[] = [];
  const cannotTrip: string[] = [];
  for (const phase of phases) {
    for (const taskId of phase.tasks) {
      const chart = lane.charts[taskId];
      if (chart === undefined) continue;
      const errorFinals = finalsOf(chart, "error");
      if (errorFinals.length === 0) cannotTrip.push(taskId);
      let initial = "";
      for (const [name, node] of statesOf(chart)) {
        if (node.initial === true) initial = name;
      }
      tasks.push({
        id: taskId,
        phase: phase.name,
        phaseIndex: phase.index,
        initial,
        maxRetries: lane.context[taskId]?.maxRetries ?? RETRY_BUDGET,
        successFinals: finalsOf(chart, true),
        errorFinals,
        siblings: phase.tasks.filter((other) => other !== taskId),
      });
    }
  }

  return {
    ...(lane.id === undefined ? {} : { id: lane.id }),
    ...(lane.trigger === undefined ? {} : { trigger: lane.trigger }),
    phases,
    tasks,
    terminals: lane.terminals,
    cannotTrip,
  };
}
