// ═══════════════════════════════════════════════════════════════════════════
// RUNTIME — the chart walk that emits a real `Transitions<S, M, C>`.
// ═══════════════════════════════════════════════════════════════════════════
import { safeId, safeLabel } from "../machine-viz/mermaid-id";
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
  ReducerChart,
  RGuardName,
  RGuards,
  RStateOf,
  RUsedCmdName,
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
function cmdNames(
  ref: string | readonly string[] | undefined,
): readonly string[] {
  if (ref === undefined) return [];
  return typeof ref === "string" ? [ref] : ref;
}

// There is no `unhandled` policy any more. A pair is DECLARED (an edge), or
// REFUSED — by the event's `scope`, or by this state's `ignore`, or by
// `end: true` — and `Total<C>` refuses to compile on any third case. The
// refusal is a self-loop with no cmds; the throw below is the safety net under
// the compile-time refusal (`.decisions/0011`), reached only when the mapped
// types were bypassed with a cast.
export type Parts<C, S extends { type: string }, M extends { type: string }> = {
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
  // BOTH polarities, because both are final and only one of them is a success.
  // The walk reads `!== undefined` (either is terminal); the drawing reads the
  // value, which is the whole reason it is not narrowed to `true` here.
  readonly end?: true | "error";
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
    assign: (p.assign ?? {}) as RtParts["assign"],
    guards: (p.guards ?? {}) as RtParts["guards"],
    cmds: (p.cmds ?? {}) as RtParts["cmds"],
    cells: (p.cells ?? {}) as RtParts["cells"],
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
    const emitted = cmdNames(fired ? edge.cmd : edge.otherwiseCmd).map(
      (n): Cmd => {
        const build = p.cmds[n];
        if (build === undefined) {
          throw new Error(
            `@demlik/tea: edge "${at}" names cmd "${n}" with no builder`,
          );
        }
        return { ...build(st, msg, at), type: n };
      },
    );

    return [next, emitted];
  };
}

/** `undefined` → bare; a foreign event → bare; otherwise `${ns}.${event}`. */
function keyOf(
  c: {
    readonly events: Record<string, { readonly foreign?: true } | undefined>;
  },
  e: string,
  ns: string | undefined,
): string {
  return ns === undefined || c.events[e]?.foreign === true ? e : `${ns}.${e}`;
}

const NO_PARKING: ReadonlySet<string> = new Set<string>();

/**
 * One compiled table, BEFORE the typed boundary — `state.type` → the event key
 * → the cell.
 *
 * The shape `compile` builds and then declares as a `Transitions<S, M, C>`. It
 * is named because a second caller needs the walk without the declaration:
 * `chart/lane/run` compiles ONE region per task and the tables it holds are
 * keyed by task id, so the per-region `Transitions` type is never the type of
 * anything it stores.
 */
export type CompiledTable = Readonly<
  Record<string, Readonly<Record<string, RtCell | undefined>> | undefined>
>;

/**
 * THE WALK, with no type layer over it — `compile`'s body, callable by a second
 * compiler that has already done its own type checking.
 *
 * `chart`/`parts` are `object` rather than the F-bounded `Chart<C>`/`Parts<…>`
 * because this entry is not where the checking happens; it is where the
 * checking has ALREADY happened. The erasing cast lives here, exactly once, at
 * the top of the walk — which is where it lived before this function had a
 * name, so nothing gained a cast by being reachable from two places.
 */
