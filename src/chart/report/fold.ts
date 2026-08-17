// ═══════════════════════════════════════════════════════════════════════════
// THE FOLD — `events.jsonl` in, per-task leaf states out, from scratch.
//
// The mirror of `packages/fabrika-cli/src/lane/fold.ts`. It is here for two
// reasons and neither is "because we might as well":
//
//   1. THE TIMELINE. `lane history` returns the log verbatim and deliberately
//      does NOT store `from → to` — those are reconstructible by folding, so
//      storing them would be a second copy of a derived fact. Reconstructing
//      them is therefore the reader's job, and the reader needs a fold to do
//      it. Because the fold is a LEFT fold that is pure over a prefix, the
//      state before step k is exactly `foldLog(entries.slice(0, k))` — time
//      travel that is exact rather than approximated.
//
//   2. THE FILE PATH. A caller holding only `workflow.json` + `events.jsonl`
//      has no `lane status` output to be handed. It derives one.
//
// The transition semantics below are fabrika's, verbatim in behaviour: the
// guard is the one inline `retries < maxRetries` (the guard NAME in the
// document is inert data, never dereferenced), a resume lands on `was ?? the
// region's initial` and does NOT rewrite `was`, and every other edge records
// `was = the state you left`.
// ═══════════════════════════════════════════════════════════════════════════
import { edgeKey } from "./draw";
import {
  bareEvent,
  endPolarityOf,
  type ImportedChart,
  type ImportedLane,
  initialOf,
  statesOf,
} from "./workflow";

/** One appended line of `events.jsonl`: which task, which event, when. */
export interface LogEntry {
  readonly task: string;
  readonly event: string;
  readonly at: string;
}

/** One task's folded state: the leaf, the retry budget, and the state it left. */
export interface TaskState {
  readonly type: string;
  readonly retries: number;
  readonly maxRetries: number;
  readonly was?: string;
}

/**
 * The derived answer `lane status` prints — reproduced here field for field,
 * because a report that computed its own vocabulary would contradict the driver
 * the moment the two disagreed.
 */
export interface LaneStatus {
  readonly stateValue:
    | string
    | Readonly<Record<string, Readonly<Record<string, string>> | string>>;
  readonly status: "active" | "done";
  readonly context: Readonly<Record<string, unknown>>;
}

/** The log does not replay against this workflow — with the reason named. */
export class UnreplayableLogError extends Error {
  override readonly name = "UnreplayableLogError";
  readonly _tag = "UnreplayableLogError" as const;
  constructor(public readonly defects: readonly string[]) {
    super(
      `@demlik/tea: this events log does not replay against this workflow —\n` +
        defects.map((d) => `  • ${d}`).join("\n"),
    );
  }
}

/**
 * Parse `events.jsonl`. A line that does not parse is a DEFECT, never a
 * silently skipped event — a report built on a log it half-read is worse than
 * no report.
 */
export function parseEventsJsonl(text: string): readonly LogEntry[] {
  const defects: string[] = [];
  const entries: LogEntry[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      defects.push(`line ${index + 1} is not JSON`);
      continue;
    }
    const entry = asLogEntry(parsed);
    if (entry === undefined) {
      defects.push(
        `line ${index + 1} does not carry string \`task\`/\`event\`/\`at\``,
      );
      continue;
    }
    entries.push(entry);
  }
  if (defects.length > 0) throw new UnreplayableLogError(defects);
  return entries;
}

function asLogEntry(value: unknown): LogEntry | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as { task?: unknown; event?: unknown; at?: unknown };
  if (
    typeof record.task !== "string" ||
    typeof record.event !== "string" ||
    typeof record.at !== "string"
  ) {
    return undefined;
  }
  return { task: record.task, event: record.event, at: record.at };
}

/** `lane history`'s stdout — a JSON array of the same entries, verbatim. */
export function parseHistoryJson(text: string): readonly LogEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UnreplayableLogError(["`lane history` output is not JSON"]);
  }
  if (!Array.isArray(parsed)) {
    throw new UnreplayableLogError([
      "`lane history` output is not a JSON array of entries",
    ]);
  }
  const entries: LogEntry[] = [];
  for (const [index, raw] of parsed.entries()) {
    const entry = asLogEntry(raw);
    if (entry === undefined) {
      throw new UnreplayableLogError([
        `history entry ${index} does not carry string \`task\`/\`event\`/\`at\``,
      ]);
    }
    entries.push(entry);
  }
  return entries;
}

