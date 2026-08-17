// ═══════════════════════════════════════════════════════════════════════════
// RUNTIME — the chart walk that emits a real `Transitions<S, M, C>`.
// ═══════════════════════════════════════════════════════════════════════════
import { Cmd, NoCellError, type Reducer, type Transitions } from "../pure/core";
import type {
  Assigns,
  CellName,
  Cells,
  Chart,
  CmdOf,
  Cmds,
  GuardName,
  Guards,
  InitialData,
  InitialState,
  MsgIn,
  MsgOf,
  RAssigns,
  RCellName,
  RCells,
  RCmds,
  RGuardName,
  RGuards,
  RStateOf,
  RUsedCmdName,
  ReducerChart,
  StateOf,
  UsedCmdName,
} from "./graph";

/**
 * A cell returned a state OUTSIDE its edge's declared `to`.
 *
 * The escape hatch's bargain is that code may pick the target but only from the
 * set the chart admits — otherwise the drawing stops being a truthful picture
 * of the machine. For a SINGLE-site cell, and for the per-site form of a
 * multi-site one, the clamp is a compile error and this never fires. For the
 * function form of a MULTI-SITE cell it is the only enforcement there is: the
 * return of one rest signature over a union of tuples cannot be made to depend
 * on `at`, so the union of every site's `to` is the tightest static clamp
 * available and this closes the difference at the moment it is violated.
 *
 * It sits inside `buildCell`, so BOTH chart forms — the grid and the reducer —
 * get the same net from the same three lines.
 */
export class CellTargetError extends Error {
  override readonly name = "CellTargetError";
  readonly _tag = "CellTargetError" as const;
  constructor(
    public readonly at: string,
    public readonly cell: string,
    public readonly returned: string,
    public readonly declared: readonly string[],
  ) {
    super(
      `@demlik/tea: cell "${cell}" at edge "${at}" returned state ` +
        `"${returned}", which is not among that edge's declared targets ` +
        `[${declared.map((t) => `"${t}"`).join(", ")}] — either the cell is ` +
        `wrong, or the edge's \`to\` is missing a target the code can reach ` +
        `(in which case add it, so the chart still draws the whole fan-out).`,
    );
  }
}

/** `undefined` → none; `"x"` → one; `["x","y"]` → both, in order. */
function cmdNames(ref: string | readonly string[] | undefined): readonly string[] {
  if (ref === undefined) return [];
  return typeof ref === "string" ? [ref] : ref;
}

// There is no `unhandled` policy any more. A pair is DECLARED (an edge), or
// REFUSED — by the event's `scope`, or by this state's `ignore`, or by
// `end: true` — and `Total<C>` refuses to compile on any third case. The
// refusal is a self-loop with no cmds; the throw below is the safety net under
// the compile-time refusal (`.decisions/0011`), reached only when the mapped
// types were bypassed with a cast.
export type Parts<
  C,
  S extends { type: string },
  M extends { type: string },
> = {
  readonly assign: Assigns<C, S, M>;
} & ([GuardName<C>] extends [never]
  ? { readonly guards?: undefined }
  : { readonly guards: Guards<C, S, M> }) &
  ([UsedCmdName<C>] extends [never]
    ? { readonly cmds?: undefined }
    : { readonly cmds: Cmds<C, S, M> }) &
  // the escape hatch's bag — demanded exactly when an edge names a cell.
  ([CellName<C>] extends [never]
    ? { readonly cells?: undefined }
    : { readonly cells: Cells<C, S, M> });

// ── runtime views of the chart (the shapes the walk actually reads) ────────
type RtEdge =
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
  readonly on?: Record<string, RtEdge>;
  readonly ignore?: readonly string[];
  readonly end?: true;
};
type RtChart = {
  readonly events: Record<
    string,
    { readonly scope: string | readonly string[]; readonly foreign?: true }
  >;
  readonly states: Record<string, Record<string, RtNode>>;
};
type RtState = { readonly type: string; readonly was?: string };
type RtMsg = { readonly type: string };
type RtCell = (s: RtState, m: RtMsg) => readonly [RtState, readonly Cmd[]];
type RtCellFn = (
  s: RtState,
  m: RtMsg,
  at: string,
) => readonly [RtState, readonly Cmd[]];
/** Either form: one body for every site, or one body PER site keyed by `at`. */
type RtCellImpl = RtCellFn | Record<string, RtCellFn | undefined>;
type RtFn = (s: RtState, m: RtMsg) => object;
type RtAssign = RtFn | { readonly then: RtFn; readonly else: RtFn };