export function compileTable(
  chart: object,
  parts: object,
  ns: string | undefined,
): CompiledTable {
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
        // `end` is `true` (success) or `"error"`; BOTH are final, and the type
        // layer's `IsEndOf` reads both. Testing `=== true` here would put an
        // error final back under the totality obligation at runtime only.
        const refused =
          node.end !== undefined || !live || (node.ignore ?? []).includes(e);
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

  return table;
}

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
>(chart: C, parts: Parts<C, S, M>, ns?: NS): Transitions<S, MsgIn<C, NS>, K> {
  // ── THE ONE CAST ────────────────────────────────────────────────────────
  // Inside the library, at the construction boundary. `Transitions` is a
  // mapped type over `S["type"] × M["type"]`; the walk builds the same keys
  // from the flattened chart × the per-event keys, but tsc cannot see that a
  // string-keyed record built in a loop is total over those unions.
  return compileTable(chart, parts, ns) as unknown as Transitions<
    S,
    MsgIn<C, NS>,
    K
  >;
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
>(
  chart: C,
  boot: () => Omit<RStateOf<C>, "type">,
): (loaded: S | null) => readonly [S, readonly K[]] {
  const type: string = (chart as unknown as RtReducerChart).initial;
  return (loaded) => [
    loaded ?? ({ ...boot(), type } as unknown as S),
    Cmd.none,
  ];
}

/**
 * The reducer chart, drawn. There is no per-state routing to show, so the
 * honest picture is one `any` node — every edge is reachable from every state,
 * which is what having no phase dimension MEANS — plus each event's full
 * fan-out, cell edges included.
 */
export function reducerMermaid<const C extends ReducerChart<C>>(
  chart: C,
): string {
  const c = chart as unknown as RtReducerChart;
  const lines = [
    "stateDiagram-v2",
    "  direction TB",
    `  [*] --> ${safeId(c.initial)}`,
  ];
  // The SAME edge grammar `chartMermaid` draws — see {@link edgeLines}. The one
  // difference this form has is `from`, which is `any` at every edge, because
  // having no phase dimension MEANS every edge is reachable from every state.
  for (const [e, spec] of Object.entries(c.on)) {
    lines.push(...edgeLines("any", "any", e, spec, NO_MARKS));
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
export function initialStateOf<const C extends Chart<C>>(
  chart: C,
): InitialState<C> {
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
>(
  chart: C,
  boot: () => InitialData<C, S>,
): (loaded: S | null) => readonly [S, readonly K[]] {
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
//
// THIS IS THE ONLY CHART RENDERER. `chart/report/draw.ts` used to carry a
// second one, written in parallel against the same mermaid grammar while this
// one was growing its options bag; the two diverged before the swap its banner
// promised ever happened (a guarded then-arm drawn bare here and labelled
// there, two spellings of the highlight class, sanitizing on one side only).
// How a chart is drawn is ONE fact, so there is one body and the report enters
// it through `drawTask`, which is now nothing but a translation of its option
// names into these.
//
// WHAT MERMAID CAN AND CANNOT DO, stated so `walked` is judged fairly:
// `stateDiagram-v2` supports `classDef`/`class`, so LIGHTING A NODE is real
// styling. It supports no per-edge styling at all — there is no `linkStyle` for
// a state diagram — so a walked edge is marked ON ITS LABEL (`»`, plus the
// visit count) rather than thickened. Still true as of mermaid 11.
// ═══════════════════════════════════════════════════════════════════════════

/** How many times each {@link edgeKey} was walked. */
export type WalkCounts = ReadonlyMap<string, number>;

/**
 * The key a {@link ChartMermaidOptions.walked} map is read by.
 *
 * One spelling, shared by whoever counts the walk and the drawing that marks
 * it — the names are the chart's OWN, unsanitized, because the counter reads
 * them off a log and has no business knowing what mermaid can spell.
 *
 * NOT `EdgeKey<C>` (`graph.ts`), despite the casing. That one is the SITE tag
 * — `"state.event"` — which is what a guard or a cmd builder is keyed by,
 * because a site is where code hangs. This one names a drawn ARROW, and a
 * guarded site draws two of them, so it needs the target as well.
 */
export const edgeKey = (from: string, event: string, to: string): string =>
  `${from}|${event}|${to}`;

/**
 * Options for {@link chartMermaid}. Every field is optional and every default
 * reproduces the drawing this function emitted before options existed — a flat
 * node set, `direction TB`, no title, no highlight, no polarity and no walk —
 * so an existing caller is untouched.
 *
 * Shaped after `MachineVizOptions` (`../machine-viz`) where the two overlap
 * (`direction`, `title`), because the two drawings are read side by side and a
 * second spelling of the same knob is a fact said twice. What is NOT shared is
 * `samples`: `toMermaid` needs them because it must EXECUTE a compiled cell to
 * learn a target; the chart declares its targets, so there is nothing to
 * resolve and nothing to sample.
 */
export interface ChartMermaidOptions {
  /**
   * Draw this state as the ACTIVE node — a `classDef`/`class` pair Mermaid
   * renders with the highlight fill. Pass the live `state.type`. A name that is
   * not in the chart is ignored rather than drawn as a phantom node.
   */
  readonly highlight?: string;
  /**
   * Draw each phase as a Mermaid COMPOSITE state (`state working { … }`).
   *
   * The chart groups its states into named phases and the flat drawing throws
   * that away — which is the one structural fact `chartMermaid` knew and did
   * not show. Off by default: turning it on changes the emitted text, and the
   * drawing is something a reviewer approves rather than something that moves
   * under them.
   */
  readonly phases?: boolean;
  /**
   * Draw the two ENDINGS differently — a dashed outline on every `end:
   * "error"` final, a heavier one on every `end: true`.
   *
   * A success final and an error final both terminate, so both draw the `[*]`
   * edge, and a picture that stopped there paints `shipped` and `frozen` alike
   * in the one place a reader looks first. Off by default for the same reason
   * `phases` is: it changes the emitted text.
   */
  readonly polarity?: boolean;
  /**
   * Edges the caller actually WALKED, keyed by {@link edgeKey} — each drawn
   * edge that has a count picks up a `»` (or `»×N`) on its label.
   *
   * A missing or zero count marks nothing, so a chart nobody has run through
   * draws exactly as it does without this option.
   */
  readonly walked?: WalkCounts;
  /** Mermaid layout direction. Default `"TB"`. */
  readonly direction?: "TB" | "LR";
  /** Optional title, emitted as a Mermaid front-matter `title:` block. */
  readonly title?: string;
}

/** The CSS class Mermaid applies to the highlighted node. */
const ACTIVE_CLASS = "teaActive";
/** …and to the two endings, when `polarity` asks for them. */
const TRIPPED_CLASS = "teaTripped";
const SHIPPED_CLASS = "teaShipped";

/**
 * A node's declaration line, or `undefined` when the sanitized id already IS
 * the name and the bare id carries the whole fact. Emitting the label only for
 * a renamed node is what keeps the default drawing byte-identical for charts
 * whose names were already Mermaid-safe.
 */
function nodeDecl(raw: string, indent: string): string | undefined {
  const id = safeId(raw);
  return id === raw ? undefined : `${indent}${id} : ${safeLabel(raw)}`;
}

/**
 * ONE edge, as the arrows that draw it — the whole edge grammar, in one place.
 *
 * Both drawings in this file come through here: the grid form draws it from
 * each state, the reducer form from the single `any` node, and the two forms
 * differ in what `from` is and in nothing else. That is not tidiness — the
 * guarded arm's labelling was wrong in both of them, in the same way, and one
 * of them was fixed once already without the other moving.
 *
 * `at` is the UNSANITIZED source-state name the walk counter keyed by; `from`
 * is what mermaid will read.
 */
function edgeLines(
  from: string,
  at: string,
  e: string,
  spec: RtEdge,
  mark: (from: string, event: string, to: string) => string,
): readonly string[] {
  const edge = typeof spec === "string" ? { target: spec } : spec;
  const out: string[] = [];
  // ONE arrow-writer for every edge form, so the walk mark cannot be
  // remembered on three of the four and forgotten on the fourth.
  const arrow = (to: string, label: string): void => {
    out.push(
      `  ${from} --> ${safeId(to)} : ${safeLabel(`${label}${mark(at, e, to)}`)}`,
    );
  };
  if (edge.cell !== undefined) {
    // one real edge per DECLARED target — the fan-out, labelled with the cell
    // that picks among them.
    for (const t of edge.to ?? []) arrow(t, `${e} / ${edge.cell}()`);
    return out;
  }
  if (edge.resume !== undefined) {
    arrow(edge.resume.fallback, `${e} (resume)`);
    return out;
  }
  // A GUARDED edge labels BOTH arms. Drawing the then-arm bare — `review -->
  // build : FAIL` beside `review --> frozen : FAIL [!retriesRemaining]` —
  // reads as an unconditional edge racing a conditional one, which is not what
  // the chart says: the then-arm is exactly as conditional as the else-arm,
  // and the reader is left to infer its guard from a sibling arrow.
  const guard = edge.when === undefined ? "" : ` [${edge.when}]`;
  if (edge.target !== undefined) arrow(edge.target, `${e}${guard}`);
  if (edge.otherwise !== undefined)
    arrow(edge.otherwise, `${e} [!${edge.when ?? ""}]`);
  return out;
}

/** No walk to mark — the drawings that take no `walked` map. */
const NO_MARKS = (): string => "";

export function chartMermaid<const C extends Chart<C>>(
  chart: C,
  opts: ChartMermaidOptions = {},
): string {
  const c = chart as unknown as RtChart;
  const flat = flatten(c);
  const lines: string[] = [];
  if (opts.title !== undefined)
    lines.push("---", `title: ${opts.title}`, "---");
  lines.push("stateDiagram-v2", `  direction ${opts.direction ?? "TB"}`);

  // The walk mark, keyed by the chart's OWN names — `walked` is counted off a
  // log, so it never saw a sanitized id.
  const walked = opts.walked;
  const mark = (from: string, event: string, to: string): string => {
    const n = walked?.get(edgeKey(from, event, to)) ?? 0;
    return n === 0 ? "" : n === 1 ? " »" : ` »×${n}`;
  };

  // Phases, as composite states. Declared BEFORE the edges so every node is
  // already inside its phase by the time an arrow references it — Mermaid
  // otherwise hoists the first mention to the top level.
  if (opts.phases === true) {
    for (const [group, members] of Object.entries(c.states)) {
      lines.push(`  state ${safeId(group)} {`);
      for (const s of Object.keys(members)) {
        lines.push(nodeDecl(s, "    ") ?? `    ${safeId(s)}`);
      }
      lines.push("  }");
    }
  }

  for (const [s, { node }] of flat) {
    const from = safeId(s);
    // A renamed node needs its human name shown once. In `phases` mode the
    // declaration already went inside the composite block.
    if (opts.phases !== true) {
      const decl = nodeDecl(s, "  ");
      if (decl !== undefined) lines.push(decl);
    }
    if (node.initial === true) lines.push(`  [*] --> ${from}`);
    for (const [e, spec] of Object.entries(node.on ?? {})) {
      lines.push(...edgeLines(from, s, e, spec, mark));
    }
    // Both polarities terminate, so both draw the `[*]` edge — an error final
    // that stopped drawing one would read as a state the machine can leave.
    if (node.end !== undefined) lines.push(`  ${from} --> [*]`);
  }

  // The classes, last: a `classDef` must exist before the `class` line that
  // uses it, and both must sit outside any composite block. Each pair is
  // emitted only when something wears it, so an unused `classDef` never lands.
  if (opts.polarity === true) {
    const tripped: string[] = [];
    const shipped: string[] = [];
    for (const [s, { node }] of flat) {
      if (node.end === "error") tripped.push(safeId(s));
      if (node.end === true) shipped.push(safeId(s));
    }
    if (tripped.length > 0) {
      lines.push(
        `  classDef ${TRIPPED_CLASS} stroke-dasharray:4 4`,
        `  class ${tripped.join(",")} ${TRIPPED_CLASS}`,
      );
    }
    if (shipped.length > 0) {
      lines.push(
        `  classDef ${SHIPPED_CLASS} stroke-width:2px`,
        `  class ${shipped.join(",")} ${SHIPPED_CLASS}`,
      );
    }
  }
  if (opts.highlight !== undefined && flat.has(opts.highlight)) {
    lines.push(
      `  classDef ${ACTIVE_CLASS} fill:#2f81f7,stroke:#2f81f7,color:#fff,font-weight:bold`,
      `  class ${safeId(opts.highlight)} ${ACTIVE_CLASS}`,
    );
  }
  return lines.join("\n");
}
