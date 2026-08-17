// ═══════════════════════════════════════════════════════════════════════════
// THE REPORT — one markdown string that reads the same in three places.
//
// A terminal, a PR comment and an issue comment are the three surfaces a lane's
// state is actually looked at on, and they share exactly one format. So the
// output is markdown with a mermaid fence: GitHub renders the fence, a terminal
// shows it as the text it is, and neither needs a flag.
//
// THE EDITORIAL RULES, which are most of what this file is:
//
//   ONE DIAGRAM PER TASK, ACTIVE PHASE ONLY. A comment with eight diagrams is a
//   comment nobody reads. Future phases get one line each.
//
//   FABRIKA'S OWN VOCABULARY FOR "WAITING ON". The report is a reader, not a
//   second driver — so `queued` waits on the operator's `WIP`, `build`/`review`/
//   `ship` wait on the shell that `wire/lane-brief.ts` routes them to, and
//   `blocked`/`human:*` wait on a human's `UNBLOCKED`. A state nothing routes
//   gets NO GUESS, exactly as `shellState()` returns null rather than inventing
//   one; it gets the events it accepts, which is what the machine does say.
//
//   THE RETRY LINE, WHEN AND ONLY WHEN IT MATTERS. `2/2` is the difference
//   between "in review" and "one FAIL from frozen", and `0/2` is noise.
// ═══════════════════════════════════════════════════════════════════════════
import { drawTask, walkedEdges } from "./draw";
import {
  deriveLaneStatus,
  foldLane,
  type LaneStatus,
  type LogEntry,
  type PhaseStand,
  phaseStandings,
  type TaskState,
  type TimelineStep,
  timeline,
} from "./fold";
import {
  chartFromWorkflow,
  endPolarityOf,
  type ImportedChart,
  type ImportedLane,
  statesOf,
} from "./workflow";

/**
 * The three leaf states that route to a spawned shell — `wire/lane-brief.ts`'s
 * `SHELL_STATES`, carried over rather than re-derived, so the report cannot
 * name a shell the driver would not spawn.
 */
export const SHELL_STATES = ["build", "review", "ship"] as const;
export type ShellState = (typeof SHELL_STATES)[number];
const SHELLS: Readonly<Record<ShellState, string>> = {
  build: "builder",
  review: "reviewer",
  ship: "shipper",
};

/** The lane the report is about. `workflow` is the PARSED document, or an import. */
export interface LaneReportInput {
  /** `workflow.json`, parsed — or an already-imported lane, reused as is. */
  readonly workflow: unknown;
  readonly entries: readonly LogEntry[];
  /**
   * `lane status`'s answer.
   *
   * OPTIONAL, and that is the whole shape of the two input paths: a caller
   * shelling out to `fabrika` hands over the CLI's own derivation and the
   * report never second-guesses it; a caller holding only the two files omits
   * it and the same derivation runs here.
   */
  readonly status?: LaneStatus;
  /** Heading for the block. Defaults to the document's `id`. */
  readonly title?: string;
}

export interface LaneReport {
  readonly markdown: string;
}

const isImportedLane = (v: unknown): v is ImportedLane =>
  typeof v === "object" &&
  v !== null &&
  Array.isArray((v as ImportedLane).phases) &&
  typeof (v as ImportedLane).charts === "object";

/** `{ pipeline: { issue: "review" } }` → the phase that is actually running. */
function activePhaseName(status: LaneStatus): string | undefined {
  if (typeof status.stateValue === "string") return undefined;
  for (const [name, value] of Object.entries(status.stateValue)) {
    if (typeof value === "object") return name;
  }
  return undefined;
}

/** What this task is waiting on, in the driver's words — or `null` at a final. */
export function waitingOn(chart: ImportedChart, state: string): string | null {
  const node = statesOf(chart).get(state);
  if (node?.end !== undefined) return null;
  if (state === "queued") return "the operator's `WIP`";
  if ((SHELL_STATES as readonly string[]).includes(state)) {
    return `the \`${SHELLS[state as ShellState]}\` shell`;
  }
  if (state === "blocked" || state.startsWith("human:")) {
    return "a human's `UNBLOCKED`";
  }
  // NO GUESS. `shellState()` refuses to invent a shell for an unrouted state,
  // and so does this — what the machine does say is which events it accepts.
  const events = Object.keys(node?.on ?? {});
  return events.length === 0
    ? `nothing routes \`${state}\`, and it accepts no events`
    : `nothing routes \`${state}\` — it accepts ${events.map((e) => `\`${e}\``).join(", ")}`;
}

/** `2/2 — one \`FAIL\` from \`frozen\``, or `null` when no retry has been spent. */
function retryLine(chart: ImportedChart, state: TaskState): string | null {
  if (state.retries <= 0) return null;
  const budget = `${state.retries}/${state.maxRetries}`;
  if (state.retries < state.maxRetries) return `**retries:** ${budget}`;
  // Spent. Name the edge that is now a one-way door, off the chart rather than
  // off a constant — a document whose fallthrough is `tripped` says `tripped`.
  const node = statesOf(chart).get(state.type);
  for (const [event, edge] of Object.entries(node?.on ?? {})) {
    if ("when" in edge) {
      return `**retries:** ${budget} — spent; one \`${event}\` from \`${edge.otherwise}\``;
    }
  }
  return `**retries:** ${budget} — spent`;
}