/** State name → its node and its phase, flattened out of the grouped shape. */
type Flat = { readonly node: RtNode; readonly group: string };

function flatten(c: RtChart): Map<string, Flat> {
  const out = new Map<string, Flat>();
  for (const group of Object.keys(c.states)) {
    const members = c.states[group] ?? {};
    for (const s of Object.keys(members)) {
      const node = members[s];
      if (node !== undefined) out.set(s, { node, group });
    }
  }
  return out;
}

function scopeList(scope: string | readonly string[]): readonly string[] {
  return typeof scope === "string" ? [scope] : scope;
}

/** The code parts, after the type layer has been erased. Shared by both forms. */
type RtParts = {
  readonly assign: Record<string, RtAssign | undefined>;
  readonly guards: Record<
    string,
    ((s: RtState, m: RtMsg, at: string) => boolean) | undefined
  >;
  readonly cmds: Record<
    string,
    ((s: RtState, m: RtMsg, at: string) => object) | undefined
  >;
  readonly cells: Record<string, RtCellImpl | undefined>;
};

function rtParts(parts: object): RtParts {
  const p = parts as Record<string, object | undefined>;
  return {
    assign: (p["assign"] ?? {}) as RtParts["assign"],
    guards: (p["guards"] ?? {}) as RtParts["guards"],
    cmds: (p["cmds"] ?? {}) as RtParts["cmds"],
    cells: (p["cells"] ?? {}) as RtParts["cells"],
  };
}

/**
 * ONE edge → one transition cell. This is the whole walk, and it is shared
 * verbatim by both chart forms: a `Transitions` cell and a `Reducer` cell
 * differ only in what `at` is (`"state.event"` vs `"event"`) and in whether a
 * parking set exists to inject `was` from — both parameters here, not branches.
 *
 * `bare` is the un-namespaced event name the author's parts are written
 * against; the compiled cell restores it before calling them.
 */
function buildCell(
  spec: RtEdge,
  bare: string,
  at: string,
  p: RtParts,
  parking: ReadonlySet<string>,
): RtCell {
  const edge = typeof spec === "string" ? { target: spec } : spec;
  const cell = p.assign[at];

  // ── THE ESCAPE HATCH ────────────────────────────────────────────────────
  // A `{ to, cell }` edge is the whole transition: the cell picks the target
  // from `to` and returns its own cmds, so there is no assign to call, no
  // guard to evaluate, no cmd list to rebuild and no `was` to inject (a cell
  // landing on a parking state supplies `was` itself — its return type demands
  // it). The other fields are compile errors beside `cell`, so this branch is
  // not silently skipping anything.
  if (edge.cell !== undefined) {
    const name = edge.cell;
    const impl = p.cells[name];
    if (impl === undefined) {
      throw new Error(
        `@demlik/tea: edge "${at}" names cell "${name}" with no implementation`,
      );
    }
    // the two forms: one body for every site, or one body per site. A
    // multi-site cell may be written either way (`Cells`/`RCells` offer both);
    // a single-site one is always the plain function.
    const hand = typeof impl === "function" ? impl : impl[at];
    if (hand === undefined) {
      throw new Error(
        `@demlik/tea: cell "${name}" is written in the per-site form but has no entry for edge "${at}"`,
      );
    }
    const to = edge.to ?? [];
    return (st, nsMsg) => {
      const out = hand(st, { ...nsMsg, type: bare }, at);
      // the runtime half of the `to` clamp — see `CellTargetError`.
      if (!to.includes(out[0].type)) {
        throw new CellTargetError(at, name, out[0].type, to);
      }
      return out;
    };
  }

  return (st, nsMsg) => {
    // strip the namespace so the author's parts see the bare event.
    const msg: RtMsg = { ...nsMsg, type: bare };

    let target: string;
    let payloadFn: RtFn;
    let fired = true;

    if (edge.resume !== undefined) {
      target = st.was ?? edge.resume.fallback;
      payloadFn = cell as RtFn;
    } else if (edge.when !== undefined) {
      const guard = p.guards[edge.when];
      fired = guard !== undefined && guard(st, msg, at) === true;
      const branch = cell as { then: RtFn; else: RtFn };
      target = fired ? (edge.target as string) : (edge.otherwise as string);
      payloadFn = fired ? branch.then : branch.else;
    } else {
      target = edge.target as string;
      payloadFn = cell as RtFn;
    }

    const data = payloadFn(st, msg);
    // `was` is INJECTED, never authored: entering a parking state records where
    // you came from. The type of `was` is `ResumeTargets<C, target>`, and
    // `st.type` is in that set by construction.
    const next: RtState = parking.has(target)
      ? { ...data, type: target, was: st.type }
      : { ...data, type: target };

    // 0..n Cmds, in declaration order. A guarded edge picks its arm's list —
    // `Cmd.when` lifted onto the edge, so which effects fire is visible in the
    // chart rather than buried in a cell body.
    const emitted = cmdNames(fired ? edge.cmd : edge.otherwiseCmd).map((n): Cmd => {
      const build = p.cmds[n];
      if (build === undefined) {
        throw new Error(
          `@demlik/tea: edge "${at}" names cmd "${n}" with no builder`,
        );
      }
      return { ...build(st, msg, at), type: n };
    });

    return [next, emitted];
  };
}