const chartOf = (lane: ImportedLane, taskId: string): ImportedChart => {
  const chart = lane.charts[taskId];
  if (chart === undefined) {
    throw new UnreplayableLogError([
      `log names task "${taskId}", which is not in this lane's machine`,
    ]);
  }
  return chart;
};

/** The initial state of every task — the fold's zero. */
export function initialStates(
  lane: ImportedLane,
): Readonly<Record<string, TaskState>> {
  const out: Record<string, TaskState> = {};
  for (const [taskId, chart] of Object.entries(lane.charts)) {
    out[taskId] = {
      type: initialOf(chart),
      retries: 0,
      maxRetries: lane.context[taskId]?.maxRetries ?? 2,
    };
  }
  return out;
}

/**
 * ONE event applied to ONE task. The three edge forms, and the fourth case —
 * no edge — which is a REFUSAL, exactly as tea's `NoCellError` is: a lane state
 * either routes an event or it does not, and "does not" is a decision.
 */
export function stepTask(
  chart: ImportedChart,
  state: TaskState,
  event: string,
): TaskState {
  const node = statesOf(chart).get(state.type);
  const edge = node?.on?.[event];
  if (edge === undefined) {
    throw new UnreplayableLogError([
      `state "${state.type}" holds no cell for "${event}"`,
    ]);
  }
  if ("resume" in edge) {
    // `was` is NOT rewritten: you are LEAVING the park, not entering one.
    return { ...state, type: state.was ?? edge.resume.fallback };
  }
  if ("when" in edge) {
    // The guard NAME is inert. This one predicate is the guard, in fabrika and
    // here — which is exactly why the two cannot drift apart on a rename.
    return state.retries < state.maxRetries
      ? {
          ...state,
          type: edge.target,
          retries: state.retries + 1,
          was: state.type,
        }
      : { ...state, type: edge.otherwise, was: state.type };
  }
  return { ...state, type: edge.target, was: state.type };
}

/**
 * Fold the whole log into per-task leaf states.
 *
 * PURE OVER A PREFIX: tasks are independent regions, so the global log
 * partitions cleanly and each task folds through its own chart. `foldLane(lane,
 * entries.slice(0, k))` is therefore the exact state after k events, for every
 * k — which is what {@link timeline} spends.
 */
export function foldLane(
  lane: ImportedLane,
  entries: readonly LogEntry[],
): Readonly<Record<string, TaskState>> {
  const states: Record<string, TaskState> = { ...initialStates(lane) };
  for (const entry of entries) {
    const chart = chartOf(lane, entry.task);
    const current = states[entry.task];
    if (current === undefined) {
      throw new UnreplayableLogError([
        `log names task "${entry.task}", which is not in this lane's machine`,
      ]);
    }
    states[entry.task] = stepTask(chart, current, bareEvent(entry.event));
  }
  return states;
}

/** One row of the timeline: the entry, plus the `from → to` nobody stored. */
export interface TimelineStep {
  readonly index: number;
  readonly at: string;
  readonly task: string;
  /** The event VERBATIM, namespace and all — the log's own spelling. */
  readonly event: string;
  readonly from: string;
  readonly to: string;
  /**
   * The DECLARED edge this step fired, as {@link edgeKey} spells it.
   *
   * Not derivable from `from`/`event`/`to`, and that is the whole reason it is
   * carried: a resume edge is DRAWN once, to its fallback, and WALKED to
   * wherever `was` pointed. Recovering "which edge lit up" from the observed
   * target would land on an edge the drawing does not have — so the step
   * records the edge it took while it still knows.
   */
  readonly edge: string;
}

/**
 * The log with `from → to` recomputed per step.
 *
 * A single left-to-right pass, which is EXACTLY the prefix fold and not an
 * approximation of it: `foldLane` is a left fold over the same entries in the
 * same order, so the state carried into step k here is the state
 * `foldLane(lane, entries.slice(0, k))` returns. `fold.test.ts` asserts that
 * equality rather than asking you to take it on trust — the cheap form and the
 * definitional form, pinned to each other.
 */
