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
//   declaration order, a phase's task set is its keys, which of a task's finals
//   are success and which are error is read off the charts themselves, and —
//   where the charts are `defineChart` literals — so are the lane's own
//   alphabets, `LaneState` and `LaneMsg`.
//
//   `laneShape` — the READING door, over ANY lane: one built here, or one
//   `chartFromWorkflow` imported from a `workflow.json` this repo has never
//   seen. Both hold the same `ImportedChart` values, so the fold, the report and
//   the inspector take either without knowing which.
//
// WHAT THIS IS NOT, and the boundary is worth stating because it is the whole
// design: there is no lane RUNTIME here. No per-instance boot override, no
// router turning `ISSUE_5729.DONE` into a message for region 5729, nothing that
// makes a lane dispatchable as a `Machine`. fabrika folds its own log and this
// module reads the result. A lane you can DRAW is a smaller thing than a lane
// you can RUN, and it is the thing that was missing.
// ═══════════════════════════════════════════════════════════════════════════

import type {
  CellEdgeKey,
  ErrorFinal,
  EventName,
  InitialState,
  StateName,
  StateOf,
  SuccessFinal,
} from "../graph";
import {
  endPolarityOf,
  type ImportedChart,
  type ImportedEdge,
  type ImportedLane,
  type ImportedNode,
  statesOf,
} from "../report/workflow";

/** The retry budget a task inherits when the lane names none — fabrika's. */
const RETRY_BUDGET = 2;

// ── the two doors, and the ONE thing they have in common ───────────────────
//
// A lane's task runs a chart, and there are exactly two places a chart comes
// from: `defineChart` (literal types, `ctx`, payloads, cmds, cells) and
// `chartFromWorkflow` (an `ImportedChart` — `Chart<unknown>` by construction,
// because the document it was read from is one this repo has never compiled).
//
// Neither is assignable to the other, and the older spelling picked one:
// `phases` took `ImportedChart`, so a lane assembled from `defineChart`
// literals erased every literal type the chart module exists to preserve. That
// is the module's core guarantee dropped at its last seam.
//
// `LaneRegion` is the structural minimum BOTH satisfy — an event alphabet and
// states grouped into phases — so the spec's type parameter can carry whichever
// one the author actually wrote. What is stored is a third thing and always the
// same third thing: {@link lowerRegion} lowers either door's chart to the ONE
// `ImportedChart` representation the fold, the report and the inspector read.
// Types from the spec, value from the lowering — no cast between them.

