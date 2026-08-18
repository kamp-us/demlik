// ═══════════════════════════════════════════════════════════════════════════
// THE STATIC DESCRIPTION — a chart, read as data.
//
// Everything a debugger UI needs to build itself is already IN the chart: the
// phases, the states, which one is the entry, which are terminal, every edge
// with its event / targets / guard / cell / cmds, and — the part no other
// inspector has — every explicit REFUSAL, because the chart's totality means a
// (state, event) pair is DECLARED or REFUSED and there is no third case.
//
// So this module hand-lists nothing. It walks the same runtime views `compile`
// walks, and it derives refusals with the SAME predicate `compile` uses to
// decide between a self-loop and a `NoCellError` — one rule, read twice, so
// the picture and the machine cannot disagree about what is refused.
//
// PURE and framework-free. No React, no DOM, no `Machine`. A script, an Ink
// TUI, or a test gets exactly this.
// ═══════════════════════════════════════════════════════════════════════════

import type { Chart, EventOrigin } from "../graph";

// ── the runtime views (the same shapes `compile` reads) ───────────────────
export type RtEdge =
  | string
  | {
      readonly target?: string;
      readonly when?: string;
      readonly otherwise?: string;
      readonly cmd?: string | readonly string[];
      readonly otherwiseCmd?: string | readonly string[];
      readonly resume?: { readonly fallback: string };
      readonly to?: readonly string[];
      readonly cell?: string;
    };
type RtNode = {
  readonly initial?: true;
  readonly data?: object;
  readonly on?: Record<string, RtEdge>;
  readonly ignore?: readonly string[];
  // BOTH POLARITIES. `end: true` (reached the goal) and `end: "error"` (stopped
  // because it failed) are both finals — `graph.ts`'s `IsEndOf` reads the pair,
  // and `end-polarity.test.ts` pins the two runtime sites that used to read
  // only `=== true`. This was the third such site: an error final described
  // here as `end: false` re-acquired the totality obligation, so a scoped event
  // over it came back `undeclared` ("the chart's totality was bypassed")
  // instead of refused — the loudest possible wrong answer.
  readonly end?: true | "error";
};
type RtChart = {
  readonly ctx?: object;
  readonly events: Record<
    string,
    {
      readonly scope: string | readonly string[];
      readonly foreign?: true;
      readonly from?: EventOrigin;
      readonly data?: object;
    }
  >;
  readonly cmds?: Record<string, object>;
  readonly states: Record<string, Record<string, RtNode>>;
};

/** `undefined` → none; `"x"` → one; `["x","y"]` → both, in declaration order. */
function cmdNames(
  ref: string | readonly string[] | undefined,
): readonly string[] {
  if (ref === undefined) return [];
  return typeof ref === "string" ? [ref] : [...ref];
}

function scopeList(scope: string | readonly string[]): readonly string[] {
  return typeof scope === "string" ? [scope] : [...scope];
}

// ── the description ───────────────────────────────────────────────────────

/**
 * WHY a (state, event) pair is refused. The chart's three refusal mechanisms,
 * each carrying the evidence that produced it, so a UI can say *"`WIP` is not
 * addressed to `blocked` — its scope is `edges`"* rather than "disabled".
 *
 * `undeclared` is the fourth case the type layer forbids: a pair that is live,
 * unhandled and unrefused. It cannot occur on a chart that compiled through
 * `defineChart`, and it is reported rather than swallowed because reaching it
 * means the types were bypassed with a cast — which is precisely when a
 * debugger should say so instead of drawing a well-behaved button.
 */
export type RefusalReason =
  | {
      readonly kind: "end";
      /** Terminal state: it accepts nothing, by declaration. */
      readonly state: string;
    }
  | {
      readonly kind: "out-of-scope";
      /** The event's declared `scope`, flattened to its members. */
      readonly scope: readonly string[];
      /** The phase this state lives in — the one that is not in `scope`. */
      readonly phase: string;
    }
  | {
      readonly kind: "ignored";
      /** The event is live here and this state refuses it BY NAME. */
      readonly state: string;
    }
  | { readonly kind: "undeclared" };

