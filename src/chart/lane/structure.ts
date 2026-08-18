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
  Chart,
  ErrorFinal,
  EventName,
  EventOrigin,
  InitialState,
  StateName,
  StateOf,
  Strict,
  SuccessFinal,
  Total,
  Ty,
} from "../graph";
import type { PhaseStanding } from "../report/fold";
import {
  endPolarityOf,
  type ImportedChart,
  type ImportedEdge,
  type ImportedLane,
  type ImportedNode,
  RETRY_BUDGET,
  statesOf,
} from "../report/workflow";

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

// A NUMERIC KEY IS A KEY. fabrika's task ids are GitHub issue numbers, so
// `{ 5729: coder }` is the obvious spelling of a phase and an author will
// reach for it — but `keyof { 5729: … }` is the NUMBER `5729`, and the older
// `Extract<keyof …, string>` annihilated it: every alphabet the lane derives
// went `never`, no hand was demanded and the CORRECT hand was rejected. So a
// key is normalised to the way every OTHER layer already spells it — the log's
// `task` field, the `${task}.${event}` wire key, `Object.entries` — which is
// as a string. `Keyed` re-keys the record itself so an indexed access lands,
// and both leave a degenerate `Record<string, …>` exactly as degenerate as it
// was, so {@link LaneLiteralAlphabets} below still fires.
// Exported for `./run`, which asks the same question of the HANDS record — one
// spelling of a key in the module, not two.
export type Key<K> = K extends string | number ? `${K}` : never;
export type Keyed<R> = { [K in keyof R as Key<K>]: R[K] };

type TaskIdsIn<P> = { [K in keyof P]: Key<keyof P[K]> }[keyof P];

/**
 * Task ids declared under more than one phase.
 *
 * DEGENERACY-GUARDED, and not for tidiness: `Omit<P, K>` over a `P` with an
 * index signature is `P` again, so at a computed-key phase record this reads
 * every task as declared twice and accuses the author of a duplicate they did
 * not write. {@link LaneLiteralAlphabets} is what actually went wrong there,
 * and it is ordered ahead of this so it is what the author is told.
 */
type DuplicateTasks<P> = [IsDegenerate<TaskIdsIn<P>>] extends [true]
  ? never
  : {
      [K in keyof P]: Extract<Key<keyof P[K]>, TaskIdsIn<Omit<P, K>>>;
    }[keyof P];

/** Phases whose task record is empty — a phase that completes on arrival. */
type EmptyPhases<P> = {
  [K in keyof P]: [keyof P[K]] extends [never] ? Key<K> : never;
}[keyof P];

// ── the lane's own literal-alphabet gate ───────────────────────────────────
//
// `graph.ts` has `__stateNamesMustBeLiteralsNotAComputedStringKey` for exactly
// one failure mode: an alphabet that stopped being a union of literals is not a
// weakened chart, it is a chart with the checking SWITCHED OFF, and nothing
// says so. The lane had no equivalent, and it has the same failure mode one
// level up — `{ [dyn]: coder }` or `Object.fromEntries(ids.map(…))` degrades
// `LaneTaskId` to `string`, so no hand is required, an invented task id is
// accepted and `__laneHandNamesAnUnknownTask` is dead code.
//
// The terminals are in here for the SAME reason and it is worth stating,
// because the way an author reaches it is not exotic: hoisting the terminals to
// a variable without `as const` widens them to `string`, which silently
// disables `__terminalCollidesWithAPhase` and makes `LaneTerminal<L>` the bare
// `string`. Told as "this object lost its literal types", it is one `as const`;
// discovered later, it is a lane whose ending is unnamed.

/** The three alphabets a lane derives, each refused where it degenerated. */
type LaneLiteralAlphabets<S> = ([IsDegenerate<Key<keyof PhasesOf<S>>>] extends [
  true,
]
  ? { readonly __lanePhaseNamesMustBeLiteralsAddAsConst: true }
  : unknown) &
  ([IsDegenerate<TaskIdsIn<PhasesOf<S>>>] extends [true]
    ? { readonly __laneTaskIdsMustBeLiteralsAddAsConst: true }
    : unknown) &
  ([IsDegenerate<TerminalsOf<S>>] extends [true]
    ? { readonly __laneTerminalsMustBeLiteralsAddAsConst: true }
    : unknown);