/** `undefined` → bare; a foreign event → bare; otherwise `${ns}.${event}`. */
function keyOf(
  c: { readonly events: Record<string, { readonly foreign?: true } | undefined> },
  e: string,
  ns: string | undefined,
): string {
  return ns === undefined || c.events[e]?.foreign === true ? e : `${ns}.${e}`;
}

const NO_PARKING: ReadonlySet<string> = new Set<string>();

/**
 * Compile a chart + the code parts into a genuine `Transitions<S, M, C>`.
 *
 * `ns` is OPTIONAL and PER-EVENT. Omitted, nothing is decorated and the table
 * is keyed by the bare event names — a single-instance machine carries no
 * namespace and passes no dummy string. Given, the author's own events are
 * keyed `${ns}.${event}` (so N instances share one dispatch surface with
 * genuinely disjoint literal unions), while every event the chart marks
 * `foreign: true` keeps its BARE name: a library-minted Msg like
 * `deadline_exceeded` is the same event for every instance, and its name was
 * never the author's to rename.
 *
 * The returned type is `Transitions<S, MsgIn<C, NS>, K>` — literal keys, never
 * `string`. The parts are authored against the BARE msg union; the compiled
 * cell restores the bare event name before calling them.
 *
 * `S`/`M`/`K` DEFAULT to the chart's own derivations, so the common call is
 * `compile(chart, parts)` with no type arguments at all.
 */
export function compile<
  const C extends Chart<C>,
  S extends { type: string } = StateOf<C>,
  M extends { type: string } = MsgOf<C>,
  K extends Cmd = CmdOf<C>,
  const NS extends string | undefined = undefined,
>(
  chart: C,
  parts: Parts<C, S, M>,
  ns?: NS,
): Transitions<S, MsgIn<C, NS>, K> {
  const c = chart as unknown as RtChart;
  const p = rtParts(parts);

  const flat = flatten(c);
  const events = Object.keys(c.events);
  const parking = new Set<string>();
  for (const [s, { node }] of flat) {
    for (const spec of Object.values(node.on ?? {})) {
      if (typeof spec === "object" && spec.resume !== undefined) parking.add(s);
    }
  }

  const table: Record<string, Record<string, RtCell>> = {};

  for (const [s, { node, group }] of flat) {
    const row: Record<string, RtCell> = {};
    const on = node.on ?? {};

    for (const e of events) {
      // the one runtime consequence of per-event namespacing.
      const key = keyOf(c, e, ns);
      const spec = on[e];

      if (spec === undefined) {
        // the mirror of `MissingAt<C, S>`: live-but-undecided is the only case
        // the type layer forbids, so it is the only case that throws.
        const scope = scopeList(c.events[e]?.scope ?? "edges");
        const live = scope.includes("all") || scope.includes(group);
        const refused =
          node.end === true || !live || (node.ignore ?? []).includes(e);
        row[key] = refused
          ? (st) => [st, []]
          : () => {
              throw new NoCellError(key, s);
            };
        continue;
      }

      // the site tag, passed to guards/cmds/cells as their last argument — it is
      // what lets a multi-site helper discriminate (see `SiteArgs` in graph.ts).
      row[key] = buildCell(spec, e, `${s}.${e}`, p, parking);
    }
    table[s] = row;
  }

  // ── THE ONE CAST ────────────────────────────────────────────────────────
  // Inside the library, at the construction boundary. `Transitions` is a
  // mapped type over `S["type"] × M["type"]`; the walk builds the same keys
  // from the flattened chart × the per-event keys, but tsc cannot see that a
  // string-keyed record built in a loop is total over those unions.
  return table as unknown as Transitions<S, MsgIn<C, NS>, K>;
}