/** A one-line, human-readable rendering of a {@link RefusalReason}. */
export function explainRefusal(event: string, reason: RefusalReason): string {
  switch (reason.kind) {
    case "end":
      return `"${reason.state}" is an end state — it accepts nothing`;
    case "out-of-scope":
      return `"${event}" is not addressed to phase "${reason.phase}" (scope: ${reason.scope.join(", ")})`;
    case "ignored":
      return `"${reason.state}" lists "${event}" in its \`ignore\``;
    case "undeclared":
      return `"${event}" is live here, unhandled and unrefused — the chart's totality was bypassed`;
  }
}

/** What kind of transition an edge declares. */
export type EdgeKind = "plain" | "guarded" | "cell" | "resume";

/** One declared edge — a `(state, event)` pair the chart routes. */
export interface ChartEdge {
  readonly from: string;
  readonly event: string;
  /** `"${from}.${event}"` — the site key guards/cmds/cells are indexed by. */
  readonly at: string;
  readonly kind: EdgeKind;
  /**
   * Every state this edge can land on, in declaration order. A guarded edge
   * contributes both arms; a cell edge contributes its whole declared `to`.
   * For a resume edge this is the fallback alone — the real target is
   * `state.was`, which is a property of the LIVE state, not of the chart.
   */
  readonly targets: readonly string[];
  /** The guard's name, on a guarded edge. */
  readonly guard?: string;
  /** The target taken when the guard HOLDS. */
  readonly then?: string;
  /** The target taken when the guard FAILS. */
  readonly otherwise?: string;
  /** The cell's name, on a `{ to, cell }` edge. */
  readonly cell?: string;
  /** The declared fallback, on a `resume` edge. */
  readonly fallback?: string;
  /** Cmds fired when the edge fires (the guard's `then` arm, if guarded). */
  readonly cmds: readonly string[];
  /** Cmds fired when the guard FAILS. Empty unless the edge is guarded. */
  readonly otherwiseCmds: readonly string[];
}

/** A (state, event) pair the chart explicitly refuses, and why. */
export interface ChartRefusal {
  readonly from: string;
  readonly event: string;
  readonly reason: RefusalReason;
}

/** One state, with the facts the chart declares about it. */
export interface ChartStateInfo {
  readonly name: string;
  /** The phase it was declared under. */
  readonly phase: string;
  /** `initial: true` — the entry state. Exactly one per machine-bearing chart. */
  readonly initial: boolean;
  /**
   * Terminal by DECLARATION, not by "has no outgoing edges" — `true` for both
   * polarities, because both accept nothing and both owe nothing.
   */
  readonly end: boolean;
  /**
   * WHICH ending. `true` a success final, `"error"` the failure terminal,
   * `false` not a final at all.
   *
   * `end` answers "does this accept anything"; this answers "did the machine
   * win or lose". A lane needs both and they are not the same question —
   * `shipped` and `frozen` are equally terminal and are not the same outcome.
   */
  readonly endPolarity: false | true | "error";
  /** Carries a `resume` edge out of it, so the compiler injects `was` here. */
  readonly parking: boolean;
}

/** One event of the alphabet. */
export interface ChartEventInfo {
  readonly name: string;
  /** The declared `scope`, flattened: `"edges"`, `"all"`, or phase names. */
  readonly scope: readonly string[];
  /** `foreign: true` — the name belongs to someone else and stays bare. */
  readonly foreign: boolean;
  /**
   * WHERE THIS EVENT COMES FROM — `from`, read back off the chart.
   *
   * `undefined` means the chart does not say, which is a fact of its own and
   * never a default: a UI that groups its button row by sender must render the
   * undeclared ones as undeclared rather than filing them under a guess.
   */
  readonly from?: EventOrigin;
  /**
   * Whether the event DECLARED a payload (`data: ty<…>()`).
   *
   * `ty<T>()` is `{}` at runtime, so `T` is unreadable — but the `data` KEY is
   * right there in the literal, so "does this event carry a payload at all" IS
   * a runtime fact. It is what decides whether a sample is required.
   */
  readonly hasPayload: boolean;
}

