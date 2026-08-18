/**
 * chart/lane — N chart instances in parallel, grouped into phases that
 * sequence. **Experimental.**
 *
 * `./chart` describes ONE machine. The consumer this module was written for —
 * `kamp-us/phoenix`'s `fabrika` — does not run one machine, it runs LANES, and
 * a lane is a different shape:
 *
 *   a lane has PHASES that run in order;
 *   each phase holds N TASK REGIONS running concurrently, every region an
 *   instance of the same chart;
 *   a phase completes when EVERY region in it reaches a final, and `onDone`
 *   then routes to the next phase or to a lane terminal;
 *   the lane's ending is COMPLETE or TRIPPED — tripped when any region landed
 *   on an `end: "error"` final.
 *
 * So a lane's state is compound. Not `"build"` but
 * `{ phase1: { issue_5729: "build", issue_5730: "queued" }, phase2: "waiting" }`,
 * and no amount of drawing one chart at a time produces that picture.
 *
 * ```text
 *   defineLane(spec)              → ImportedLane   // author one
 *   laneShape(lane)               → LaneShape      // read any one, derived
 *   inspectLane(lane, entries)    → LaneInspection // the headless view
 * ```
 *
 * DRAW, NOT AUTHOR-AND-RUN — the boundary, stated up front because it is what
 * keeps this module small. Everything here DESCRIBES, FOLDS and DRAWS a lane.
 * Nothing here runs one: no per-instance boot override, no router dispatching
 * `ISSUE_5729.DONE` to region 5729, nothing that makes a lane dispatchable as a
 * `Machine`. fabrika folds its own log and owns its own supervision; this reads
 * the result. A lane you can draw is a smaller thing than a lane you can run,
 * and it was the missing one.
 *
 * ONE LANE REPRESENTATION, TWO DOORS. {@link defineLane} and
 * `chartFromWorkflow` (in `@demlik/tea/chart/report`) both produce the same
 * `ImportedLane`, so the fold, the markdown report and the inspector take
 * either without a second code path. What differs is what each buys:
 * `chartFromWorkflow` buys FIDELITY to a `workflow.json` this repo has never
 * seen; `defineLane` buys the four authoring mistakes the type layer can catch
 * (a task in two phases, a phase with no tasks, a terminal that collides with a
 * phase name, a retry budget for a task that does not exist).
 *
 * WHERE THE GUARANTEE STOPS, said here rather than discovered later. A lane
 * assembled from `ImportedChart`s is runtime-typed by construction — states,
 * events and targets are `string` — so "does this chart declare an initial
 * state" is not a question the type layer can be asked. Those checks are
 * runtime, and they throw {@link LaneShapeError} rather than being pretended.
 *
 * @packageDocumentation
 */

export {
  inspectLane,
  type LaneInspection,
  type LanePhaseInspection,
  type LaneTaskInspection,
  type StuckReason,
} from "./inspect";
export {
  defineLane,
  type Lane,
  type LaneChecks,
  type LaneErrorFinals,
  type LaneInitial,
  type LaneMsg,
  type LaneOf,
  type LanePhaseName,
  type LanePhaseOf,
  type LanePhaseShape,
  type LaneRegion,
  type LaneShape,
  LaneShapeError,
  type LaneSiblings,
  type LaneSpec,
  type LaneState,
  type LaneSuccessFinals,
  type LaneTaskChart,
  type LaneTaskId,
  type LaneTaskShape,
  type LaneTasksIn,
  type LaneTerminal,
  laneShape,
  type PhaseStanding,
} from "./structure";
