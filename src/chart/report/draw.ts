// ═══════════════════════════════════════════════════════════════════════════
// THE DIAGRAM SEAM — now a translation, not a drawing.
//
// This file used to hold a SECOND mermaid renderer, standing in until
// `chartMermaid` grew an options bag. It grew one, so the swap this banner
// promised has happened: `drawTask` is the report's door onto the one renderer
// in `../compile`, and the two facts a report needs on top of the chart —
// WHERE THE TASK IS NOW and WHICH EDGES IT WALKED — are options on that
// drawing rather than a drawing of their own.
//
// The seam itself is unchanged and is why the swap was one function wide: the
// report's markdown layout, its vocabulary and its timeline do not know how a
// diagram is made.
//
// WHY THIS FILE STILL EXISTS rather than the report calling `chartMermaid`
// directly. `chartMermaid` is typed `<const C extends Chart<C>>` — the
// F-bounded literal chart, whose state and event names are literal types the
// compiler recovered from a source literal. A report draws an `ImportedChart`,
// whose every name is a runtime `string` read out of somebody's
// `workflow.json`. That widening is real and it is not the report's to make at
// eight call sites: it is made here, once, with the reason written next to it.
// ═══════════════════════════════════════════════════════════════════════════
import { chartMermaid, type WalkCounts } from "../compile";
import type { ImportedChart } from "./workflow";

export { edgeKey, type WalkCounts } from "../compile";

export interface DrawOptions {
  /** The state the task is in right now — lit. */
  readonly current?: string;
  /** Edges the log actually walked, keyed `${from}|${event}|${to}`. */
  readonly walked?: WalkCounts;
}

/**
 * One task's region as a mermaid `stateDiagram-v2` block, with the current node
 * lit, the walked edges marked and the two endings drawn apart.
 *
 * `polarity` is always on: a lane's whole point is that `shipped` and `frozen`
 * are not the same ending, and a report that painted them alike would be lying
 * in the place a reader looks first. It is an OPTION on the renderer rather
 * than a default because a chart drawing is something a reviewer approves —
 * see `ChartMermaidOptions.polarity`.
 */
export function drawTask(chart: ImportedChart, opts: DrawOptions = {}): string {
  return chartMermaid(chart as never, {
    polarity: true,
    ...(opts.current === undefined ? {} : { highlight: opts.current }),
    ...(opts.walked === undefined ? {} : { walked: opts.walked }),
  });
}

/**
 * The edges a log walked, counted — the input `drawTask` marks from.
 *
 * Reads each step's DECLARED `edge` rather than recomputing one from
 * `from`/`event`/`to`: a resume edge is drawn to its fallback and walked to
 * wherever `was` pointed, so the observed target names an edge the drawing does
 * not have. `TimelineStep.edge` is the edge that actually fired.
 */
export function walkedEdges(
  steps: readonly { readonly edge: string }[],
): WalkCounts {
  const counts = new Map<string, number>();
  for (const step of steps) {
    counts.set(step.edge, (counts.get(step.edge) ?? 0) + 1);
  }
  return counts;
}
