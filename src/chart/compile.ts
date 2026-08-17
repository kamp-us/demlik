// ═══════════════════════════════════════════════════════════════════════════
// RUNTIME — the graph walk that emits a real `Transitions<S, M, C>`.
// ═══════════════════════════════════════════════════════════════════════════
import { Cmd, NoCellError, type Transitions } from "../pure/core";
import type {
  Assigns,
  CmdName,
  Cmds,
  Graph,
  GuardName,
  Guards,
  InitialData,
  InitialState,
  Namespaced,
} from "./graph";

/** `undefined` → none; `"x"` → one; `["x","y"]` → both, in order. */
function cmdNames(ref: string | readonly string[] | undefined): readonly string[] {
  if (ref === undefined) return [];
  return typeof ref === "string" ? [ref] : ref;
}

// There is no `unhandled` policy any more. A pair is DECLARED (an edge), or
// REFUSED in the graph (`ignore` / `end: true`) — `Total<G>` refuses to compile
// on any third case. The refusal is a self-loop with no cmds; the throw below
// is the safety net under the compile-time refusal (`.decisions/0011`), reached
// only when the mapped types were bypassed with a cast.
export type Parts<
  G,
  S extends { type: string },
  M extends { type: string },
  C extends Cmd,
> = {
  readonly assign: Assigns<G, S, M>;
} & ([GuardName<G>] extends [never]
  ? { readonly guards?: undefined }
  : { readonly guards: Guards<G, S, M> }) &
  ([CmdName<G>] extends [never]
    ? { readonly cmds?: undefined }
    : { readonly cmds: Cmds<G, S, M, C> });

// ── runtime views of the config (the shapes the walk actually reads) ───────
type RtEdge =
  | string
  | {
      readonly target?: string;
      readonly when?: string;
      readonly otherwise?: string;
      readonly cmd?: string | readonly string[];
      readonly otherwiseCmd?: string | readonly string[];
      readonly resume?: { readonly fallback: string };
    };
type RtGraph = Readonly<
  Record<
    string,
    {
      readonly initial?: true;
      readonly on?: Record<string, RtEdge>;
      readonly ignore?: readonly string[];
      readonly end?: true;
    }
  >
>;
type RtState = { readonly type: string; readonly was?: string };
type RtMsg = { readonly type: string };
type RtCell = (s: RtState, m: RtMsg) => readonly [RtState, readonly Cmd[]];
type RtFn = (s: RtState, m: RtMsg) => object;
type RtAssign = RtFn | { readonly then: RtFn; readonly else: RtFn };

/**
 * Compile a graph + the code parts into a genuine `Transitions<S, M, C>`.
 *
 * `NS` namespaces the emitted table keys AND the Msg union at the type level:
 * the table is keyed `${ns}.${event}`, and the returned type is
 * `Transitions<S, Namespaced<M, NS>, C>` — a literal union, never `string`.
 * The parts are authored against the BARE msg union; the compiled cell strips
 * the namespace before calling them (Umut's `bareEvent`).
 */
export function compile<
  const G extends Graph<G>,
  S extends { type: string },
  M extends { type: string },
  C extends Cmd,
  const NS extends string,
>(
  graph: G,
  ns: NS,
  parts: Parts<G, S, M, C>,
): Transitions<S, Namespaced<M, NS>, C> {
  const g = graph as unknown as RtGraph;
  const assign = parts.assign as unknown as Record<string, RtAssign>;
  const guards = (parts.guards ?? {}) as unknown as Record<
    string,
    (s: RtState, m: RtMsg, at: string) => boolean
  >;
  const cmds = (parts.cmds ?? {}) as unknown as Record<
    string,
    (s: RtState, m: RtMsg, at: string) => object
  >;

  const stateKeys = Object.keys(g);
  const events = new Set<string>();
  const parking = new Set<string>();
  for (const s of stateKeys) {
    const on = g[s]?.on ?? {};
    for (const e of Object.keys(on)) {
      events.add(e);
      const spec = on[e];
      if (typeof spec === "object" && spec.resume !== undefined) parking.add(s);
    }
  }

  const table: Record<string, Record<string, RtCell>> = {};

  for (const s of stateKeys) {
    const row: Record<string, RtCell> = {};
    const on = g[s]?.on ?? {};

    for (const e of events) {
      const key = `${ns}.${e}`;
      const spec = on[e];

      if (spec === undefined) {
        const node = g[s];
        const refused =
          node?.end === true || (node?.ignore ?? []).includes(e) === true;
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
        // where you came from. The type of `was` is `ResumeTargets<G, target>`,
        // and `st.type` is in that set by construction.
        const next: RtState = parking.has(target)
          ? { ...data, type: target, was: st.type }
          : { ...data, type: target };

        // 0..n Cmds, in declaration order. A guarded edge picks its arm's
        // list — `Cmd.when` lifted onto the edge, so which effects fire is
        // visible in the graph rather than buried in a cell body.
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
  // from `Object.keys(graph)` × `${ns}.${event}`, but tsc cannot see that a
  // string-keyed record built in a loop is total over those unions.
  return table as unknown as Transitions<S, Namespaced<M, NS>, C>;
}

// ═══════════════════════════════════════════════════════════════════════════
// `init`, DERIVED FROM THE GRAPH
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The name of the state marked `initial: true`. Throws unless EXACTLY one is
 * marked — the runtime half of what `InitialData`'s marker types say at the
 * type level.
 */
export function initialStateOf<const G extends Graph<G>>(graph: G): InitialState<G> {
  const g = graph as unknown as RtGraph;
  const marked = Object.keys(g).filter((s) => g[s]?.initial === true);
  const only = marked[0];
  if (marked.length !== 1 || only === undefined) {
    throw new Error(
      `@demlik/tea: graph must mark exactly one state \`initial: true\` (found ${marked.length})`,
    );
  }
  // `Object.keys` yields `string`; the type-level answer is the same key.
  return only as InitialState<G>;
}

/**
 * Build a `Machine["init"]` from the graph's declared entry state plus a
 * `boot()` that supplies ONLY that state's data. The state NAME is never
 * repeated by the author — it comes from the same `initial: true` that
 * `machine-viz` reads to draw the `[*] -->` edge.
 *
 * Rehydrate is honoured verbatim: a non-null `loaded` is returned untouched
 * with NO cmds, which is exactly Invariant 2's contract (init's rehydrate
 * branch is the migration boundary, not the boot-effect hook). Boot cmds are
 * therefore NOT expressible here, deliberately — the substrate's own answer is
 * a `boot` Msg dispatched once after `run(...)`.
 */
export function initFrom<
  const G extends Graph<G>,
  S extends { type: string },
  C extends Cmd,
>(graph: G, boot: () => InitialData<G, S>): (loaded: S | null) => readonly [S, readonly C[]] {
  const type: string = initialStateOf(graph);
  return (loaded) => [
    // The one cast this helper needs: `{ ...InitialData, type: <the initial
    // name> }` IS `Extract<S, { type: InitialState<G> }>`, but tsc cannot
    // rebuild a union member from a spread plus a `string`-typed discriminant.
    loaded ?? ({ ...boot(), type } as unknown as S),
    Cmd.none,
  ];
}