/**
 * A whole chart, as data a UI can build itself from. Nothing here is supplied
 * by the caller; every field is read off the one chart value.
 */
export interface ChartDescription {
  /** The phases, in declaration order, each with its member states. */
  readonly phases: readonly {
    readonly name: string;
    readonly states: readonly string[];
  }[];
  readonly states: readonly ChartStateInfo[];
  /** The state marked `initial: true`, or `undefined` on a chart with none. */
  readonly initial: string | undefined;
  readonly events: readonly ChartEventInfo[];
  /** Every cmd DECLARED in the `cmds` section — the effect alphabet. */
  readonly cmds: readonly string[];
  /** Every guard name any edge references. */
  readonly guards: readonly string[];
  /** Every cell name any `{ to, cell }` edge references. */
  readonly cells: readonly string[];
  readonly edges: readonly ChartEdge[];
  readonly refusals: readonly ChartRefusal[];
}

/**
 * A read edge MINUS the state it leaves — everything about an edge that is a
 * fact of the edge itself rather than of the grid it sits in.
 *
 * The reducer form has no state dimension (`src/chart/inspect/reducer.ts`), so
 * its edges are exactly this: same kinds, same targets, same guard/cell/cmd
 * fields, with `from` unrepresentable rather than blank.
 */
export type EdgeCore = Omit<ChartEdge, "from">;

/**
 * Read one edge spec into {@link EdgeCore}. `at` is the site key the parts bag
 * is indexed by — `"state.event"` in the grid form, the bare event in the
 * reducer form — and it is passed in rather than derived, because that key IS
 * the difference between the two forms.
 */
export function readEdgeCore(
  event: string,
  at: string,
  spec: RtEdge,
): EdgeCore {
  const edge = typeof spec === "string" ? { target: spec } : spec;
  const cmds = cmdNames(edge.cmd);
  const otherwiseCmds = cmdNames(edge.otherwiseCmd);

  if (edge.cell !== undefined) {
    return {
      event,
      at,
      kind: "cell",
      targets: [...(edge.to ?? [])],
      cell: edge.cell,
      cmds,
      otherwiseCmds,
    };
  }
  if (edge.resume !== undefined) {
    return {
      event,
      at,
      kind: "resume",
      targets: [edge.resume.fallback],
      fallback: edge.resume.fallback,
      cmds,
      otherwiseCmds,
    };
  }
  if (edge.when !== undefined) {
    const then = edge.target ?? "";
    const otherwise = edge.otherwise ?? "";
    return {
      event,
      at,
      kind: "guarded",
      targets: [then, otherwise],
      guard: edge.when,
      then,
      otherwise,
      cmds,
      otherwiseCmds,
    };
  }
  return {
    event,
    at,
    kind: "plain",
    targets: edge.target === undefined ? [] : [edge.target],
    cmds,
    otherwiseCmds,
  };
}

/** Read one edge spec into the flat {@link ChartEdge} shape. */
function readEdge(from: string, event: string, spec: RtEdge): ChartEdge {
  return { from, ...readEdgeCore(event, `${from}.${event}`, spec) };
}

/**
 * Why `from` refuses `event`, or `undefined` when it does not refuse it.
 *
 * THE SAME PREDICATE `compile` USES. `compile` computes `refused = end || !live
 * || ignore.includes(e)` to decide between a self-loop and a `NoCellError`;
 * this splits the same three tests apart to name WHICH one fired, in the order
 * that makes the most specific declaration win — `end: true` is a statement
 * about the state, `scope` about the event, `ignore` about the pair.
 */