// ═══════════════════════════════════════════════════════════════════════════
// REDUCER FORM — the same walk, one loop shallower.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The reducer form's parts bag. Structurally identical to `Parts`, over the
 * reducer chart's derivations — `assign` is total over the DECLARATIVE events
 * (a cell event owes none), and each of `guards`/`cmds`/`cells` is demanded
 * exactly when the chart names one.
 */
export type RParts<
  C,
  S extends { type: string },
  M extends { type: string },
> = {
  readonly assign: RAssigns<C, S, M>;
} & ([RGuardName<C>] extends [never]
  ? { readonly guards?: undefined }
  : { readonly guards: RGuards<C, S, M> }) &
  ([RUsedCmdName<C>] extends [never]
    ? { readonly cmds?: undefined }
    : { readonly cmds: RCmds<C, S, M> }) &
  ([RCellName<C>] extends [never]
    ? { readonly cells?: undefined }
    : { readonly cells: RCells<C, S, M> });

type RtReducerChart = {
  readonly events: Record<string, { readonly foreign?: true }>;
  readonly initial: string;
  readonly on: Record<string, RtEdge>;
};

/**
 * Compile a reducer-form chart into a genuine `Reducer<S, M, K>` — the flat,
 * msg-keyed `update` shape `defineMachine` already accepts (`src/pure/core.ts`).
 *
 * There is no `NoCellError` branch and no refusal branch here, and that is not
 * an omission: `on` is a TOTAL mapped type over the event alphabet, so an
 * undeclared event cannot exist to be missing. The safety the grid form buys
 * with `scope` + `ignore` + `Total<C>`, this form gets from the mapped type.
 *
 * `ns` behaves exactly as in `compile`: per-event, optional, and never applied
 * to an event the chart marks `foreign`.
 */
export function compileReducer<
  const C extends ReducerChart<C>,
  S extends { type: string } = RStateOf<C>,
  M extends { type: string } = MsgOf<C>,
  K extends Cmd = CmdOf<C>,
  const NS extends string | undefined = undefined,
>(chart: C, parts: RParts<C, S, M>, ns?: NS): Reducer<S, MsgIn<C, NS>, K> {
  const c = chart as unknown as RtReducerChart;
  const p = rtParts(parts);
  const out: Record<string, RtCell> = {};

  for (const e of Object.keys(c.events)) {
    const spec = c.on[e];
    if (spec === undefined) {
      // unreachable through the typed door — `on` is total over `events`. The
      // safety net under the compile-time obligation, as `NoCellError` is
      // under `Total<C>`.
      throw new Error(`@demlik/tea: reducer chart declares no edge for "${e}"`);
    }
    // the site tag IS the event: one dimension, so `SiteArgs`'s `at` is the
    // bare name and a multi-site cell discriminates on it exactly as before.
    out[keyOf(c, e, ns)] = buildCell(spec, e, e, p, NO_PARKING);
  }

  // The same one cast, for the same reason: a string-keyed record built in a
  // loop is total over `M["type"]`, and tsc cannot see it.
  return out as unknown as Reducer<S, MsgIn<C, NS>, K>;
}

/**
 * `init` for a reducer chart. The entry state is the chart's `initial` field —
 * one word, still never repeated by the author — and `boot()` supplies `ctx`,
 * which for this form IS the whole state minus its tag.
 */
export function reducerInitFrom<
  const C extends ReducerChart<C>,
  S extends { type: string } = RStateOf<C>,
  K extends Cmd = CmdOf<C>,
>(chart: C, boot: () => Omit<RStateOf<C>, "type">): (loaded: S | null) => readonly [S, readonly K[]] {
  const type: string = (chart as unknown as RtReducerChart).initial;
  return (loaded) => [loaded ?? ({ ...boot(), type } as unknown as S), Cmd.none];
}

/**
 * The reducer chart, drawn. There is no per-state routing to show, so the
 * honest picture is one `any` node — every edge is reachable from every state,
 * which is what having no phase dimension MEANS — plus each event's full
 * fan-out, cell edges included.
 */
