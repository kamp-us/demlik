// ═══════════════════════════════════════════════════════════════════════════
// THE REDUCER FORM, AS A DEBUGGER READS IT — the honest subset.
//
// `defineReducerChart` drops the dimension the machine does not have: no
// phases, no per-state `on`, no `scope`, no `ignore`, no `end`. So its
// description is not `ChartDescription` with some fields left empty; it is a
// genuinely THINNER shape, and the whole design rule of this file is that the
// thinness is stated rather than faked.
//
// WHAT IT CAN TRUTHFULLY SAY
//   - the flat state list, and the entry state (`initial`, one word);
//   - the event alphabet, each with `foreign`, `from` provenance, and whether
//     it declares a payload;
//   - per-event routing — the same four edge kinds, including a `{ to, cell }`
//     edge's whole declared fan-out;
//   - TOTALITY over events, which this form enforces MORE strictly than the
//     grid form: `on` is a required mapped type over the alphabet, so an event
//     with no edge is a missing property tsc names, where the grid form's
//     `scope: "edges"` lets an event be routed from nowhere at all.
//
// WHAT IT CANNOT, AND WILL NOT PRETEND TO
//   - per-state REFUSAL. A reducer cell receives the whole state un-narrowed
//     and decides inside its body; there is no (state, event) pair for the
//     chart to refuse. An empty `refusals: []` would read as "nothing is
//     refused", which is the loudest possible wrong answer — so the field holds
//     an {@link Unanswerable} instead, and a consumer that tries to iterate it
//     gets a type error rather than a comfortable lie.
//   - phases, and event `scope`. Same reason, same treatment.
// ═══════════════════════════════════════════════════════════════════════════

import type { EventOrigin, ReducerChart } from "../graph";
import { type EdgeCore, type RtEdge, readEdgeCore } from "./describe";
import {
  type GuardPreview,
  type InspectOptions,
  previewGuardOn,
  type ResolvedBy,
  runCellOn,
} from "./live";
import { sampleMsg } from "./samples";

// ── the runtime view (the same shape `compileReducer` reads) ──────────────
type RtReducerChart = {
  readonly ctx?: object;
  readonly states: readonly string[];
  readonly initial: string;
  readonly events: Record<
    string,
    {
      readonly foreign?: true;
      readonly from?: EventOrigin;
      readonly data?: object;
    }
  >;
  readonly cmds?: Record<string, object>;
  readonly on: Record<string, RtEdge>;
};

/**
 * A QUESTION THIS FORM CANNOT ANSWER, carried in the slot where the grid form
 * carries the answer.
 *
 * `answerable: false` is the whole type: there is no `true` member, because a
 * question this form CAN answer is answered with the answer. So `desc.refusals`
 * on a reducer description is not an empty list a UI silently renders — it is a
 * value whose only shape says why the list is not there, and code written
 * against the grid form's array fails to compile against it.
 */
export interface Unanswerable<Q extends string> {
  readonly answerable: false;
  /** Which question — the grid-form field this stands in for. */
  readonly question: Q;
  /** One line, ready to render. */
  readonly why: string;
}

const NO_PHASES: Unanswerable<"phases"> = {
  answerable: false,
  question: "phases",
  why: "this chart form has no phase dimension — every edge is reachable from every state",
};
const NO_REFUSALS: Unanswerable<"refusals"> = {
  answerable: false,
  question: "refusals",
  why: "this chart form has no state dimension — a refusal is a (state, event) fact, and a reducer cell decides inside its body",
};
const NO_SCOPE: Unanswerable<"scope"> = {
  answerable: false,
  question: "scope",
  why: "this chart form has no phase dimension — `scope` answers 'at which states does this event mean anything', which has no content here",
};

/** One edge of a reducer chart — an edge with no state to leave from. */
export type ReducerEdge = EdgeCore;

