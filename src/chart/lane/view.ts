// ═══════════════════════════════════════════════════════════════════════════
// THE LANE, AS ONE SCREEN'S WORTH OF DATA — two sources, one model.
//
// `inspectLane` already answers every question about a lane at ONE moment.
// A screen needs two things on top of that, and neither is a new question about
// the lane:
//
//   WHICH MOMENT.  Both sources can be asked for the state at step k, and both
//                  answer it EXACTLY: a folded log is pure over a prefix
//                  (`fold.ts`), and a recorded run re-folds a prefix through
//                  `replay`. So "the scrubber" is one field — `leavesAt` — and
//                  the two sources differ only in how they implement it.
//
//   WHAT IS ON OFFER.  A fabrika lane is already-run history: there are no code
//                  bodies anywhere, so nothing can be dispatched, ever. A lane
//                  under `runLane` has them, so its controls are live. That is
//                  the ONLY behavioural difference between the two sources, and
//                  it is carried as a value on every control rather than as a
//                  branch in the view: a control that cannot be sent holds an
//                  {@link Unanswerable} saying why, so the component renders the
//                  reason instead of quietly rendering nothing.
//
// THE EDITORIAL RULES ARE `report.ts`'s, AND THEY ARE NOT RELEARNED HERE.
// A real emitted phase holds eight tasks and six of them sit untouched at their
// entry state; a wall of near-identical diagrams is exactly as useless in a
// browser as in a PR comment. So this model marks each task `moved` and each
// phase's `expanded` set, by the same rule the markdown applies — with the one
// concession the medium earns: a screen can put the collapsed tasks' diagrams
// behind a disclosure instead of dropping them, which a comment cannot.
//
// THE FIRST QUESTION ABOUT A STUCK EPIC IS *WHICH* OF TWELVE THINGS IS STUCK.
// `stuck` is therefore the model's first field and the view's first panel, and
// it is `inspectLane`'s own list — not a second definition of stuck.
//
// PURE AND FRAMEWORK-FREE, like every other headless half in this module. React
// is in `./react`; a script or a TUI gets everything below with no DOM.
// ═══════════════════════════════════════════════════════════════════════════

import type { EventPreview, InspectOptions, Unanswerable } from "../inspect";
import { drawTask, walkedEdges } from "../report/draw";
import {
  foldLane,
  type LogEntry,
  type PhaseStanding,
  type TaskState,
  timeline,
  walkedEdgeKey,
} from "../report/fold";
import {
  bareEvent,
  type ImportedChart,
  type ImportedLane,
  initialOf,
  RETRY_BUDGET,
  statesOf,
} from "../report/workflow";
import { inspectLaneStates, type StuckReason } from "./inspect";

// ═══════════════════════════════════════════════════════════════════════════
// THE DRAWING SEAM — one call, and it is deliberately the only one.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * One task's region, drawn: the current node lit, the walked edges marked.
 *
 * THE WHOLE MODULE DRAWS THROUGH THIS ONE FUNCTION, and its body is one call.
 * `report/draw.ts`'s own banner says `drawTask` is itself a seam standing in for
 * `chartMermaid`'s option-taking form; when that fold lands, THIS body becomes
 * the new call and nothing else in the lane view changes — not the model, not
 * the component, not the stylesheet. That is the point of routing every drawing
 * through a single private function rather than calling the drawer from the
 * three places that want a picture.
 */
const draw = (
  chart: ImportedChart,
  current: string,
  walked: ReadonlyMap<string, number>,
): string => drawTask(chart, { current, walked });

