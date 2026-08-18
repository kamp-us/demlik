/**
 * the chart, as a debugger reads it — headless, framework-free, pure.
 *
 * A hand-built debugger page for a machine needs four things, and someone
 * types all four by hand: the list of messages (for the button row), the state
 * names (for the diagram), which control is disabled when (for the legality),
 * and what each payload looks like (to dispatch anything at all). Every one of
 * those is already IN the chart, which is why this module exists: point it at
 * a chart and it answers all four, so a UI can build itself with no page code.
 *
 * ```text
 *   describeChart(C)                     → ChartDescription  // static: phases,
 *                                                            // states, edges,
 *                                                            // REFUSALS
 *   inspectState(desc, state, opts)      → EventPreview[]    // live: what is
 *                                                            // legal right now
 *   previewEvent(desc, state, e, opts)   → EventPreview      // live: one event
 *   captureCmds(machine, { msgs, ctx })  → CmdCapture        // after: what
 *                                                            // ACTUALLY fired
 *   describeReducerChart(C)              → ReducerChartDescription
 *   inspectReducerState(desc, state)     → ReducerEventPreview[]
 *   Samples<C>                                               // the sample bag,
 *                                                            // typed BY the chart
 * ```
 *
 * BEFORE AND AFTER ARE DIFFERENT QUESTIONS, and this module keeps them apart.
 * `EventPreview.cmds` is what an edge DECLARES it would fire — the before
 * question, answerable with no run at all, and empty by declaration on a
 * `{ to, cell }` edge because the cell builds its cmds in its body.
 * `captureCmds` is what a recorded run DID fire, per step, tagged with the msg
 * that caused it — read back off `replay`'s own output, which is the same pure
 * fold the scrubber already uses, so there is no observer to install and no
 * second answer to keep in sync.
 *
 * THE REDUCER FORM gets `describeReducerChart`, which is deliberately a THINNER
 * shape rather than the grid one with holes: a flat state list, the event
 * alphabet with `from` provenance, per-event routing including a cell edge's
 * fan-out, and totality over events (which this form enforces more strictly
 * than the grid — `on` is a required mapped type). Per-state refusals, phases
 * and `scope` are not available at all, and each of those slots holds an
 * `Unanswerable` saying so — never an empty list that would read as "nothing is
 * refused".
 *
 * THE TWO THINGS THIS KNOWS THAT NO OTHER INSPECTOR DOES.
 *
 * 1. **Refusals are first-class.** The chart is TOTAL over (state × event): a
 *    pair is declared, or refused — by the event's `scope`, by the state's
 *    `ignore`, or by `end: true` — and there is no third case. So a refused
 *    event is not a missing button; it is a control rendered as refused, with
 *    the reason. `describeChart` returns every refusal with the evidence that
 *    produced it, derived by the SAME predicate `compile` uses to choose
 *    between a self-loop and a `NoCellError`.
 *
 * 2. **The guard preview.** Given a live state and a sample msg, the named
 *    guard is EXECUTED (it is pure — the same thing `replay` may call) and the
 *    branch it takes, `then` or `else`, is reported with that arm's target and
 *    cmds. Where it cannot be evaluated — no sample, no bag, a throwing body —
 *    it degrades to `unknown` carrying the reason, never to a guess.
 *
 * WHAT THE AUTHOR STILL SUPPLIES, AND WHY. Exactly one thing: `Samples<C>`.
 * `ty<T>()` is `{}` at runtime (graph.ts:33), so a payload's SHAPE is erased
 * before any runtime code could read it — no amount of derivation recovers
 * `{ at: number }` from `{}`. The bag is typed by the chart all the same: it is
 * keyed by the events that declare a payload, each entry is exactly that
 * event's declared type, an event with no payload has no key to write, and a
 * typo'd name is an excess property. Same use-site scanning idiom as
 * `Assigns`/`Guards`/`Cmds`.
 *
 * The React binding over this lives at `@demlik/tea/chart/inspect/react`.
 *
 * @packageDocumentation
 */

export {
  type CapturedStep,
  type CaptureInput,
  type CmdCapture,
  captureCmds,
  firedAt,
  firedCounts,
} from "./captured";
export {
  type ChartDescription,
  type ChartEdge,
  type ChartEventInfo,
  type ChartRefusal,
  type ChartStateInfo,
  describeChart,
  type EdgeCore,
  type EdgeKind,
  edgeAt,
  explainRefusal,
  type RefusalReason,
  refusalAtState,
  stateInfo,
} from "./describe";
export {
  type AnyCell,
  type AnyGuard,
  type EventPreview,
  type GuardPreview,
  type GuardUnknown,
  type InspectOptions,
  type InspectParts,
  inspectState,
  inspectStateSummary,
  previewEvent,
  type ResolvedBy,
} from "./live";
export {
  describeReducerChart,
  inspectReducerState,
  previewReducerEvent,
  type ReducerChartDescription,
  type ReducerEdge,
  type ReducerEventInfo,
  type ReducerEventPreview,
  reducerEdgeAt,
  type Unanswerable,
} from "./reducer";
export {
  type RtSamples,
  type SamplePayload,
  type Samples,
  sampleMsg,
} from "./samples";