/** One event of a reducer chart's alphabet. `scope` has no counterpart here. */
export interface ReducerEventInfo {
  readonly name: string;
  /** `foreign: true` — the name belongs to someone else and stays bare. */
  readonly foreign: boolean;
  /** WHO SENDS THIS. `undefined` means the chart does not say — never a guess. */
  readonly from?: EventOrigin;
  /** Whether the event declared a payload (`data: ty<…>()`). */
  readonly hasPayload: boolean;
  /** `false` iff the chart declares this event and routes it nowhere. */
  readonly routed: boolean;
}

/**
 * A reducer-form chart, as data a UI can build itself from — the same contract
 * as {@link import("./describe").ChartDescription}, over the facts this form
 * actually has.
 */
export interface ReducerChartDescription {
  /** The declared state names, in declaration order. Flat: there are no groups. */
  readonly states: readonly string[];
  /** The entry state — the chart's `initial` field, not a marked node. */
  readonly initial: string;
  readonly events: readonly ReducerEventInfo[];
  /** Every cmd DECLARED in the `cmds` section — the effect alphabet. */
  readonly cmds: readonly string[];
  readonly guards: readonly string[];
  readonly cells: readonly string[];
  /** One edge per routed event, in the alphabet's declaration order. */
  readonly edges: readonly ReducerEdge[];
  /**
   * TOTALITY, read back off the value: `true` iff every declared event owes and
   * has an edge. Through the typed door this is always `true` — `on` is a
   * required mapped type — so a `false` here means the types were bypassed with
   * a cast, exactly as `refusals`' `undeclared` kind does in the grid form.
   */
  readonly total: boolean;
  /** The declared events with no edge. Empty through the typed door. */
  readonly missing: readonly string[];
  /** NOT AVAILABLE — see {@link Unanswerable}. */
  readonly phases: Unanswerable<"phases">;
  /** NOT AVAILABLE — see {@link Unanswerable}. */
  readonly refusals: Unanswerable<"refusals">;
  /** NOT AVAILABLE — see {@link Unanswerable}. */
  readonly scope: Unanswerable<"scope">;
}

/**
 * Read a reducer-form chart into its {@link ReducerChartDescription}.
 *
 * Pure, total and allocation-only, exactly as `describeChart` is: it never runs
 * a guard, a cell or a payload builder, so it is safe on a chart whose parts do
 * not exist yet.
 */
export function describeReducerChart<const C extends ReducerChart<C>>(
  chart: C,
): ReducerChartDescription {
  const c = chart as unknown as RtReducerChart;

  const edges: ReducerEdge[] = [];
  const events: ReducerEventInfo[] = [];
  const missing: string[] = [];
  const guards = new Set<string>();
  const cells = new Set<string>();

  for (const [name, decl] of Object.entries(c.events)) {
    // the site key IS the event: one dimension, so `at` is the bare name — the
    // same key `compileReducer` hands guards, cmds and cells.
    const spec = c.on?.[name];
    if (spec === undefined) {
      missing.push(name);
    } else {
      const edge = readEdgeCore(name, name, spec);
      edges.push(edge);
      if (edge.guard !== undefined) guards.add(edge.guard);
      if (edge.cell !== undefined) cells.add(edge.cell);
    }
    events.push({
      name,
      foreign: decl?.foreign === true,
      ...(decl?.from === undefined ? {} : { from: decl.from }),
      hasPayload: decl !== undefined && "data" in decl,
      routed: spec !== undefined,
    });
  }

  return {
    states: [...(c.states ?? [])],
    initial: c.initial,
    events,
    cmds: Object.keys(c.cmds ?? {}),
    guards: [...guards],
    cells: [...cells],
    edges,
    total: missing.length === 0,
    missing,
    phases: NO_PHASES,
    refusals: NO_REFUSALS,
    scope: NO_SCOPE,
  };
}

/** The edge that routes `event`, or `undefined` when the chart routes it nowhere. */
export function reducerEdgeAt(
  desc: ReducerChartDescription,
  event: string,
): ReducerEdge | undefined {
  return desc.edges.find((e) => e.event === event);
}

// ── the live layer ────────────────────────────────────────────────────────

