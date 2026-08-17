// ═══════════════════════════════════════════════════════════════════════════
// THE DIAGRAM SEAM.
//
// `chartMermaid(chart)` already draws a chart. What a report needs on top is
// two facts the chart alone does not carry — WHERE THE TASK IS NOW, and WHICH
// EDGES IT WALKED TO GET THERE — and those are options on the drawing, not a
// second drawing.
//
// So this file is ONE function, `drawTask`, and its body is a placeholder. The
// option-taking `chartMermaid(chart, opts?)` is being added in `compile.ts` by
// another hand; when it lands, the body below becomes
//
//     return chartMermaid(chart, { highlight: opts.current, thicken: opts.walked });
//
// and everything else in this module is untouched, because nothing else in this
// module draws. That is the whole point of the seam: the report's markdown
// layout, its vocabulary and its timeline do not know how a diagram is made,
// and swapping the maker is a one-line edit in one file.
//
// WHAT MERMAID CAN AND CANNOT DO, stated so the substitute is judged fairly:
// `stateDiagram-v2` supports `classDef`/`class`, so LIGHTING A NODE is real
// styling. It supports no per-edge styling at all — there is no `linkStyle` for
// a state diagram — so "thickened" is rendered as a mark ON THE EDGE LABEL
// (`»` plus the visit count). That is a genuine reduction and it is called out
// here rather than in a changelog nobody reads.
// ═══════════════════════════════════════════════════════════════════════════
import { type ImportedChart, statesOf } from "./workflow";

/** How many times each `${from}|${event}|${to}` edge was walked. */
export type WalkCounts = ReadonlyMap<string, number>;

export interface DrawOptions {
  /** The state the task is in right now — lit. */
  readonly current?: string;
  /** Edges the log actually walked, keyed `${from}|${event}|${to}`. */
  readonly walked?: WalkCounts;
}

/** The key `walked` is read by — one spelling, used by the walker and the drawer. */
export const edgeKey = (from: string, event: string, to: string): string =>
  `${from}|${event}|${to}`;

/**
 * One task's region as a mermaid `stateDiagram-v2` block, with the current node
 * lit and the walked edges marked.
 *
 * @see the file banner for the seam this stands in for.
 */
export function drawTask(chart: ImportedChart, opts: DrawOptions = {}): string {
  const walked = opts.walked ?? new Map<string, number>();
  const lines = ["stateDiagram-v2", "  direction TB"];
  const mark = (from: string, event: string, to: string): string => {
    const n = walked.get(edgeKey(from, event, to)) ?? 0;
    return n === 0 ? "" : n === 1 ? " »" : ` »×${n}`;
  };

  for (const [state, node] of statesOf(chart)) {
    if (node.initial === true) lines.push(`  [*] --> ${state}`);
    for (const [event, edge] of Object.entries(node.on ?? {})) {
      if ("resume" in edge) {
        const to = edge.resume.fallback;
        lines.push(
          `  ${state} --> ${to} : ${event} (resume)${mark(state, event, to)}`,
        );
      } else if ("when" in edge) {
        lines.push(
          `  ${state} --> ${edge.target} : ${event} [${edge.when}]${mark(state, event, edge.target)}`,
        );
        lines.push(
          `  ${state} --> ${edge.otherwise} : ${event} [!${edge.when}]${mark(state, event, edge.otherwise)}`,
        );
      } else {
        lines.push(
          `  ${state} --> ${edge.target} : ${event}${mark(state, event, edge.target)}`,
        );
      }
    }
    if (node.end !== undefined) lines.push(`  ${state} --> [*]`);
  }

  // The polarity, drawn. `shipped` and `frozen` are both finals and they are
  // not the same ending; a picture that painted them alike would be lying in
  // the one place a reader looks first.
  const success: string[] = [];
  const failure: string[] = [];
  for (const [state, node] of statesOf(chart)) {
    if (node.end === true) success.push(state);
    if (node.end === "error") failure.push(state);
  }
  lines.push("  classDef current font-weight:bold,stroke-width:3px");
  lines.push("  classDef tripped stroke-dasharray:4 4");
  if (failure.length > 0) lines.push(`  class ${failure.join(",")} tripped`);
  if (success.length > 0) {
    lines.push("  classDef shipped stroke-width:2px");
    lines.push(`  class ${success.join(",")} shipped`);
  }
  if (opts.current !== undefined) lines.push(`  class ${opts.current} current`);
  return lines.join("\n");
}

/**
 * The edges a log walked, counted — the input `drawTask` thickens from.
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
