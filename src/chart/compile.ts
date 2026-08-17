// ═══════════════════════════════════════════════════════════════════════════
// RUNTIME — the chart walk that emits a real `Transitions<S, M, C>`.
// ═══════════════════════════════════════════════════════════════════════════
import { Cmd, NoCellError, type Transitions } from "../pure/core";
import type {
  Assigns,
  CellName,
  Cells,
  Chart,
  Cmds,
  GuardName,
  Guards,
  InitialData,
  InitialState,
  Namespaced,
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
    { readonly scope: string | readonly string[] }
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

/**
 * Compile a chart + the code parts into a genuine `Transitions<S, M, C>`.
 *
 * `NS` namespaces the emitted table keys AND the Msg union at the type level:
 * the table is keyed `${ns}.${event}`, and the returned type is
 * `Transitions<S, Namespaced<M, NS>, C>` — a literal union, never `string`.
 * The parts are authored against the BARE msg union; the compiled cell strips
 * the namespace before calling them (Umut's `bareEvent`).
 */
export function compile<
  const C extends Chart<C>,
  S extends { type: string },
  M extends { type: string },
  K extends Cmd,
  const NS extends string,
>(
  chart: C,
  ns: NS,
  parts: Parts<C, S, M>,
): Transitions<S, Namespaced<M, NS>, K> {
  const c = chart as unknown as RtChart;
  const assign = parts.assign as unknown as Record<string, RtAssign>;
  const guards = (parts.guards ?? {}) as unknown as Record<
    string,
    (s: RtState, m: RtMsg, at: string) => boolean
  >;
  const cmds = (parts.cmds ?? {}) as unknown as Record<
    string,
    (s: RtState, m: RtMsg, at: string) => object
  >;
  const cells = (parts.cells ?? {}) as unknown as Record<
    string,
    RtCellImpl | undefined
  >;

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
      const key = `${ns}.${e}`;
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

      const edge = typeof spec === "string" ? { target: spec } : spec;
      // the site tag, passed to guards/cmds as their last argument — it is what
      // lets a multi-site guard discriminate (see `SiteArgs` in graph.ts).
      const at = `${s}.${e}`;
      const cell = assign[at];

      // ── THE ESCAPE HATCH ────────────────────────────────────────────────
      // A `{ to, cell }` edge is the whole transition: the cell picks the
      // target from `to` and returns its own cmds, so there is no assign to
      // call, no guard to evaluate, no cmd list to rebuild and no `was` to
      // inject (a cell landing on a parking state supplies `was` itself — its
      // return type demands it). The other three fields are compile errors
      // beside `cell`, so this branch is not silently skipping anything.
      if (edge.cell !== undefined) {
        const name = edge.cell;
        const impl = cells[name];
        if (impl === undefined) {
          throw new Error(
            `@demlik/tea: edge "${s}.${e}" names cell "${name}" with no implementation`,
          );
        }
        // the two forms: one body for every site, or one body per site. A
        // multi-site cell may be written either way (`Cells` offers both); a
        // single-site one is always the plain function.
        const hand = typeof impl === "function" ? impl : impl[at];
        if (hand === undefined) {
          throw new Error(
            `@demlik/tea: cell "${name}" is written in the per-site form but has no entry for edge "${at}"`,
          );
        }
        const to = edge.to ?? [];
        row[key] = (st, nsMsg) => {
          const out = hand(st, { ...nsMsg, type: e }, at);
          // the runtime half of the `to` clamp — see `CellTargetError`.
          if (!to.includes(out[0].type)) {
            throw new CellTargetError(at, name, out[0].type, to);
          }
          return out;
        };
        continue;
      }


      row[key] = (st, nsMsg) => {
        // strip the namespace so the author's parts see the bare event.
        const msg: RtMsg = { ...nsMsg, type: e };

        let target: string;
        let payloadFn: RtFn;
        let fired = true;

        if (edge.resume !== undefined) {
          target = st.was ?? edge.resume.fallback;
          payloadFn = cell as RtFn;
        } else if (edge.when !== undefined) {
          const guard = guards[edge.when];
          fired = guard !== undefined && guard(st, msg, at) === true;
          const branch = cell as { then: RtFn; else: RtFn };
          target = fired ? (edge.target as string) : (edge.otherwise as string);
          payloadFn = fired ? branch.then : branch.else;
        } else {
          target = edge.target as string;
          payloadFn = cell as RtFn;
        }

        const data = payloadFn(st, msg);
        // `was` is INJECTED, never authored: entering a parking state records
        // where you came from. The type of `was` is `ResumeTargets<C, target>`,
        // and `st.type` is in that set by construction.
        const next: RtState = parking.has(target)
          ? { ...data, type: target, was: st.type }
          : { ...data, type: target };

        // 0..n Cmds, in declaration order. A guarded edge picks its arm's
        // list — `Cmd.when` lifted onto the edge, so which effects fire is
        // visible in the chart rather than buried in a cell body.
        const emitted = cmdNames(fired ? edge.cmd : edge.otherwiseCmd).map(
          (n): Cmd => {
            const build = cmds[n];
            if (build === undefined) {
              throw new Error(
                `@demlik/tea: edge "${s}.${e}" names cmd "${n}" with no builder`,
              );
            }
            return { ...build(st, msg, at), type: n };
          },
        );

        return [next, emitted];
      };
    }
    table[s] = row;
  }

  // ── THE ONE CAST ────────────────────────────────────────────────────────
  // Inside the library, at the construction boundary. `Transitions` is a
  // mapped type over `S["type"] × M["type"]`; the walk builds the same keys
  // from the flattened chart × `${ns}.${event}`, but tsc cannot see that a
  // string-keyed record built in a loop is total over those unions.
  return table as unknown as Transitions<S, Namespaced<M, NS>, K>;
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