/**
 * What would happen if `event` were dispatched at the current state.
 *
 * There is NO `status` field, and its absence is the honest part: this form
 * cannot refuse an event — `on` is total over the alphabet and there is no
 * state dimension to refuse from — so a "legal" tag would be a distinction
 * without a second case. Everything a grid preview can still say here it says:
 * the edge, the guard's branch, the declared fan-out, the target a cell picks.
 *
 * The cmds are the DECLARED ones — the before question. For what actually
 * fired, see `captureCmds` in `./captured`.
 */
export interface ReducerEventPreview {
  readonly event: string;
  /** The event's declared `from`, carried through rather than recomputed. */
  readonly from?: EventOrigin;
  /** The declared edge. `undefined` only when the chart routes the event nowhere. */
  readonly edge?: ReducerEdge;
  /** Present iff the edge is guarded. */
  readonly guard?: GuardPreview;
  /** The cmds the edge DECLARES for the arm that resolved. */
  readonly cmds: readonly string[];
  /** Every state the edge declares it can reach. */
  readonly targets: readonly string[];
  /** The single target, when one is determined. */
  readonly resolved?: string;
  /** How {@link ReducerEventPreview.resolved} was determined. */
  readonly resolvedBy?: ResolvedBy;
  /** The msg this preview used, or `undefined` when no sample was supplied. */
  readonly msg?: { readonly type: string };
}

/**
 * Preview one event of a reducer chart against a live state.
 *
 * The guard and cell previews are the SAME functions the grid form uses — a
 * guard is pure and a cell is pure in both forms, and the only difference is
 * that `at` is the bare event name.
 */
export function previewReducerEvent<S extends { readonly type: string }>(
  desc: ReducerChartDescription,
  state: S,
  event: string,
  opts: InspectOptions = {},
): ReducerEventPreview {
  const info = desc.events.find((e) => e.name === event);
  const from = info?.from === undefined ? {} : { from: info.from };
  const edge = reducerEdgeAt(desc, event);

  if (edge === undefined) {
    // Unreachable through the typed door: `on` is a required mapped type. It is
    // reported rather than swallowed for the same reason `undeclared` is — a
    // chart that reaches here was cast into existence.
    return { event, ...from, cmds: [], targets: [] };
  }

  const msg = sampleMsg(event, info?.hasPayload === true, opts.samples);
  const base = { event, ...from, edge, targets: edge.targets, msg };

  switch (edge.kind) {
    case "plain":
      return {
        ...base,
        cmds: edge.cmds,
        resolved: edge.targets[0],
        resolvedBy: edge.targets.length === 1 ? "declared" : undefined,
      };

    case "guarded": {
      const guard = previewGuardOn(edge, state, msg, opts);
      return {
        ...base,
        guard,
        cmds: guard.branch === "unknown" ? edge.cmds : guard.cmds,
        resolved: guard.branch === "unknown" ? undefined : guard.target,
        resolvedBy: guard.branch === "unknown" ? undefined : "guard",
      };
    }

    case "cell": {
      const resolved = runCellOn(edge, state, msg, opts);
      return {
        ...base,
        // A cell builds its own cmds in its body, so the chart declares none —
        // empty BY DECLARATION, which is exactly the gap `captureCmds` closes.
        cmds: edge.cmds,
        resolved,
        resolvedBy: resolved === undefined ? undefined : "cell",
      };
    }

    // `resume` needs a phase dimension and `defineReducerChart` rejects it by
    // name (`__resumeNeedsAPhaseDimension`). Reaching here means a cast; the
    // declared fallback is the only truthful answer left.
    case "resume":
      return {
        ...base,
        cmds: edge.cmds,
        resolved: edge.fallback,
        resolvedBy: "resume",
      };
  }
}

/**
 * Preview EVERY event of a reducer chart's alphabet against a live state, in
 * declaration order. The button row — and here every control is live, because
 * this form has nothing with which to refuse one.
 */
export function inspectReducerState<S extends { readonly type: string }>(
  desc: ReducerChartDescription,
  state: S,
  opts: InspectOptions = {},
): readonly ReducerEventPreview[] {
  return desc.events.map((e) => previewReducerEvent(desc, state, e.name, opts));
}