export function reducerMermaid<const C extends ReducerChart<C>>(chart: C): string {
  const c = chart as unknown as RtReducerChart;
  const lines = ["stateDiagram-v2", "  direction TB", `  [*] --> ${c.initial}`];
  for (const [e, spec] of Object.entries(c.on)) {
    const edge = typeof spec === "string" ? { target: spec } : spec;
    if (edge.cell !== undefined) {
      for (const t of edge.to ?? []) {
        lines.push(`  any --> ${t} : ${e} / ${edge.cell}()`);
      }
    } else {
      if (edge.target !== undefined) lines.push(`  any --> ${edge.target} : ${e}`);
      if (edge.otherwise !== undefined) {
        lines.push(`  any --> ${edge.otherwise} : ${e} [!${edge.when ?? ""}]`);
      }
    }
  }
  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// `init`, DERIVED FROM THE CHART
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The name of the state marked `initial: true`. Throws unless EXACTLY one is
 * marked — the runtime half of what `InitialData`'s marker types say at the
 * type level.
 */
export function initialStateOf<const C extends Chart<C>>(chart: C): InitialState<C> {
  const flat = flatten(chart as unknown as RtChart);
  const marked = [...flat].filter(([, f]) => f.node.initial === true);
  const only = marked[0];
  if (marked.length !== 1 || only === undefined) {
    throw new Error(
      `@demlik/tea: chart must mark exactly one state \`initial: true\` (found ${marked.length})`,
    );
  }
  // `Object.keys` yields `string`; the type-level answer is the same key.
  return only[0] as InitialState<C>;
}

/**
 * Build a `Machine["init"]` from the chart's declared entry state plus a
 * `boot()` that supplies ONLY that state's data. The state NAME is never
 * repeated by the author — it comes from the same `initial: true` that
 * `machine-viz` reads to draw the `[*] -->` edge.
 *
 * Rehydrate is honoured verbatim: a non-null `loaded` is returned untouched
 * with NO cmds, which is exactly Invariant 2's contract.
 */
export function initFrom<
  const C extends Chart<C>,
  S extends { type: string },
  K extends Cmd,
>(chart: C, boot: () => InitialData<C, S>): (loaded: S | null) => readonly [S, readonly K[]] {
  const type: string = initialStateOf(chart);
  return (loaded) => [
    // The one cast this helper needs: `{ ...InitialData, type: <the initial
    // name> }` IS `Extract<S, { type: InitialState<C> }>`, but tsc cannot
    // rebuild a union member from a spread plus a `string`-typed discriminant.
    loaded ?? ({ ...boot(), type } as unknown as S),
    Cmd.none,
  ];
}

// ═══════════════════════════════════════════════════════════════════════════
// DRAWING THE CHART — every declared edge, including a cell edge's fan-out.
//
// `machine-viz`'s `toMermaid` works on a COMPILED machine and resolves a cell
// by executing it against a sample, so it draws the ONE edge that sample takes
// — true of a guarded edge before the escape hatch existed, and equally true
// of a `{ to, cell }` edge now. The chart, though, still knows every possible
// target, which is the whole point of declaring `to`. This reads the chart
// directly and draws the full fan-out, no samples and no execution needed.
// ═══════════════════════════════════════════════════════════════════════════
export function chartMermaid<const C extends Chart<C>>(chart: C): string {
  const c = chart as unknown as RtChart;
  const lines = ["stateDiagram-v2", "  direction TB"];
  for (const [s, { node }] of flatten(c)) {
    if (node.initial === true) lines.push(`  [*] --> ${s}`);
    for (const [e, spec] of Object.entries(node.on ?? {})) {
      const edge = typeof spec === "string" ? { target: spec } : spec;
      if (edge.cell !== undefined) {
        // one real edge per DECLARED target — the fan-out, labelled with the
        // cell that picks among them.
        for (const t of edge.to ?? []) {
          lines.push(`  ${s} --> ${t} : ${e} / ${edge.cell}()`);
        }
      } else if (edge.resume !== undefined) {
        lines.push(`  ${s} --> ${edge.resume.fallback} : ${e} (resume)`);
      } else {
        if (edge.target !== undefined) lines.push(`  ${s} --> ${edge.target} : ${e}`);
        if (edge.otherwise !== undefined) {
          lines.push(`  ${s} --> ${edge.otherwise} : ${e} [!${edge.when ?? ""}]`);
        }
      }
    }
    if (node.end === true) lines.push(`  ${s} --> [*]`);
  }
  return lines.join("\n");
}