/**
 * Task ids, or event names, carrying a dot.
 *
 * `${task}.${event}` IS the lane's wire key — `runLane` compiles each region
 * under `ns = taskId` and `foldLane` splits an incoming name at the FIRST dot —
 * so a dot on either side re-partitions the key space. Task `a` + event `b.GO`
 * and task `a.b` + event `GO` both register `"a.b.GO"`: last writer wins, one
 * task's event is unreachable forever, and a message addressed to `a` moves
 * `a.b`. And task `epic.issue_1` emits a log line the splitter can never route
 * back. Banning the dot makes the collision unrepresentable for every pairing
 * at once, which is the same move `graph.ts` makes for a foreign event name and
 * for a state name.
 */
type DottedTaskIds<P> = Extract<TaskIdsIn<P>, `${string}.${string}`>;

type DottedEventTasks<P> = {
  [K in keyof P]: {
    [T in keyof P[K]]: [IsDegenerate<EventName<P[K][T]>>] extends [true]
      ? never
      : [Extract<EventName<P[K][T]>, `${string}.${string}`>] extends [never]
        ? never
        : Key<T>;
  }[keyof P[K]];
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

/**
 * Task ids whose chart hands a transition to a hand-written cell.
 *
 * Degeneracy-guarded like its two siblings below: `CellEdgeKey` over an
 * imported chart is `never` for the same reason it is `never` over a chart with
 * no cell edge, and reading the first as the second is how a check that cannot
 * be asked pretends to have been answered. It happens to be the SAFE direction
 * here — the answer is "no cell", which is what the imported door always
 * says — but a check that is right by luck is a check that stops being right.
 */
type CellDelegatingTasks<P> = {
  [K in keyof P]: {
    [T in keyof P[K]]: [IsDegenerate<StateName<P[K][T]>>] extends [true]
      ? never
      : [CellEdgeKey<P[K][T]>] extends [never]
        ? never
        : Key<T>;
  }[keyof P[K]];
}[keyof P];

/** Task ids whose chart marks no `initial: true` — the fold has no zero. */
type NoInitialTasks<P> = {
  [K in keyof P]: {
    [T in keyof P[K]]: [IsDegenerate<StateName<P[K][T]>>] extends [true]
      ? never
      : [InitialState<P[K][T]>] extends [never]
        ? Key<T>
        : never;
  }[keyof P[K]];
}[keyof P];

/**
 * Task ids whose chart marks MORE THAN ONE `initial: true`.
 *
 * Zero and two are both wrong and only zero was caught. Two is the worse of
 * the pair, because it does not fail — it splits: `laneShape` walked the states
 * and kept the LAST one it saw, `initialOf` (and therefore the fold, and
 * therefore every report) takes the FIRST, so the report printed a start state
 * the fold never booted into. `graph.ts` refuses the same thing on a single
 * chart with `__chartDeclaresManyInitialStates`; the lane door had dropped it,
 * because a lane region's entry is per-INSTANCE (`boot()`) and the check that
 * used to sit on the chart's own `InitialData` went with it.
 */
type ManyInitialTasks<P> = {
  [K in keyof P]: {
    [T in keyof P[K]]: [IsDegenerate<StateName<P[K][T]>>] extends [true]
      ? never
      : [IsUnion<InitialState<P[K][T]>>] extends [true]
        ? Key<T>
        : never;
  }[keyof P[K]];
}[keyof P];

/** Task ids whose chart declares no final — its phase could never complete. */
type NoFinalTasks<P> = {
  [K in keyof P]: {
    [T in keyof P[K]]: [IsDegenerate<StateName<P[K][T]>>] extends [true]
      ? never
      : [SuccessFinal<P[K][T]> | ErrorFinal<P[K][T]>] extends [never]
        ? Key<T>
        : never;
  }[keyof P[K]];
}[keyof P];

/** `graph.ts`'s own union test — a `T` that is not a single member. */
type IsUnion<T, U = T> = T extends unknown
  ? [U] extends [T]
    ? false
    : true
  : never;

// ── the guarded edge, and the one predicate a lane can fold ────────────────
//
// THE FOLD OWNS THE GUARD. `report/fold.ts` walks a guarded edge with the one
// inline predicate `retries < maxRetries`, because a `workflow.json` carries a
// guard NAME and never a guard BODY — the array IS the retry guard, in fabrika
// and here. That is exactly right for the imported door and it was applied,
// unstated, to the typed one as well: `lowerRegion` kept the name and dropped
// everything else, so a chart guarded on `amount < 100` and driven with
// `amount: 5000` RAN to `declined` and FOLDED to `captured` — a tripped run
// reported complete, with a `retries: 1/2` invented on a chart that has no
// retry concept.
//
// Carrying the real predicate onto the lowered edge is the fix that would cost
// the typed door nothing, and it is not available: a `defineChart` guard's BODY
// lives in `Parts`, which is handed to `compile`/`runLane` and which
// `defineLane` never sees. There is no seam at which the fold could be given
// it, so a lane whose guard is not the retry guard is a lane this module cannot
// fold — and the honest move is to refuse it at the door rather than to answer
// it wrongly in a report.
//
// What IS checkable is the contract the fold's predicate is written against:
// the region's `ctx` carries the two numbers it reads. That is necessary and
// not sufficient (a guard body could still be about something else while the
// budget rides along), so the marker names the contract rather than claiming to
// have read the author's mind — but it catches the case the reviewer found,
// where a lane region reaches for `when` meaning something the lane cannot see.

/** A chart's `ctx`, as declared — the `Ty<…>` payload, unwrapped. */
type LaneCtxOf<C> = C extends { readonly ctx: Ty<infer T> } ? T : unknown;

/** Does any of `C`'s edges carry a `when`? */
type HasGuardedEdge<C> = C extends { readonly states: infer G }
  ? {
      [P in keyof G]: {
        [S in keyof G[P]]: G[P][S] extends { readonly on: infer O }
          ? {
              [E in keyof O]: O[E] extends { readonly when: string }
                ? true
                : never;
            }[keyof O]
          : never;
      }[keyof G[P]];
    }[keyof G]
  : never;

/** The budget the fold's guarded arm reads, and the only shape it can read. */
type RetryBudgetCtx = { readonly retries: number; readonly maxRetries: number };

/** Task ids that guard an edge on something the fold cannot evaluate. */
type GuardsOffTheBudgetTasks<P> = {
  [K in keyof P]: {
    [T in keyof P[K]]: [IsDegenerate<StateName<P[K][T]>>] extends [true]
      ? never
      : [HasGuardedEdge<P[K][T]>] extends [never]
        ? never
        : LaneCtxOf<P[K][T]> extends RetryBudgetCtx
          ? never
          : Key<T>;
  }[keyof P[K]];
}[keyof P];

/**
 * Task ids whose region never went through `defineChart`.
 *
 * `LaneRegion` is the structural minimum BOTH doors satisfy, which is what lets
 * one type parameter carry either — and it is also a hole: a hand-written
 * object of that shape passes it, so `Strict` and `Total` never run, a typo'd
 * target is never checked, and the fold lands the task in a state that does not
 * exist and leaves it there forever with no diagnostic. A brand stamped by
 * `defineChart` would be the tighter fix; it is not available from here, since
 * that would change `defineChart`'s own return type. So the region is put
 * through the checking door FROM here instead: a chart that satisfies its own
 * F-bounded constraint plus `Strict` and `Total` is a chart `defineChart` would
 * have accepted, whatever produced it, and one that does not is refused by the
 * name of the door it skipped.
 *
 * Stands down at the imported door, where `Chart<C>` is not a question an
 * `ImportedChart` can be asked.
 */
type UncheckedRegionTasks<P> = {
  [K in keyof P]: {
    [T in keyof P[K]]: [IsDegenerate<StateName<P[K][T]>>] extends [true]
      ? never
      : [P[K][T]] extends [Chart<P[K][T]> & Strict<P[K][T]> & Total<P[K][T]>]
        ? never
        : Key<T>;
  }[keyof P[K]];
}[keyof P];

type PhasesOf<S> = S extends { readonly phases: infer P } ? P : never;
type TerminalsOf<S> = S extends {
  readonly terminals: { readonly complete: infer C; readonly tripped: infer T };
}
  ? C | T
  : never;
type RetryKeysOf<S> = S extends { readonly retries: infer R }
  ? Key<keyof R>
  : never;

/**
 * The authoring mistakes assignability can catch — the lane's own shape, and
 * the charts it was handed.
 *
 * THE ORDER IS LOAD-BEARING. {@link LaneLiteralAlphabets} comes first because
 * every check under it is a question about a union of literals, and at a
 * degenerate alphabet those questions do not merely go unanswered — they answer
 * WRONGLY. With two phases and a computed task key the old order accused the
 * author of `__taskDeclaredInTwoPhases` for a task declared exactly once, which
 * is a diagnostic that sends them looking in the one place the mistake is not.
 * A check that cannot be asked stands down; a check that would lie is ordered
 * behind the one that names the real cause.
 *
 * The chart-shaped ones stand down at the imported door, where the answer would
 * be a guess rather than a fact, and {@link defineLane}'s runtime checks catch
 * what they can there instead. Where a guarantee cannot be had, it is thrown
 * for rather than pretended.
 */
export type LaneChecks<S> = LaneLiteralAlphabets<S> &
  ([DuplicateTasks<PhasesOf<S>>] extends [never]
    ? unknown
    : {
        readonly __taskDeclaredInTwoPhases: DuplicateTasks<PhasesOf<S>>;
      }) &
  ([EmptyPhases<PhasesOf<S>>] extends [never]
    ? unknown
    : { readonly __phaseDeclaresNoTasks: EmptyPhases<PhasesOf<S>> }) &
  ([Extract<TerminalsOf<S>, Key<keyof PhasesOf<S>>>] extends [never]
    ? unknown
    : {
        readonly __terminalCollidesWithAPhase: Extract<
          TerminalsOf<S>,
          Key<keyof PhasesOf<S>>
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
  ([DottedTaskIds<PhasesOf<S>>] extends [never]
    ? unknown
    : { readonly __laneTaskIdCannotContainADot: DottedTaskIds<PhasesOf<S>> }) &
  ([DottedEventTasks<PhasesOf<S>>] extends [never]
    ? unknown
    : {
        readonly __laneRegionEventNameCannotContainADot: DottedEventTasks<
          PhasesOf<S>
        >;
      }) &
  ([UncheckedRegionTasks<PhasesOf<S>>] extends [never]
    ? unknown
    : {
        readonly __laneRegionDidNotComeThroughDefineChart: UncheckedRegionTasks<
          PhasesOf<S>
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
  ([ManyInitialTasks<PhasesOf<S>>] extends [never]
    ? unknown
    : {
        readonly __laneTaskChartMarksManyInitialStates: ManyInitialTasks<
          PhasesOf<S>
        >;
      }) &
  ([GuardsOffTheBudgetTasks<PhasesOf<S>>] extends [never]
    ? unknown
    : {
        readonly __laneRegionGuardsOnSomethingOtherThanTheRetryBudget: GuardsOffTheBudgetTasks<
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
 * bare target, the target with cmds, the guarded pair, and `resume`. The fifth
 * — `{ to, cell }` — does not: a cell picks its target in hand-written code at
 * runtime, and a lane region has no runtime to pick with. That is refused, here
 * and in the types.
 *
 * The cmds ride along. They were dropped once as "the RUN's business, not the
 * topology's", and the cost showed up on the page: every reader downstream
 * (`readEdgeCore`, `EventPreview`, `outcomeOf`) already renders them, so a lane
 * built from literals could say a click lands on `build` and never that it
 * fires `spawn_shell` — information the author wrote down and the lowering
 * threw away.
 */
const lowerEdge = (edge: unknown): ImportedEdge | undefined => {
  if (typeof edge === "string") return { target: edge };
  if (!isRecord(edge)) return undefined;
  if (isRecord(edge.resume) && typeof edge.resume.fallback === "string") {
    return { resume: { fallback: edge.resume.fallback } };
  }
  if (typeof edge.target !== "string") return undefined;
  const target = edge.target;
  const cmds = {
    ...(edge.cmd === undefined ? {} : { cmd: edge.cmd as string | string[] }),
    ...(edge.otherwiseCmd === undefined
      ? {}
      : { otherwiseCmd: edge.otherwiseCmd as string | string[] }),
  };
  return typeof edge.when === "string" && typeof edge.otherwise === "string"
    ? { target, when: edge.when, otherwise: edge.otherwise, ...cmds }
    : { target, ...cmds };
};

/**
 * A chart from EITHER door → the single `ImportedChart` representation.
 *
 * Idempotent on an imported chart (every edge is already in the lowered form
 * and every event is already `scope: "edges"`), which is what makes this a
 * lowering rather than a second code path: the imported door goes through it
 * and comes out the value it went in as.
 */
const isString = (v: unknown): v is string => typeof v === "string";

/** `compile`'s own reading of `scope`: a word, or a list of them. */
const scopeList = (scope: unknown): readonly string[] =>
  typeof scope === "string"
    ? [scope]
    : Array.isArray(scope)
      ? scope.filter(isString)
      : ["edges"];

/**
 * The events `state` ACCEPTS AND DROPS — the refusal set, read off the chart
 * once at lowering instead of asked at dispatch.
 *
 * THE DIVERGENCE THIS CLOSES. `compile.ts` self-loops a pair the state's
 * `ignore` names or the event's `scope` does not address, and throws only on a
 * live-but-undecided pair. The lowered chart could not say "refused", so
 * `stepTask` threw on a log `runLane` had accepted — a report calling a run
 * unreplayable when the run had replayed it. The fold cannot ask the chart at
 * dispatch time (its states are `string` by then), so the answer is computed
 * here and carried.
 *
 * WHAT IS AND IS NOT IN THE SET, because the boundary is the whole design. A
 * refusal the chart DECLARES is carried: an `ignore` entry, and an event whose
 * `scope` names phases that do not include this state's. An `"edges"` event
 * that this state simply does not route is NOT — `graph.ts` is explicit that
 * such a pair is "not ignored, it is simply not addressed to that state", and
 * making it a refusal here would change the IMPORTED door, where every event is
 * `scope: "edges"` by construction: a `workflow.json` log naming an unrouted
 * event would stop being refused, which is precisely the check fabrika's own
 * fold keeps and `fold.test.ts` pins. So the rule is exactly the one an
 * imported chart cannot trigger, and lowering an imported chart is still the
 * identity.
 */
const refusalsAt = (
  region: LaneRegion,
  group: string,
  node: Readonly<Record<string, unknown>>,
  routed: ReadonlySet<string>,
): readonly string[] => {
  const ignored = new Set(
    Array.isArray(node.ignore) ? node.ignore.filter(isString) : [],
  );
  const isFinal = node.end !== undefined;
  const out: string[] = [];
  for (const [event, decl] of Object.entries(region.events)) {
    if (routed.has(event)) continue;
    const scope = scopeList(isRecord(decl) ? decl.scope : undefined);
    // "edges" is not a phase, so an "edges" event is addressed to no state by
    // broadcast — and that is the case left OUT. What is refused is an event
    // broadcast SOMEWHERE ELSE, an event broadcast HERE at a state that is
    // final (a final accepts nothing and owes nothing, which is why `Total`
    // exempts it from the pair and why `compile` self-loops it), or an event
    // this state's `ignore` names.
    const broadcast = scope.some((s) => s !== "edges");
    const live = scope.some((s) => s === "all" || s === group);
    if (ignored.has(event) || (broadcast && (!live || isFinal))) {
      out.push(event);
    }
  }
  return out;
};

const lowerRegion = (
  taskId: string,
  region: LaneRegion,
  defects: string[],
): ImportedChart => {
  const states: Record<string, Record<string, ImportedNode>> = {};
  const refusals: Record<string, readonly string[]> = {};
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
      const refused = refusalsAt(region, group, node, new Set(Object.keys(on)));
      if (refused.length > 0) refusals[name] = refused;
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

  // `from` RIDES THROUGH. The lowering drops what a lane cannot use — payload
  // types, cmds, ctx, and the phase dimension a region does not have — but
  // provenance is not one of those: it is the whole basis of "what is this
  // waiting on" and of the `awaiting-world` stuck kind, and dropping it made
  // the TYPED door strictly worse than the imported one, which carries a
  // provenance map from its boundary. The imported door states it once at
  // import; the typed door states it once on the event. Same fact, one site
  // each, and neither is this function's to invent.
  const events: Record<
    string,
    { readonly scope: "edges"; readonly from?: EventOrigin }
  > = {};
  for (const [name, decl] of Object.entries(region.events)) {
    const from = isRecord(decl)
      ? (decl.from as EventOrigin | undefined)
      : undefined;
    events[name] = {
      scope: "edges",
      ...(from === undefined ? {} : { from }),
    };
  }

  return {
    events,
    states,
    ...(Object.keys(refusals).length > 0 ? { refusals } : {}),
  };
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
      const initials = nodes.filter((node) => node.initial === true).length;
      if (initials === 0) {
        defects.push(
          `task "${taskId}": its chart marks no state \`initial: true\` — the fold has no zero to start from`,
        );
      }
      // TWO is as wrong as zero, and it is the worse of the pair because it
      // does not fail — it SPLITS. `laneShape` and `initialOf` walk the same
      // states and disagree about which one they mean, so the report prints a
      // start state the fold never booted into. Refused here as well as in the
      // types, because the imported door has no marker to stand behind.
      if (initials > 1) {
        defects.push(
          `task "${taskId}": its chart marks ${initials} states \`initial: true\` — a fold has one zero, and which one it picks would be an accident of key order`,
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

/**
 * The lane's phases, keyed the way every other layer keys them: by strings.
 *
 * A phase or a task written as a number (`{ 5729: coder }` — and fabrika's task
 * ids ARE GitHub issue numbers) is a key like any other; it is only `keyof`
 * that hands it back as a number. Normalising here, ONCE, is what lets every
 * derivation below stay the plain formula it was.
 */
type Phases<L> = Keyed<PhasesOf<SpecOf<L>>>;

/** The tasks of phase `P`, keyed by string for the same reason. */
type TasksOf<L, P extends LanePhaseName<L>> = Keyed<Phases<L>[P]>;

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
  keyof TasksOf<L, P>,
  string
>;

/** Every task id in the lane, whatever phase it runs in. */
export type LaneTaskId<L> = {
  [P in LanePhaseName<L>]: LaneTasksIn<L, P>;
}[LanePhaseName<L>];

/** The chart task `T` runs — ITS chart, not a union over the lane's charts. */
export type LaneTaskChart<L, T extends LaneTaskId<L>> = {
  [P in LanePhaseName<L>]: T extends keyof TasksOf<L, P>
    ? TasksOf<L, P>[T]
    : never;
}[LanePhaseName<L>];

/** The phase task `T` runs in. `defineLane` refuses a task with two. */
export type LanePhaseOf<L, T extends LaneTaskId<L>> = {
  [P in LanePhaseName<L>]: T extends keyof TasksOf<L, P> ? P : never;
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
 * ONE TYPE, TWO NAMES, and it used to be two types with ONE name: this and
 * `report/fold.ts`'s {@link PhaseStanding} were both exported as
 * `PhaseStanding` from two entry points with different members, so which one a
 * reader got depended on which module they happened to import. It is a
 * SUBSET, so it is spelled as one — the phase standings minus the one reading
 * in which the phase IS its tasks' states, which is exactly why `LaneState`'s
 * phase leaf cannot hold `"active"`: while a phase is active there is a task
 * map there instead.
 */
export type PhaseAtRest = Exclude<PhaseStanding, "active">;

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
      | PhaseAtRest
      | {
          readonly [T in LaneTasksIn<L, P>]: StateOf<TasksOf<L, P>[T]>;
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
      readonly event: EventName<TasksOf<L, P>[T]>;
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
      // THE FIRST, not the last — `initialOf` (and therefore the fold, and
      // therefore every report built on it) takes the first, and a reader that
      // took the last printed a start state the fold never booted into.
      // `defineLane` refuses a chart with two, so on an authored lane the two
      // readings coincide; on an imported one this is the tie-break that keeps
      // the shape and the fold saying the same word.
      let initial = "";
      for (const [name, node] of statesOf(chart)) {
        if (node.initial === true && initial === "") initial = name;
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