/** The shape a lane task's chart has at EITHER door. */
export interface LaneRegion {
  readonly events: Readonly<Record<string, unknown>>;
  readonly states: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

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
    Record<string, Readonly<Record<string, LaneRegion>>>
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

// ── and the three the TYPED door adds ──────────────────────────────────────
//
// These three are questions about a chart's INSIDES, and which door the chart
// came through decides whether they can be asked at all. A `defineChart`
// literal answers them in the type layer; an `ImportedChart` cannot be asked
// (its states are `string` by construction), so each check reads the alphabet
// for degeneracy first and stands down where the answer would be a guess. The
// runtime checks in `defineLane` stay exactly where they are — they are what
// the imported door still needs, and they are now the SECOND net under the
// typed one rather than the only net under both.

/** Task ids whose chart hands a transition to a hand-written cell. */
type CellDelegatingTasks<P> = {
  [K in keyof P]: {
    [T in keyof P[K]]: [CellEdgeKey<P[K][T]>] extends [never] ? never : T;
  }[keyof P[K]];
}[keyof P];

/** Task ids whose chart marks no `initial: true` — the fold has no zero. */
type NoInitialTasks<P> = {
  [K in keyof P]: {
    [T in keyof P[K]]: [IsDegenerate<StateName<P[K][T]>>] extends [true]
      ? never
      : [InitialState<P[K][T]>] extends [never]
        ? T
        : never;
  }[keyof P[K]];
}[keyof P];

/** Task ids whose chart declares no final — its phase could never complete. */
type NoFinalTasks<P> = {
  [K in keyof P]: {
    [T in keyof P[K]]: [IsDegenerate<StateName<P[K][T]>>] extends [true]
      ? never
      : [SuccessFinal<P[K][T]> | ErrorFinal<P[K][T]>] extends [never]
        ? T
        : never;
  }[keyof P[K]];
}[keyof P];

type PhasesOf<S> = S extends { readonly phases: infer P } ? P : never;
type TerminalsOf<S> = S extends {
  readonly terminals: { readonly complete: infer C; readonly tripped: infer T };
}
  ? C | T
  : never;
type RetryKeysOf<S> = S extends { readonly retries: infer R } ? keyof R : never;

/**
 * The seven authoring mistakes assignability can catch — four about the lane's
 * own shape, three about the charts it was handed.
 *
 * The three chart-shaped ones stand down at the imported door, where the answer
 * would be a guess rather than a fact, and {@link defineLane}'s runtime checks
 * catch them there instead. Where a guarantee cannot be had, it is thrown for
 * rather than pretended.
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
      }) &
  ([CellDelegatingTasks<PhasesOf<S>>] extends [never]
    ? unknown
    : {
        readonly __laneTaskChartDelegatesToACell: CellDelegatingTasks<
          PhasesOf<S>
        >;
      }) &
  ([NoInitialTasks<PhasesOf<S>>] extends [never]
    ? unknown
    : {
        readonly __laneTaskChartMarksNoInitialState: NoInitialTasks<
          PhasesOf<S>
        >;
      }) &
  ([NoFinalTasks<PhasesOf<S>>] extends [never]
    ? unknown
    : { readonly __laneTaskChartDeclaresNoFinal: NoFinalTasks<PhasesOf<S>> });

/** The self-referential constraint `defineLane` binds its argument with. */
export type LaneOf<S> = LaneSpec & LaneChecks<S>;

// ── one representation: lowering either door's chart to `ImportedChart` ────

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * One authored edge → the one imported edge form, or `undefined` for the one
 * shape a lane cannot hold.
 *
 * A `defineChart` edge has five spellings and four of them lower exactly: the
 * bare target, the target with cmds (the cmds are the RUN's business, not the
 * topology's), the guarded pair, and `resume`. The fifth — `{ to, cell }` —
 * does not: a cell picks its target in hand-written code at runtime, and a lane
 * region has no runtime to pick with. That is refused, here and in the types.
 */
const lowerEdge = (edge: unknown): ImportedEdge | undefined => {
  if (typeof edge === "string") return { target: edge };
  if (!isRecord(edge)) return undefined;
  if (isRecord(edge.resume) && typeof edge.resume.fallback === "string") {
    return { resume: { fallback: edge.resume.fallback } };
  }
  if (typeof edge.target !== "string") return undefined;
  const target = edge.target;
  return typeof edge.when === "string" && typeof edge.otherwise === "string"
    ? { target, when: edge.when, otherwise: edge.otherwise }
    : { target };
};

/**
 * A chart from EITHER door → the single `ImportedChart` representation.
 *
 * Idempotent on an imported chart (every edge is already in the lowered form
 * and every event is already `scope: "edges"`), which is what makes this a
 * lowering rather than a second code path: the imported door goes through it
 * and comes out the value it went in as.
 */
const lowerRegion = (
  taskId: string,
  region: LaneRegion,
  defects: string[],
): ImportedChart => {
  const states: Record<string, Record<string, ImportedNode>> = {};
  for (const [group, nodes] of Object.entries(region.states)) {
    const lowered: Record<string, ImportedNode> = {};
    for (const [name, node] of Object.entries(nodes)) {
      if (!isRecord(node)) {
        defects.push(`task "${taskId}": state "${name}" is not an object`);
        continue;
      }
      const on: Record<string, ImportedEdge> = {};
      if (isRecord(node.on)) {
        for (const [event, edge] of Object.entries(node.on)) {
          const low = lowerEdge(edge);
          if (low === undefined) {
            defects.push(
              `task "${taskId}": "${name}.${event}" delegates its target to a cell — a lane region routes to targets it DECLARES, because nothing here runs a cell to pick one`,
            );
            continue;
          }
          on[event] = low;
        }
      }
      lowered[name] = {
        ...(node.initial === true ? { initial: true as const } : {}),
        ...(Object.keys(on).length > 0 ? { on } : {}),
        ...(node.end === true
          ? { end: true as const }
          : node.end === "error"
            ? { end: "error" as const }
            : {}),
      };
    }
    states[group] = lowered;
  }

  const events: Record<string, { readonly scope: "edges" }> = {};
  for (const name of Object.keys(region.events))
    events[name] = {
      scope: "edges",
    };

  return { events, states };
};

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
 * An authored lane: the {@link ImportedLane} every reader takes, plus the spec
 * it was authored from.
 *
 * `spec` is the whole typed door. It is DATA, not a phantom — the lane keeps
 * the charts it was handed, so `LaneState<L>` and `LaneMsg<L>` read the literal
 * types straight off it and nothing has to be re-declared beside the lane. An
 * imported lane simply has no `spec`, which is exactly what makes it read back
 * as `Chart<unknown>` through the same derivations: one formula, two doors.
 */
export interface Lane<S> extends ImportedLane {
  /** The spec this lane was authored from — where the literal types live. */
  readonly spec: S;
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
export function defineLane<const S extends LaneOf<S>>(spec: S): Lane<S> {
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
    for (const [taskId, region] of Object.entries(tasks)) {
      ids.push(taskId);
      const chart = lowerRegion(taskId, region, defects);
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
    spec,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// THE ALPHABETS A LANE DERIVES — one formula, read at both doors.
//
// Every type below is written ONCE and instantiated twice: at a `defineLane`
// lane it runs over the spec's literal charts and keeps every literal; at an
// `ImportedLane` it runs over {@link ImportedSpec} — the same shape with the
// bare `string` in every alphabet — and degenerates to exactly what the
// imported door has always said. There is no `L extends TypedLane ? … : …`
// anywhere in here, and that is the point: the imported door is not a special
// case of the typed one, it is the SAME derivation at `Chart<unknown>`.
// ═══════════════════════════════════════════════════════════════════════════

/** What an `ImportedLane` reads back as: every alphabet the bare `string`. */
interface ImportedSpec {
  readonly phases: Readonly<
    Record<string, Readonly<Record<string, ImportedChart>>>
  >;
  readonly terminals: { readonly complete: string; readonly tripped: string };
}

/** The spec a lane was authored from — an imported lane carries none. */
type SpecOf<L> = L extends { readonly spec: infer S } ? S : ImportedSpec;

type Phases<L> = PhasesOf<SpecOf<L>>;

/**
 * `[string] extends [N]` — the alphabet stopped being a union of literals.
 *
 * The same guard `graph.ts` uses to catch a computed string key, here for the
 * opposite reason: an imported chart is DELIBERATELY degenerate, and a subset
 * derived off it (`InitialState`, `SuccessFinal`, `CellEdgeKey`) collapses to
 * `never` rather than to `string`. `never` would be a lie — the imported door
 * knows nothing about those states, it does not know there are none — so every
 * derived subset below is read through {@link StateSubset}, which hands back
 * `string` where the chart cannot be asked.
 */
type IsDegenerate<N> = [string] extends [N] ? true : false;

/** A derived subset of a chart's states — `string` where the chart is imported. */
type StateSubset<C, T> = [IsDegenerate<StateName<C>>] extends [true]
  ? string
  : T;

/** Every phase name, as a union. The ORDER is the value's, not the type's. */
export type LanePhaseName<L> = Extract<keyof Phases<L>, string>;

/** The task ids declared in phase `P`. */
export type LaneTasksIn<L, P extends LanePhaseName<L>> = Extract<
  keyof Phases<L>[P],
  string
>;

/** Every task id in the lane, whatever phase it runs in. */
export type LaneTaskId<L> = {
  [P in LanePhaseName<L>]: LaneTasksIn<L, P>;
}[LanePhaseName<L>];

/** The chart task `T` runs — ITS chart, not a union over the lane's charts. */
export type LaneTaskChart<L, T extends LaneTaskId<L>> = {
  [P in LanePhaseName<L>]: T extends keyof Phases<L>[P]
    ? Phases<L>[P][T]
    : never;
}[LanePhaseName<L>];

/** The phase task `T` runs in. `defineLane` refuses a task with two. */
export type LanePhaseOf<L, T extends LaneTaskId<L>> = {
  [P in LanePhaseName<L>]: T extends keyof Phases<L>[P] ? P : never;
}[LanePhaseName<L>];

/** The tasks running BESIDE `T` — its phase's set, minus itself. */
export type LaneSiblings<L, T extends LaneTaskId<L>> = Exclude<
  LaneTasksIn<L, LanePhaseOf<L, T> & LanePhaseName<L>>,
  T
>;

/** Where task `T`'s fold starts — `initial: true`, off its own chart. */
export type LaneInitial<L, T extends LaneTaskId<L>> = StateSubset<
  LaneTaskChart<L, T>,
  InitialState<LaneTaskChart<L, T>>
>;

/** `end: true` on task `T`'s chart — the endings that let its phase complete. */
export type LaneSuccessFinals<L, T extends LaneTaskId<L>> = StateSubset<
  LaneTaskChart<L, T>,
  SuccessFinal<LaneTaskChart<L, T>>
>;

/** `end: "error"` on task `T`'s chart — the endings that trip the lane. */
export type LaneErrorFinals<L, T extends LaneTaskId<L>> = StateSubset<
  LaneTaskChart<L, T>,
  ErrorFinal<LaneTaskChart<L, T>>
>;

/** The lane's two endings, as a union of the two literals. */
export type LaneTerminal<L> = TerminalsOf<SpecOf<L>>;

/**
 * A phase that is not carrying task states.
 *
 * The vocabulary is the inspector's, on purpose: a phase is `waiting` before
 * the lane reaches it and `complete`/`tripped` after it leaves, and in exactly
 * one of those three readings there is no task map to hold — while it is
 * ACTIVE, the phase IS its tasks' states.
 */
export type PhaseStanding = "waiting" | "complete" | "tripped";

/**
 * The compound state of a whole lane.
 *
 * A lane is not one machine and its state is not one state:
 *
 * ```ts
 * const s: LaneState<typeof lane> = {
 *   phases: {
 *     phase1: { issue_5729: { type: "build", retries: 0, maxRetries: 2 } },
 *     phase2: "waiting",
 *   },
 *   lane: "running",
 * };
 * ```
 *
 * Every leaf is that task's OWN `StateOf<chart>`, narrowed — `issue_5729` may
 * only stand in a state its own chart declares, carrying its own `ctx`. At an
 * imported lane the same formula reads back with `string` throughout.
 */
export type LaneState<L> = {
  readonly phases: {
    readonly [P in LanePhaseName<L>]:
      | PhaseStanding
      | {
          readonly [T in LaneTasksIn<L, P>]: StateOf<Phases<L>[P][T]>;
        };
  };
  /** `running`, or the terminal it ended on. */
  readonly lane: "running" | LaneTerminal<L>;
};

/**
 * One message, addressed to one task of the lane.
 *
 * The union is built PER TASK, not as one alphabet across the lane: the event
 * is narrowed to the events that task's own chart declares, so a message
 * carrying a real event to the wrong task is as much a compile error as one
 * carrying an event nothing declares. A lane of two different chart templates
 * is where that stops being a technicality.
 */
export type LaneMsg<L> = {
  [P in LanePhaseName<L>]: {
    [T in LaneTasksIn<L, P>]: {
      readonly task: T;
      readonly event: EventName<Phases<L>[P][T]>;
    };
  }[LaneTasksIn<L, P>];
}[LanePhaseName<L>];

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