function refusalAt(
  c: RtChart,
  node: RtNode,
  phase: string,
  state: string,
  event: string,
): RefusalReason | undefined {
  if (node.on?.[event] !== undefined) return undefined;
  if (node.end !== undefined) return { kind: "end", state };
  const scope = scopeList(c.events[event]?.scope ?? "edges");
  const live = scope.includes("all") || scope.includes(phase);
  if (!live) return { kind: "out-of-scope", scope, phase };
  if ((node.ignore ?? []).includes(event)) return { kind: "ignored", state };
  return { kind: "undeclared" };
}

/**
 * Read a chart into its {@link ChartDescription}.
 *
 * Pure, total, and allocation-only — it never executes a guard, a cell or a
 * payload builder, so it is safe on a chart whose parts do not exist yet.
 */
export function describeChart<const C extends Chart<C>>(
  chart: C,
): ChartDescription {
  const c = chart as unknown as RtChart;

  const phases: { name: string; states: string[] }[] = [];
  const states: ChartStateInfo[] = [];
  const edges: ChartEdge[] = [];
  const refusals: ChartRefusal[] = [];
  const guards = new Set<string>();
  const cells = new Set<string>();
  const parking = new Set<string>();
  let initial: string | undefined;

  // Pass 1 — the nodes, the phases and the edges. `parking` is a derivation
  // over the whole chart (a state is parking iff SOME edge out of it resumes),
  // so it is collected here and read in pass 2.
  const flat: { state: string; phase: string; node: RtNode }[] = [];
  for (const [phase, members] of Object.entries(c.states)) {
    const names: string[] = [];
    for (const [state, node] of Object.entries(members)) {
      names.push(state);
      flat.push({ state, phase, node });
      if (node.initial === true) initial ??= state;
      for (const [event, spec] of Object.entries(node.on ?? {})) {
        const edge = readEdge(state, event, spec);
        edges.push(edge);
        if (edge.guard !== undefined) guards.add(edge.guard);
        if (edge.cell !== undefined) cells.add(edge.cell);
        if (edge.kind === "resume") parking.add(state);
      }
    }
    phases.push({ name: phase, states: names });
  }

  // Pass 2 — the state records (which need `parking`) and the refusals (which
  // are a full |S| × |M| sweep minus the declared edges).
  const events = Object.keys(c.events);
  for (const { state, phase, node } of flat) {
    states.push({
      name: state,
      phase,
      initial: node.initial === true,
      end: node.end !== undefined,
      endPolarity: node.end ?? false,
      parking: parking.has(state),
    });
    for (const event of events) {
      const reason = refusalAt(c, node, phase, state, event);
      if (reason !== undefined) refusals.push({ from: state, event, reason });
    }
  }

  return {
    phases: phases.map((p) => ({ name: p.name, states: p.states })),
    states,
    initial,
    events: events.map((name) => {
      const decl = c.events[name];
      return {
        name,
        scope: scopeList(decl?.scope ?? "edges"),
        foreign: decl?.foreign === true,
        ...(decl?.from === undefined ? {} : { from: decl.from }),
        hasPayload: decl !== undefined && "data" in decl,
      };
    }),
    cmds: Object.keys(c.cmds ?? {}),
    guards: [...guards],
    cells: [...cells],
    edges,
    refusals,
  };
}

/** The declared edge out of `state` on `event`, or `undefined`. */
export function edgeAt(
  desc: ChartDescription,
  state: string,
  event: string,
): ChartEdge | undefined {
  return desc.edges.find((e) => e.from === state && e.event === event);
}

/** Why `state` refuses `event`, or `undefined` when it does not. */
export function refusalAtState(
  desc: ChartDescription,
  state: string,
  event: string,
): RefusalReason | undefined {
  return desc.refusals.find((r) => r.from === state && r.event === event)
    ?.reason;
}

/** The record for `state`, or `undefined` when the chart has no such state. */
export function stateInfo(
  desc: ChartDescription,
  state: string,
): ChartStateInfo | undefined {
  return desc.states.find((s) => s.name === state);
}
