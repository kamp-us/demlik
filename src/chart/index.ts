/**
 * chart — the machine as a DRAWING the compiler reads, not a picture drawn
 * beside one.
 *
 * `defineMachine` asks for a `Transitions` table: one cell per (state × msg),
 * each cell a function. That is the honest runtime shape, and it is also where
 * the diagram goes to die — the graph exists only in the reader's head, the
 * mermaid beside it is a second artifact that rots, and the compiler has no
 * opinion about which targets an edge may reach because the target is whatever
 * the body happened to return.
 *
 * A chart inverts that. The GRAPH is the source: states grouped by phase, an
 * event alphabet with payloads and a `scope`, a Cmd alphabet with payloads, and
 * one edge per (state, event) declaring its target(s). Everything else is
 * derived from it — the `State` union, the `Msg` union, the `Cmd` union, which
 * guards exist and what each one's parameters are, which payload builders are
 * owed, which (state × event) pairs are still undecided — and `compile` walks
 * the same object into a real `Transitions` with one cast, inside the library,
 * at the construction boundary. The code the author still writes is only what
 * the graph genuinely cannot know: the payload of each transition, the body of
 * each guard, the body of each cmd builder. Those bodies arrive PRE-NARROWED to
 * their use site, because the graph says where they are used.
 *
 * The drawing therefore cannot drift, in the strong sense: it is not generated
 * FROM the machine, it IS the machine.
 *
 *   defineChart(graph)              → C            // the grid form: state × event
 *   compile(C, parts, ns?)          → Transitions  // drops into `defineMachine`
 *   initFrom(C, boot)               → init         // entry state read off the graph
 *   chartMermaid(C, opts?)          → string       // highlight / phases / title
 *
 *   defineReducerChart(graph)       → C            // no phase dimension: |M| edges
 *   compileReducer(C, parts, ns?)   → Reducer
 *   reducerInitFrom(C, boot)        → init
 *   reducerMermaid(C)               → string
 *
 *   ty<T>()                         → Ty<T>        // a payload type, as a value
 *
 * TWO FORMS, one substrate. The grid form answers |S| × |M| questions and is
 * total over them — a pair is DECLARED, or REFUSED (by the event's `scope`, by
 * the state's `ignore`, or by `end: true`), and there is no third case. Many
 * real machines answer only |M| of those: the logic is keyed by the MESSAGE and
 * `state.type` is a label the handler writes rather than a dimension it
 * dispatches on. `defineReducerChart` is the same chart with that dimension
 * dropped, compiling to a flat `Reducer`.
 *
 * THE ESCAPE HATCH. An edge may be `{ to, cell }` — code picks the next state
 * and returns its own cmds — which is what wrapping a battery verb (`poller`,
 * `retry-backoff`, `circuit-breaker`) actually needs. The bargain is `to`: the
 * code decides, but only among the targets the chart admits, so the drawing
 * still shows the whole fan-out. That clamp is a compile error wherever
 * TypeScript can express it, and {@link CellTargetError} at runtime where it
 * cannot (the function form of a multi-site cell — see `Cells`).
 *
 * NAMESPACING. `compile`/`compileReducer` take an optional `ns`, applied
 * per-event: two instances of the same chart get disjoint Msg alphabets
 * (`JOB_A.START` vs `JOB_B.START`), while an event marked `foreign: true` — a
 * library's Msg, `deadline_exceeded` say — keeps its bare name, because it is
 * not ours to decorate. `MsgIn<C, NS>` is the resulting inbound union.
 *
 * INSPECTING ONE. Because all of that is data, a chart can be read back:
 * `@demlik/tea/chart/inspect` turns it into phases, states, edges and every
 * explicit REFUSAL, and answers "what is legal at this state, and which branch
 * would that guard take right now"; `@demlik/tea/chart/inspect/react` is the
 * whole debugger page over it, with no page code.
 *
 * @packageDocumentation
 */

export {
  CellTargetError,
  chartMermaid,
  compile,
  compileReducer,
  initFrom,
  initialStateOf,
  type Parts,
  type RParts,
  reducerInitFrom,
  reducerMermaid,
} from "./compile";
export {
  type Assigns,
  type CellName,
  type Cells,
  type Chart,
  type CmdName,
  type CmdOf,
  type Cmds,
  defineChart,
  defineReducerChart,
  type EdgeKey,
  type EdgeSpec,
  type EventName,
  type ForeignEvent,
  type GroupName,
  type GroupOf,
  type GuardName,
  type Guards,
  type InitialState,
  type MissingPairs,
  type MsgIn,
  type MsgOf,
  type ParkingState,
  type RAssigns,
  type RCellName,
  type RCells,
  type RCmds,
  type ReducerChart,
  type RGuardName,
  type RGuards,
  type RStateName,
  type RStateOf,
  type RUsedCmdName,
  type StateName,
  type StateOf,
  type Ty,
  ty,
  type UsedCmdName,
} from "./graph";
