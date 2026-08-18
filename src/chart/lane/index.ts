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
 *   defineLane(spec)              → Lane<S>        // author one, typed
 *   laneShape(lane)               → LaneShape      // read any one, derived
 *   inspectLane(lane, entries)    → LaneInspection // the headless view
 *   LaneState<L> / LaneMsg<L>                      // its alphabets, derived
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
 * `ImportedLane` value — `defineLane` LOWERS whichever chart it was handed to
 * it — so the fold, the markdown report and the inspector take either without a
 * second code path. What differs is what each buys: `chartFromWorkflow` buys
 * FIDELITY to a `workflow.json` this repo has never seen; `defineLane` buys the
 * types.
 *
 * THE TYPED DOOR. A lane built from `defineChart` literals keeps them: its
 * `spec` is carried on the lane, so {@link LaneState} is the compound state
 * with every leaf that task's OWN `StateOf<chart>`, and {@link LaneMsg} is
 * `{ task, event }` with the event narrowed to the events THAT task's chart
 * declares — never a union across the lane's charts. Three more authoring
 * mistakes become compile errors there: a region with no initial state, a
 * region with no final, a region that delegates a target to a cell.
 *
 * WHERE THE GUARANTEE STOPS, said here rather than discovered later. An
 * `ImportedChart` is runtime-typed by construction — states, events and targets
 * are `string` — so "does this chart declare an initial state" is not a question
 * that door can be asked. The same derivations run over it and read back as
 * `string`; the three chart-shaped checks stand down; and {@link defineLane}
 * throws {@link LaneShapeError} rather than pretending.
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