/** Does this chart route `event` out of `from`, or is a step there a no-op? */
function declaresEdge(
  chart: ImportedChart | undefined,
  from: string,
  event: string,
): boolean {
  if (chart === undefined) return true;
  return statesOf(chart).get(from)?.on?.[bareEvent(event)] !== undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// THE MODEL
// ═══════════════════════════════════════════════════════════════════════════

/** A task's retry bookkeeping, when the source carries it. */
export interface RetryBudget {
  readonly retries: number;
  readonly maxRetries: number;
}

/**
 * One event control, for one task.
 *
 * `send` is where the two sources part company, and it is a VALUE rather than a
 * flag: the answer to "what would clicking this dispatch" is the msg itself, so
 * a source that can answer it answers with the msg, and a source that cannot
 * holds the reason. There is no third state and no boolean to get backwards.
 */
export interface LaneControl {
  readonly task: string;
  readonly event: string;
  /** `"legal"`, or the refusal's kind — the CSS hook, as in `<ChartInspector>`. */
  readonly kind: string;
  readonly refused: boolean;
  /** The refusal's one-line explanation. Present iff refused. */
  readonly why?: string;
  /** Where this would land and what it would fire — the DECLARED answer. */
  readonly outcome: string;
  /** The msg a click dispatches, or why this source cannot offer one. */
  readonly send: { readonly type: string } | Unanswerable<"dispatch">;
}

/** One task of the lane, at the scrubbed moment. */
export interface LaneTaskView {
  readonly task: string;
  readonly phase: string;
  readonly state: string;
  readonly endPolarity: false | true | "error";
  /** The state it resumes to while parked. */
  readonly was?: string;
  /** Grouped by who sends them — `report.ts`'s own derivation. `null` at a final. */
  readonly waitingOn: string | null;
  readonly stuck: StuckReason | null;
  /**
   * `false` while the task still sits at its chart's entry state.
   *
   * The editorial rule's input: a task that has not moved has a story one line
   * long, and six of them side by side are six copies of one picture.
   */
  readonly moved: boolean;
  readonly budget: RetryBudget | Unanswerable<"retries">;
  readonly controls: readonly LaneControl[];
  /** This region, drawn at this moment. See {@link draw}. */
  readonly diagram: string;
}

/** One phase of the lane, at the scrubbed moment. */
export interface LanePhaseView {
  readonly name: string;
  readonly index: number;
  readonly standing: PhaseStanding;
  readonly tasks: readonly LaneTaskView[];
  /** The tasks in this phase sitting on an error final. */
  readonly tripped: readonly string[];
  /**
   * The tasks worth showing in full, by id — `report.ts`'s rule, applied.
   *
   * Only the ACTIVE phase expands anything: a finished phase's story is which
   * ending each of its tasks reached, and a phase that never started has no
   * story at all. Within the active phase, a task that has moved is expanded and
   * a task still at its entry state is not — unless NOTHING in the phase has
   * moved, in which case the first is the representative, because collapsing
   * every task would leave the reader with no picture at all.
   */
  readonly expanded: readonly string[];
}

/** One step of the run, as the timeline table draws it. */
export interface LaneStepView {
  readonly index: number;
  readonly task: string;
  /** The event VERBATIM — the source's own spelling. */
  readonly event: string;
  readonly from: string;
  readonly to: string;
  /** The edge that fired, keyed as the drawing keys it. */
  readonly edge: string;
  /**
   * The msg arrived and NOTHING happened — the chart routes no such edge here.
   *
   * A total chart answers every msg, so a refused one is still a line in the
   * log and still a step of the tape; it is just not a WALK. Left unmarked it
   * reads as a real transition that happened to land where it started
   * (`issue_1 DONE review → review`), which is the one row on the timeline a
   * reader would take at face value and be wrong about.
   */
  readonly refused: boolean;
}

/** A whole lane, at one moment, ready to render. */
export interface LaneViewModel {
  readonly source: "replay" | "live";
  readonly title: string;
  readonly status: "active" | "done";
  /** The terminal it landed on, or `null` while it is still running. */
  readonly terminal: string | null;
  readonly activePhase: string | null;
  /** Every task on an error final, lane-wide. */
  readonly tripped: readonly string[];
  /**
   * WHICH OF TWELVE THINGS IS STUCK — the reader's first question, answered
   * first. `inspectLane`'s own list, with the phase attached so the answer names
   * a place as well as a task.
   */
  readonly stuck: readonly {
    readonly task: string;
    readonly phase: string;
    readonly reason: StuckReason;
  }[];
  readonly phases: readonly LanePhaseView[];
  /** Every step up to the cursor. */
  readonly steps: readonly LaneStepView[];
  /**
   * When each step happened, indexed by step — or why this source cannot say.
   *
   * A fabrika log stamps every line. A recorded tape carries ORDER and nothing
   * else, so the live source answers this with the reason rather than with a
   * column of invented times.
   */
  readonly clock: readonly string[] | Unanswerable<"clock">;
  readonly cursor: number;
  readonly total: number;
  /** `true` while the cursor is behind the present. */
  readonly scrubbed: boolean;
  /**
   * Why THIS SOURCE can dispatch nothing at all — absent on a source that can.
   *
   * A fact about the source, so it is stated once by the source rather than
   * scraped back off whichever control still happens to carry it. Scraping is
   * what it used to be, and it went silent on exactly the lane that needed it
   * most: on a finished lane every control is refused BY THE CHART, so the one
   * sentence explaining why the whole page is dead had nowhere left to live.
   */
  readonly noDispatch?: Unanswerable<"dispatch">;
}

// ═══════════════════════════════════════════════════════════════════════════
// THE SOURCE SEAM — the four things a source decides, and nothing else.
// ═══════════════════════════════════════════════════════════════════════════

/** Every region's leaf, keyed by task. */
export type LaneLeaves = Readonly<Record<string, TaskState>>;

/**
 * What a lane view is fed. Two implementations, {@link replayFeed} and
 * {@link liveFeed}, and the component branches on none of it.
 */
export interface LaneFeed {
  readonly kind: "replay" | "live";
  readonly lane: ImportedLane;
  /** How many steps have happened — the scrubber's extent. */
  readonly total: number;
  /** Every region's leaf after the first `n` steps. EXACT, on both sides. */
  readonly leavesAt: (n: number) => LaneLeaves;
  /** The steps, in order. */
  readonly steps: readonly LaneStepView[];
  /** {@link LaneViewModel.clock}. */
  readonly clock: readonly string[] | Unanswerable<"clock">;
  /** The retry budget, or why this source cannot state it. */
  readonly budget: (
    task: string,
    leaves: LaneLeaves,
  ) => RetryBudget | Unanswerable<"retries">;
  /** The `parts` bag and samples, per task. Absent where there are none. */
  readonly optsFor?: (task: string) => InspectOptions;
  /**
   * What a click dispatches — or why this source offers no click.
   *
   * The task is a parameter because a lane's dispatch surface is addressed:
   * `compile(chart, parts, taskId)` keys the table `${task}.${event}`, so the
   * msg a control sends is the region's event WEARING its task. The preview's
   * own `msg` is the bare one; namespacing it is the feed's job, once.
   */
  readonly send: (task: string, preview: EventPreview) => LaneControl["send"];
  /** {@link LaneViewModel.noDispatch} — set it iff NO control of this source can be sent. */
  readonly noDispatch?: Unanswerable<"dispatch">;
}

const NO_DISPATCH: Unanswerable<"dispatch"> = {
  answerable: false,
  question: "dispatch",
  why: "this lane is a workflow document and its event log — the code bodies that would run an edge do not exist here, so no control can be sent. The log is the only thing that moves it.",
};

const NO_CLOCK: Unanswerable<"clock"> = {
  answerable: false,
  question: "clock",
  why: "a recorded tape carries the ORDER of the msgs and no wall-clock — an events log stamps every line, a running machine does not",
};

const NO_RETRIES: Unanswerable<"retries"> = {
  answerable: false,
  question: "retries",
  why: "this region's own state carries no `retries` — the retry budget is a fact of the state a chart chose to keep, and this one keeps none",
};

/** No sample for this event's payload — the one honest "cannot" a LIVE lane has. */
const noSample = (event: string): Unanswerable<"dispatch"> => ({
  answerable: false,
  question: "dispatch",
  why: `no sample for \`${event}\`'s payload — \`ty<T>()\` is \`{}\` at runtime, so the shape cannot be derived and the msg cannot be built`,
});

// ── the replay feed ───────────────────────────────────────────────────────

/**
 * THE FABRIKA CASE: a lane plus the log it actually produced.
 *
 * Every field is the report module's own function. The scrubber is
 * `foldLane(lane, entries.slice(0, n))`, which is not an approximation of the
 * state at step n — it is the definition of it.
 */
export function replayFeed(
  lane: ImportedLane,
  entries: readonly LogEntry[],
): LaneFeed {
  const steps = timeline(lane, entries);
  return {
    kind: "replay",
    lane,
    total: entries.length,
    leavesAt: (n) => foldLane(lane, entries.slice(0, n)),
    // NEVER REFUSED, and that is a property of this source rather than of this
    // log: `foldLane` throws `UnreplayableLogError` on a line the chart routes
    // nowhere, so a log holding a refused msg does not produce a lane view at
    // all. A recorded TAPE is the opposite — a click that no-ops is a msg like
    // any other — which is where the mark earns its keep.
    steps: steps.map(({ at: _at, ...rest }) => ({ ...rest, refused: false })),
    clock: steps.map((s) => s.at),
    budget: (task, leaves) => {
      const leaf = leaves[task];
      return leaf === undefined
        ? NO_RETRIES
        : { retries: leaf.retries, maxRetries: leaf.maxRetries };
    },
    // No `optsFor`: a document carries no guard bodies and no payload samples,
    // and the previews degrade to exactly that.
    send: () => NO_DISPATCH,
    noDispatch: NO_DISPATCH,
  };
}

// ── the live feed ─────────────────────────────────────────────────────────

/** A running region's leaf: a state name, plus whatever ctx that chart keeps. */
export type RunningLeaf = { readonly type: string } & Readonly<
  Record<string, unknown>
>;

/** What {@link liveFeed} needs from the runtime it is watching. */
export interface LiveFeedInput {
  /**
   * The regions after the first `n` recorded msgs, by PURE replay — `init` +
   * `update` only, exactly as `<ChartInspector>`'s scrubber does it.
   */
  readonly regionsAt: (n: number) => Readonly<Record<string, RunningLeaf>>;
  /** The recorded tape: `${task}.${event}` per step, in order. */
  readonly msgs: readonly { readonly type: string }[];
  /** The `parts` bag and samples, per task — the hands the run was given. */
  readonly optsFor?: (task: string) => InspectOptions;
}

const numberAt = (leaf: RunningLeaf, key: string): number | undefined =>
  typeof leaf[key] === "number" ? (leaf[key] as number) : undefined;

/**
 * THE RUNNING CASE: a lane under `runLane`, watched.
 *
 * The leaves come off the RUNTIME rather than off a fold, and that distinction
 * is load-bearing: `runLane` boots each region where its sub-issue actually is,
 * so a fold that started every task at its chart's `initial: true` would draw a
 * different lane than the one running.
 *
 * The steps are derived from the same replay: `from` is the leaf before the msg
 * and `to` is the leaf after, both exact, and the edge they walked is
 * {@link walkedEdgeKey} — the fold's own answer, so the live drawing thickens
 * the same edges the markdown would.
 */
export function liveFeed(lane: ImportedLane, input: LiveFeedInput): LaneFeed {
  // One replay per prefix, memoized: the steps below read every prefix, and
  // re-folding inside the loop would be quadratic for no reason.
  const prefixes: Readonly<Record<string, RunningLeaf>>[] = [];
  for (let n = 0; n <= input.msgs.length; n += 1) {
    prefixes.push(input.regionsAt(n));
  }

  const tasks = Object.keys(lane.charts);
  /** `${task}.${event}` → the pair, split at the task the LANE declares. */
  const address = (
    type: string,
  ): { readonly task: string; readonly event: string } | undefined => {
    for (const task of tasks) {
      if (type.startsWith(`${task}.`)) {
        return { task, event: type.slice(task.length + 1) };
      }
    }
    return undefined;
  };

  // Whether a region's state carries `retries` at all is a property of the
  // chart's ctx, not of where the run got to — so it is read ONCE, off the boot
  // leaves, rather than discovered as the scrubber wanders past a task.
  const carriesRetries = new Set<string>();
  for (const [task, leaf] of Object.entries(prefixes[0] ?? {})) {
    if (numberAt(leaf, "retries") !== undefined) carriesRetries.add(task);
  }

  const steps: LaneStepView[] = [];
  for (const [index, msg] of input.msgs.entries()) {
    const at = address(msg.type);
    const chart = at === undefined ? undefined : lane.charts[at.task];
    const before = at === undefined ? undefined : prefixes[index]?.[at.task];
    const after = at === undefined ? undefined : prefixes[index + 1]?.[at.task];
    if (at === undefined || chart === undefined) continue;
    if (before === undefined || after === undefined) continue;
    steps.push({
      index,
      task: at.task,
      event: at.event,
      from: before.type,
      to: after.type,
      edge: walkedEdgeKey(chart, before.type, at.event, after.type),
      refused: !declaresEdge(chart, before.type, at.event),
    });
  }

  const leavesAt = (n: number): LaneLeaves => {
    const regions =
      prefixes[Math.max(0, Math.min(n, prefixes.length - 1))] ?? {};
    const out: Record<string, TaskState> = {};
    for (const [task, leaf] of Object.entries(regions)) {
      out[task] = {
        // THE REGION'S OWN CTX, CARRIED. `TaskState` names the four fields the
        // FOLD needs, and a running region is a whole state: the guards a live
        // preview evaluates are `(state, msg) => …` over that state, so a leaf
        // narrowed to its four bookkeeping fields makes every guard read
        // `undefined` and answer with its `otherwise` arm. The extra keys are
        // invisible to a `TaskState` reader and exactly what a guard came for.
        ...leaf,
        type: leaf.type,
        retries: numberAt(leaf, "retries") ?? 0,
        maxRetries:
          numberAt(leaf, "maxRetries") ??
          lane.context[task]?.maxRetries ??
          RETRY_BUDGET,
        ...(typeof leaf.was === "string" ? { was: leaf.was } : {}),
      };
    }
    return out;
  };

  return {
    kind: "live",
    lane,
    total: input.msgs.length,
    leavesAt,
    steps,
    clock: NO_CLOCK,
    budget: (task, leaves) => {
      const leaf = leaves[task];
      if (leaf === undefined || !carriesRetries.has(task)) return NO_RETRIES;
      return { retries: leaf.retries, maxRetries: leaf.maxRetries };
    },
    ...(input.optsFor === undefined ? {} : { optsFor: input.optsFor }),
    // The code bodies exist, so the only thing that can stop a click is a
    // payload nobody could derive.
    send: (task, preview) =>
      preview.msg === undefined
        ? noSample(preview.event)
        : { ...preview.msg, type: `${task}.${preview.event}` },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// THE BUILD
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The lane at step `cursor`, as one value a view renders straight.
 *
 * ```ts
 * const feed = replayFeed(chartFromWorkflow(document), parseEventsJsonl(log));
 * const view = laneView(feed, feed.total);   // now
 * const then = laneView(feed, 3);            // exactly after three events
 * ```
 */
export function laneView(
  feed: LaneFeed,
  cursor: number,
  title?: string,
): LaneViewModel {
  const total = feed.total;
  const at = Math.max(0, Math.min(cursor, total));
  const leaves = feed.leavesAt(at);
  const seen = feed.steps.filter((s) => s.index < at);
  const inspection = inspectLaneStates(feed.lane, leaves, feed.optsFor);

  // THE PHASE THE READER CAME FOR, when there is no active one left. A lane
  // that ENDED has no active phase, and the rule below expands only the active
  // one — so a lane that finished successfully drew not one diagram, under a
  // paragraph promising that every task had one. `tripped` was special-cased
  // and `complete` was not, and complete is the common ending.
  //
  // The last phase that actually ran is the ending: it holds the tasks that
  // reached the terminal, and the earlier ones are history a reader can open.
  const lastRan = inspection.phases.reduce(
    (last, p, i) => (p.standing === "waiting" ? last : i),
    -1,
  );
  const endsAt = inspection.terminal === null ? -1 : lastRan;

  const phases = inspection.phases.map((phase, index): LanePhaseView => {
    const tasks = phase.tasks.map((task): LaneTaskView => {
      const chart = feed.lane.charts[task.task];
      const walked = walkedEdges(seen.filter((s) => s.task === task.task));
      return {
        task: task.task,
        phase: task.phase,
        state: task.state,
        endPolarity: task.endPolarity,
        ...(task.was === undefined ? {} : { was: task.was }),
        waitingOn: task.waitingOn,
        stuck: task.stuck,
        moved: chart === undefined ? true : task.state !== initialOf(chart),
        budget: feed.budget(task.task, leaves),
        controls: task.events.map((preview) =>
          control(feed, task.task, preview),
        ),
        diagram: chart === undefined ? "" : draw(chart, task.state, walked),
      };
    });
    return {
      name: phase.name,
      index: phase.index,
      standing: phase.standing,
      tripped: phase.tripped,
      tasks,
      expanded: expandedIn(phase.standing, tasks, index === endsAt),
    };
  });

  const phaseOf = (task: string): string =>
    phases.find((p) => p.tasks.some((t) => t.task === task))?.name ?? "";

  return {
    source: feed.kind,
    title: title ?? feed.lane.id ?? "lane",
    status: inspection.status,
    terminal: inspection.terminal,
    activePhase: inspection.activePhase,
    tripped: inspection.tripped,
    stuck: inspection.stuck.map((s) => ({
      task: s.task,
      phase: phaseOf(s.task),
      reason: s.reason,
    })),
    phases,
    steps: seen,
    clock: feed.clock,
    cursor: at,
    total,
    scrubbed: at < total,
    ...(feed.noDispatch === undefined ? {} : { noDispatch: feed.noDispatch }),
  };
}

/**
 * `report.ts`'s rule, as a set of task ids.
 *
 * The phase a reader is here for expands, and inside it only the tasks that
 * moved — with the one exception the markdown makes for the same reason: a
 * phase that just started has moved nothing, and collapsing all of it would
 * leave the reader with no picture at all, so its first task represents the
 * rest (they are all at the same entry state, so any of them is the same
 * picture).
 *
 * WHICH PHASE that is depends on whether the lane is still moving: the ACTIVE
 * one while it runs, and the one it ENDED IN once it has stopped.
 */
function expandedIn(
  standing: PhaseStanding,
  tasks: readonly LaneTaskView[],
  ending: boolean,
): readonly string[] {
  // A TRIPPED phase expands the tasks that tripped it. `report.ts` gives that
  // phase one line and that is right for a comment, where the reader is going
  // to click through to the lane anyway. On the screen they came for, the task
  // that ended the lane is the whole reason they are here.
  if (standing === "tripped") {
    return tasks.filter((t) => t.endPolarity === "error").map((t) => t.task);
  }
  if (standing !== "active" && !ending) return [];
  const moved = tasks.filter((t) => t.moved).map((t) => t.task);
  if (moved.length > 0) return moved;
  const first = tasks[0];
  return first === undefined ? [] : [first.task];
}

/** One `EventPreview` as a control, with this source's answer to "can I send it". */
function control(
  feed: LaneFeed,
  task: string,
  preview: EventPreview,
): LaneControl {
  const refused = preview.status === "refused";
  return {
    task,
    event: preview.event,
    kind: refused ? (preview.reason?.kind ?? "undeclared") : "legal",
    refused,
    ...(preview.why === undefined ? {} : { why: preview.why }),
    outcome: outcomeOf(preview),
    send: refused ? NO_DISPATCH_REFUSED : feed.send(task, preview),
  };
}

/**
 * A refused control cannot be sent for a reason that is not about the SOURCE —
 * the chart refused it — so it carries that answer rather than the source's.
 * The refusal itself is already on the control; this is what a caller reading
 * only `send` gets, and it must not say "no code bodies" about a lane that has
 * them.
 */
const NO_DISPATCH_REFUSED: Unanswerable<"dispatch"> = {
  answerable: false,
  question: "dispatch",
  why: "this event is refused at this state — see the refusal for which mechanism refused it",
};

/**
 * Why a guard could not be evaluated, as a sentence.
 *
 * The verdict's `why` is a tag — `no-guard-bag`, `no-sample` — which is the
 * right thing for a caller to branch on and the wrong thing to print. Reading
 * `retriesRemaining? (no-guard-bag)` on screen tells you the answer is missing
 * without telling you why, and the why is the useful half: on an imported lane
 * it is not a gap to fix, it is what an imported lane IS.
 */
function guardUnknownLine(why: string): string {
  switch (why) {
    case "no-guard-bag":
      return "cannot say which — this lane came from a workflow document, so the guard bodies that would decide do not exist here";
    case "no-implementation":
      return "cannot say which — no implementation was supplied for this guard";
    case "no-sample":
      return "cannot say which — the guard reads the message payload and no sample was given for this event";
    default:
      return `cannot say which — evaluating the guard threw (${why})`;
  }
}

/** The one-line "where would this go, and what would it DECLARE it fires". */
function outcomeOf(v: EventPreview): string {
  const cmds = v.cmds.length > 0 ? ` / ${v.cmds.join(", ")}` : "";
  if (v.guard !== undefined) {
    return v.guard.branch === "unknown"
      ? `${v.targets.join(" | ")} — ${guardUnknownLine(v.guard.why ?? "")}`
      : `→ ${v.guard.target} [${v.guard.branch === "then" ? "" : "!"}${v.guard.guard}]${cmds}`;
  }
  if (v.resolved !== undefined) return `→ ${v.resolved}${cmds}`;
  return `${v.targets.join(" | ")}${cmds}`;
}
