// ═══════════════════════════════════════════════════════════════════════════
// THE TWO INPUT PATHS.
//
// Both produce the same `LaneReportInput`, and both take TEXT rather than doing
// their own I/O — so this module has no `node:fs` in it, runs in a worker or a
// Durable Object, and the caller keeps the one decision that is genuinely
// theirs (which bytes, from where).
//
//   THE FILE PATH — `workflow.json` + `events.jsonl` off disk. What a tool
//   running inside the repo already has: the lane directory is right there.
//   Status is DERIVED, because there is nothing to be handed.
//
//   THE CLI PATH — `fabrika lane status` + `fabrika lane history` stdout, plus
//   the `workflow.json` bytes. This is the one that matters: it means a
//   standalone inspector can shell out to `fabrika` and need ZERO phoenix
//   changes, because both verbs already print JSON on stdout and have done
//   since they were written. Status here is the CLI's OWN derivation, carried
//   verbatim — the report reads, it does not re-decide.
//
// `workflow.json` is read as a file on BOTH paths, deliberately. `lane print`
// looks like the CLI answer for topology and is not: it emits, per state, the
// event NAMES a cell exists for and never the targets, so no edge can be drawn
// from it. The document is local, gitignored and sitting next to the log.
// ═══════════════════════════════════════════════════════════════════════════
import {
  type LaneStatus,
  type LogEntry,
  parseEventsJsonl,
  parseHistoryJson,
  parseStatusJson,
} from "./fold";
import type { LaneReportInput } from "./report";
import { chartFromWorkflowText, type ImportedLane } from "./workflow";

/** Everything a report needs, however it was obtained. */
export interface LaneSource {
  readonly workflow: ImportedLane;
  readonly entries: readonly LogEntry[];
  /** Present only on the CLI path — the driver's own answer, not ours. */
  readonly status?: LaneStatus;
}

/**
 * PATH 1 — the two files.
 *
 * @param workflowJson the bytes of `<lane>/workflow.json`
 * @param eventsJsonl  the bytes of `<lane>/events.jsonl` (`""` for a fresh lane)
 */
export function laneFromFiles(
  workflowJson: string,
  eventsJsonl: string,
): LaneSource {
  return {
    workflow: chartFromWorkflowText(workflowJson),
    entries: parseEventsJsonl(eventsJsonl),
  };
}

/**
 * PATH 2 — the CLI's stdout.
 *
 *     const dir  = ".fabrika/lanes/5842";
 *     const src  = laneFromCli(
 *       readFileSync(`${dir}/workflow.json`, "utf8"),
 *       execFileSync("fabrika", ["lane", "status",  "--lane", "5842"], { encoding: "utf8" }),
 *       execFileSync("fabrika", ["lane", "history", "--lane", "5842"], { encoding: "utf8" }),
 *     );
 *     console.log(laneReport(reportInput(src)).markdown);
 *
 * @param workflowJson the bytes of `<lane>/workflow.json`
 * @param statusStdout `fabrika lane status`'s stdout — `JSON.stringify(status, null, 2)`
 * @param historyStdout `fabrika lane history`'s stdout — the log as a JSON array
 */
export function laneFromCli(
  workflowJson: string,
  statusStdout: string,
  historyStdout: string,
): LaneSource {
  return {
    workflow: chartFromWorkflowText(workflowJson),
    entries: parseHistoryJson(historyStdout),
    status: parseStatusJson(statusStdout),
  };
}

/** A `LaneSource` as the report's input. One line, so neither path spells it. */
export function reportInput(
  source: LaneSource,
  title?: string,
): LaneReportInput {
  return {
    workflow: source.workflow,
    entries: source.entries,
    ...(source.status === undefined ? {} : { status: source.status }),
    ...(title === undefined ? {} : { title }),
  };
}
