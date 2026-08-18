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
//   ONE DIAGRAM PER TASK THAT MOVED, ACTIVE PHASE ONLY. A comment with eight
//   diagrams is a comment nobody reads. Future phases get one line each, and so
//   do the tasks still sitting at their entry state — a real emitted epic put
//   eight tasks in one phase, six of them untouched, and the rule as originally
//   written (per TASK, not per MOVED task) produced exactly the wall of
//   near-identical pictures it exists to prevent.
//
//   "WAITING ON" IS DERIVED, AND NAMES NOTHING. This file used to answer it by
//   matching STATE NAMES — `queued`, `build`, `review`, `ship`, `blocked`,
//   `human:*` — against a list copied out of fabrika's `wire/lane-brief.ts`.
//   Those names are fabrika's, so a rename upstream turned this report into a
//   confident liar with nothing failing anywhere. The fact it was really after
//   is not "which state is this" but "who has to act next", which is a property
//   of the EVENT: a Msg comes from a Cmd's result, a Sub firing, or the outside
//   world, and the chart now says which (`graph.ts` §3a, `from`). So the answer
//   is the events legal HERE, grouped by THEIR origin — no state name, no event
//   name, no job title in this file.
//
//   AND IT STILL REFUSES TO GUESS. A chart that declares no provenance gets no
//   invented one: the line says which events the state accepts and stops, which
//   is what the machine does say — the same refusal `shellState()` makes by
//   answering null rather than inventing a shell.
//
//   THE RETRY LINE, WHEN AND ONLY WHEN IT MATTERS. `2/2` is the difference
//   between "in review" and "one FAIL from frozen", and `0/2` is noise.
// ═══════════════════════════════════════════════════════════════════════════
import type { EventOrigin } from "../graph";
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
  initialOf,
  originOf,
  statesOf,
} from "./workflow";

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

/** Event names, as the report writes a list of them. */
const listed = (events: readonly string[]): string =>
  events.map((e) => `\`${e}\``).join(", ");

/**
 * One origin's worth of the answer, said the way that origin is said.
 *
 * The three phrasings are the three origins, and each says the thing that
 * origin makes true. A world role is a WHO, so the events are what that who
 * owes; a cmd is work already in flight, so the sentence is about the work and
 * the events are how it comes back; a sub is a source, so the sentence is about
 * the source. The role text (`the operator`, `a human`) is the consumer's own,
 * carried from the chart verbatim — including its article, because only the
 * consumer knows whether there is one of them or any of them.
 */
function phrase(
  origin: EventOrigin,
  state: string,
  events: readonly string[],
): string {
  if (origin === "cmd") {
    return `the work \`${state}\` dispatched — ${listed(events)}`;
  }
  if (origin === "sub") {
    return `the source \`${state}\` is subscribed to — ${listed(events)}`;
  }
  return `${origin.world}'s ${listed(events)}`;
}

/** The grouping key for an origin — the two words, or the role, distinctly. */
const originKey = (origin: EventOrigin): string =>
  typeof origin === "string" ? origin : `world:${origin.world}`;

/**
 * What this task is waiting on — or `null` at a final.
 *
 * DERIVED, entirely: the events this state routes, grouped by the origin each
 * one DECLARES, in declaration order. Nothing here knows a state name, an event
 * name or a job title, so a consumer that renames half its states changes this
 * output correctly and a consumer with a completely different cast is served by
 * the same function.
 *
 * The degradation is the point of the second half. Provenance is not in
 * `workflow.json` — it is stated at the import boundary or not at all — so a
 * chart imported without it must say what it actually knows, which is WHICH
 * EVENTS the state accepts. It never says who sends them.
 */
export function waitingOn(chart: ImportedChart, state: string): string | null {
  const node = statesOf(chart).get(state);
  if (node?.end !== undefined) return null;
  const events = Object.keys(node?.on ?? {});
  if (events.length === 0) {
    // A live state that routes nothing. `inspectLane` calls this a dead end;
    // there is no one to wait for and saying so is the whole answer.
    return `\`${state}\` accepts no events, and it is not a final`;
  }

  // Group by origin, keeping the events in the order the chart declares them.
  const groups = new Map<string, { origin: EventOrigin; events: string[] }>();
  const undeclared: string[] = [];
  for (const event of events) {
    const origin = originOf(chart, event);
    if (origin === undefined) {
      undeclared.push(event);
      continue;
    }
    const key = originKey(origin);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { origin, events: [event] });
    else group.events.push(event);
  }

  // NO PROVENANCE AT ALL — the honest floor. Same voice as the refusal this
  // replaces: name what the machine says, and stop.
  if (groups.size === 0) return `\`${state}\` accepts ${listed(events)}`;

  const parts = [...groups.values()].map((g) =>
    phrase(g.origin, state, g.events),
  );
  // A PARTIAL map is not rounded up to a whole one. The events whose origin was
  // never stated are listed as exactly that, beside the ones that were.
  if (undeclared.length > 0) {
    parts.push(`${listed(undeclared)}, from somewhere the chart does not say`);
  }
  return parts.join(" · ");
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
 * The diagram half is behind {@link drawTask}, which is a translation onto
 * `chartMermaid` — the package's one chart renderer.
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
      // ONE DIAGRAM PER TASK THAT HAS MOVED — not per task.
      //
      // The rule at the top of this file says a comment with eight diagrams is
      // a comment nobody reads, and until this was run against a real emitted
      // epic the rule was only enforced on the phase dimension. A real phase
      // holds eight tasks; six of them sat untouched at `queued`, and the
      // report spent ~200 of its ~265 lines drawing the same picture six times
      // with a different node lit. A task still at its entry state has a story
      // one line long, so it gets one line.
      const untouched: string[] = [];
      for (const taskId of stand.tasks) {
        const chart = lane.charts[taskId];
        const state = states[taskId];
        if (chart === undefined || state === undefined) continue;
        if (state.type === initialOf(chart)) untouched.push(taskId);
      }
      // If NOTHING in the phase has moved, the phase just started — and
      // collapsing every task would leave the reader with no picture at all.
      // Draw the first as the representative (they are all at the same entry
      // state, so any of them is the same picture) and list the rest.
      if (untouched.length === stand.tasks.length) untouched.shift();
      for (const taskId of stand.tasks) {
        const chart = lane.charts[taskId];
        const state = states[taskId];
        if (chart === undefined || state === undefined) continue;
        if (untouched.includes(taskId)) continue;
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
      if (untouched.length > 0) {
        // Named, not counted: "6 tasks not started" tells a reader nothing they
        // can act on, and the names are what they came for.
        const chart = lane.charts[untouched[0] as string];
        const at =
          chart === undefined ? "their entry state" : `\`${initialOf(chart)}\``;
        out.push(
          `**not started yet:** ${untouched.map((t) => `\`${t}\``).join(", ")} — still at ${at}.`,
        );
        out.push("");
      }
      continue;
    }
    out.push(phaseLine(stand, states));
    out.push("");
  }

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
