/**
 * chart/report — a fabrika lane, imported as charts and read back as markdown.
 *
 * `kamp-us/phoenix`'s `fabrika` runs GitHub-backed work pipelines as "lanes",
 * and a lane is two local files: a `workflow.json` that is immutable once
 * written, and an append-only `events.jsonl`. Everything else — the state
 * value, the status, the context, the errors — is DERIVED by re-folding the
 * whole log, every invocation, because the CLI is one-shot and there is no
 * resident process to hold anything.
 *
 * That is a machine with a drawing missing. This module supplies it.
 *
 * ```text
 *   chartFromWorkflow(document)          → ImportedLane   // topology → charts
 *   laneFromFiles(workflowJson, jsonl)   → LaneSource     // path 1: the files
 *   laneFromCli(workflowJson, st, hist)  → LaneSource     // path 2: fabrika stdout
 *   laneReport({ workflow, entries, status }) → { markdown }
 *
 *   foldLane(lane, entries)              → per-task leaf states
 *   timeline(lane, entries)              → the log with `from → to` recomputed
 *   deriveLaneStatus(lane, states)       → the `lane status` answer, derived
 * ```
 *
 * TWO GUARANTEES, FROM TWO DIFFERENT HALVES, and confusing them is the one
 * mistake worth naming up front:
 *
 *   {@link chartFromWorkflow} gives FIDELITY. It reads a document that only
 *   exists at runtime, so its charts are runtime-typed — every state, event and
 *   target is a `string`. What it buys is that the picture is of the document
 *   the driver is actually folding, including one this repo has never seen.
 *
 *   The AUTHORED fixture (`src/chart/__fixtures__/lane.ts`) gives TYPES. It is
 *   the same machine written as a chart literal, so `StateName`,
 *   `ResumeTargets`, `Assigns` and the totality obligation are all real, and
 *   `assert.test-d.ts` pins them. What it cannot do is follow a document it was
 *   not written against.
 *
 * The seam between them is the golden test: the importer's edge set is asserted
 * against what fabrika's OWN compiler produces for the same committed template,
 * so a change to the upstream compiler surfaces as a failing test rather than
 * as a drawing that quietly stopped matching the driver.
 *
 * WHAT THE IMPORT IS NOT. It is not a round trip. A `workflow.json` in gives
 * charts whose edge set, terminals, terminal polarity, phase list and retry
 * budget are exact; it does NOT recover the phase grouping or the event scopes
 * an author would write by hand (the document records neither), and it does not
 * carry guard or action NAMES as anything but labels — the guarded array IS the
 * guard, in fabrika and here, so a rename cannot make the two disagree.
 *
 * AND IT KNOWS NO VOCABULARY. Nothing in this module holds a list of a
 * consumer's event names, state names or phase names. The importer enforces the
 * document's GRAMMAR — the edge forms, the terminals, the phase shape — and
 * reads its alphabet ({@link eventAlphabet}) off the names the document itself
 * declares, so a consumer adding a seventh event is a consumer we already
 * import.
 *
 * @packageDocumentation
 */

export {
  type DrawOptions,
  drawTask,
  edgeKey,
  type WalkCounts,
  walkedEdges,
} from "./draw";
export {
  deriveLaneStatus,
  foldLane,
  initialStates,
  type LaneStatus,
  type LeafStates,
  type LogEntry,
  laneTerminalReached,
  type PhaseStand,
  type PhaseStanding,
  parseEventsJsonl,
  parseHistoryJson,
  parseStatusJson,
  phaseStandings,
  stepTask,
  type TaskState,
  type TimelineStep,
  timeline,
  trippedTasks,
  UnreplayableLogError,
} from "./fold";
export {
  type LaneReport,
  type LaneReportInput,
  laneReport,
  waitingOn,
} from "./report";
export {
  type LaneSource,
  laneFromCli,
  laneFromFiles,
  reportInput,
} from "./sources";
export {
  bareEvent,
  chartFromWorkflow,
  chartFromWorkflowText,
  endPolarityOf,
  eventAlphabet,
  type ImportedChart,
  type ImportedEdge,
  type ImportedLane,
  type ImportedNode,
  type ImportedPhase,
  initialOf,
  originOf,
  statesOf,
  WorkflowImportError,
  type WorkflowImportOptions,
} from "./workflow";