/**
 * One phase that is NOT the active one, in one line.
 *
 * The editorial rule the module opened with, applied to the phase dimension: a
 * comment with eight diagrams is a comment nobody reads, so a phase already
 * finished and a phase not yet started each get a line. A finished phase still
 * gets its leaves, because "complete" alone does not say WHICH ending each of
 * its tasks reached — and a phase that never started has no leaves worth
 * printing, because every one of them would be an initial state nothing walked.
 */
function phaseLine(
  stand: PhaseStand,
  states: Readonly<Record<string, TaskState>>,
): string {
  const count = `${stand.tasks.length} task${stand.tasks.length === 1 ? "" : "s"}`;
  if (stand.standing === "waiting") {
    return `**${stand.name}:** waiting — ${count}, not started.`;
  }
  const leaves = stand.tasks
    .map(
      (taskId) =>
        `\`${taskId}\` = \`${states[taskId]?.type ?? "?"}\`${
          stand.tripped.includes(taskId) ? " **(tripped)**" : ""
        }`,
    )
    .join(", ");
  return `**${stand.name}:** ${stand.standing} — ${count}: ${leaves}`;
}

function timelineTable(steps: readonly TimelineStep[]): string {
  if (steps.length === 0)
    return "_no events yet — the lane is at its initial state._";
  const rows = steps.map(
    (s) =>
      `| ${s.index + 1} | ${s.at} | \`${s.task}\` | \`${s.event}\` | \`${s.from}\` → \`${s.to}\` |`,
  );
  return [
    "| # | at | task | event | from → to |",
    "|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

/**
 * A lane, as one markdown block.
 *
 * The diagram half is behind {@link drawTask} — see that file's banner for the
 * one line that swaps in `chartMermaid`'s option-taking form.
 */
export function laneReport(input: LaneReportInput): LaneReport {
  const lane = isImportedLane(input.workflow)
    ? input.workflow
    : chartFromWorkflow(input.workflow);
  const entries = input.entries;
  const states = foldLane(lane, entries);
  const status = input.status ?? deriveLaneStatus(lane, states);
  const steps = timeline(lane, entries);

  const title = input.title ?? lane.id ?? "lane";
  const out: string[] = [`## ${title} — ${status.status}`, ""];

  // ── where it is ─────────────────────────────────────────────────────────
  out.push(`**where it is:** ${describeStateValue(status.stateValue)}`);
  if (lane.trigger !== undefined) out.push(`**fired by:** \`${lane.trigger}\``);
  const errors = status.context.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    out.push(
      `**tripped:** ${errors.map((t) => `\`${String(t)}\``).join(", ")} — the lane lands on \`${lane.terminals.tripped}\``,
    );
  }
  out.push("");

  // ── the phases, in order: one in full, the rest in one line each ────────
  //
  // The standings are DERIVED from the fold — the same walk `deriveLaneStatus`
  // makes — rather than read off `stateValue`, because `stateValue` is silent
  // about a lane that already stopped: it collapses to the terminal's NAME, and
  // a reader of a tripped epic then cannot tell which phase tripped it, or
  // which phases below never got to start. The one thing still taken from
  // `status` is WHICH phase is active, so a report handed the CLI's own answer
  // shows the CLI's answer. (`fold.test.ts` asserts the two agree at every
  // prefix of every run, so this is a precedence rule, not a disagreement.)
  const stands = phaseStandings(lane, states);
  const named = activePhaseName(status);
  const active =
    stands.find((s) => s.name === named) ??
    stands.find((s) => s.standing === "active");

  for (const stand of stands) {
    if (stand === active) {
      for (const taskId of stand.tasks) {
        const chart = lane.charts[taskId];
        const state = states[taskId];
        if (chart === undefined || state === undefined) continue;
        const polarity = endPolarityOf(statesOf(chart).get(state.type));
        out.push(
          `### ${taskId} — \`${state.type}\`${polarity === "error" ? " — TRIPPED" : ""}`,
        );
        const waiting = waitingOn(chart, state.type);
        out.push(
          waiting !== null
            ? `**waiting on:** ${waiting}`
            : polarity === "error"
              ? // The distinction `end: "error"` bought, spent where it is worth
                // something: this task is as finished as a shipped one, and the
                // phase it is in is going to trip the lane when its siblings
                // finish. A report that said "final" for both would bury that.
                `**waiting on:** nothing — this task landed on the error final \`${state.type}\`, and \`${stand.name}\` will trip the lane when its siblings finish.`
              : "**waiting on:** nothing — this task is final.",
        );
        const retries = retryLine(chart, state);
        if (retries !== null) out.push(retries);
        out.push("");
        out.push("```mermaid");
        out.push(
          drawTask(chart, {
            current: state.type,
            walked: walkedEdges(steps.filter((s) => s.task === taskId)),
          }),
        );
        out.push("```");
        out.push("");
      }
      continue;
    }
    out.push(phaseLine(stand, states));
  }
  out.push("");

  // ── the timeline ────────────────────────────────────────────────────────
  out.push("### timeline");
  out.push("");
  out.push(timelineTable(steps));
  out.push("");
  return {
    markdown: `${out
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd()}\n`,
  };
}

function describeStateValue(value: LaneStatus["stateValue"]): string {
  if (typeof value === "string") return `\`${value}\` — the workflow is done.`;
  const parts: string[] = [];
  for (const [phase, leaf] of Object.entries(value)) {
    if (typeof leaf === "string") {
      parts.push(`\`${phase}\`: ${leaf}`);
      continue;
    }
    const inner = Object.entries(leaf)
      .map(([task, state]) => `\`${task}\` = \`${state}\``)
      .join(", ");
    parts.push(`\`${phase}\` → ${inner}`);
  }
  return parts.join(" · ");
}