export function timeline(
  lane: ImportedLane,
  entries: readonly LogEntry[],
): readonly TimelineStep[] {
  const states: Record<string, TaskState> = { ...initialStates(lane) };
  const steps: TimelineStep[] = [];
  for (const [index, entry] of entries.entries()) {
    const chart = chartOf(lane, entry.task);
    const before = states[entry.task];
    if (before === undefined) {
      throw new UnreplayableLogError([
        `log names task "${entry.task}", which is not in this lane's machine`,
      ]);
    }
    const event = bareEvent(entry.event);
    const after = stepTask(chart, before, event);
    states[entry.task] = after;
    const declared = statesOf(chart).get(before.type)?.on?.[event];
    const drawnTarget =
      declared !== undefined && "resume" in declared
        ? declared.resume.fallback
        : after.type;
    steps.push({
      index,
      at: entry.at,
      task: entry.task,
      event: entry.event,
      from: before.type,
      to: after.type,
      edge: edgeKey(before.type, event, drawnTarget),
    });
  }
  return steps;
}

/**
 * The whole "compound machine", as a pure derivation.
 *
 * The active phase is the first whose tasks are not all final; a COMPLETED
 * phase holding a task in an error final trips the workflow. That is fabrika's
 * `noErrors` gate — never a machine event, and here it reads the chart's
 * `end: "error"` polarity, which is the same fact the document's guarded
 * fallthrough declared.
 */
export function deriveLaneStatus(
  lane: ImportedLane,
  states: Readonly<Record<string, TaskState>>,
): LaneStatus {
  const isFinal = (taskId: string): boolean =>
    endPolarityOf(nodeOf(lane, taskId, states)) !== false;
  const errors = Object.keys(states).filter(
    (taskId) => endPolarityOf(nodeOf(lane, taskId, states)) === "error",
  );

  const context: Record<string, unknown> = {};
  for (const [taskId, state] of Object.entries(states)) {
    context[taskId] = {
      retries: state.retries,
      maxRetries: state.maxRetries,
      ...(lane.context[taskId]?.extras ?? {}),
    };
  }
  context.errors = errors;

  let active: ImportedLane["phases"][number] | undefined;
  for (const phase of lane.phases) {
    if (!phase.tasks.every(isFinal)) {
      active = phase;
      break;
    }
    if (phase.tasks.some((taskId) => errors.includes(taskId))) {
      return {
        stateValue: lane.terminals.tripped,
        status: "done",
        context,
      };
    }
  }
  if (active === undefined) {
    return { stateValue: lane.terminals.complete, status: "done", context };
  }

  const stateValue: Record<string, Record<string, string> | string> = {
    [active.name]: Object.fromEntries(
      active.tasks.map((taskId) => [taskId, states[taskId]?.type ?? "?"]),
    ),
  };
  for (const phase of lane.phases.slice(lane.phases.indexOf(active) + 1)) {
    stateValue[phase.name] = "waiting";
  }
  return { stateValue, status: "active", context };
}

function nodeOf(
  lane: ImportedLane,
  taskId: string,
  states: Readonly<Record<string, TaskState>>,
) {
  const chart = lane.charts[taskId];
  const state = states[taskId];
  if (chart === undefined || state === undefined) return undefined;
  return statesOf(chart).get(state.type);
}

/** `lane status`'s stdout, parsed back into the shape it was printed from. */
export function parseStatusJson(text: string): LaneStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UnreplayableLogError(["`lane status` output is not JSON"]);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new UnreplayableLogError(["`lane status` output is not an object"]);
  }
  const record = parsed as {
    stateValue?: unknown;
    status?: unknown;
    context?: unknown;
  };
  if (record.status !== "active" && record.status !== "done") {
    throw new UnreplayableLogError([
      '`lane status` output carries no `status` of "active" | "done"',
    ]);
  }
  if (record.stateValue === undefined) {
    throw new UnreplayableLogError([
      "`lane status` output carries no `stateValue`",
    ]);
  }
  return {
    stateValue: record.stateValue as LaneStatus["stateValue"],
    status: record.status,
    context:
      typeof record.context === "object" && record.context !== null
        ? (record.context as Record<string, unknown>)
        : {},
  };
}
