// ═══════════════════════════════════════════════════════════════════════════
// RUNTIME — the graph walk that emits a real `Transitions<S, M, C>`.
// ═══════════════════════════════════════════════════════════════════════════
import type { Cmd, Transitions } from "../pure/core";
import type {
  Assigns,
  CmdName,
  Cmds,
  Graph,
  GuardName,
  Guards,
  Namespaced,
} from "./graph";

/** Policy for a (state × msg) pair the graph does not declare. */
export type Unhandled = "ignore" | "error";

export type Parts<
  G,
  S extends { type: string },
  M extends { type: string },
  C extends Cmd,
> = {
  readonly assign: Assigns<G, S, M>;
  /** `"ignore"` (default) = self-loop, no cmds. `"error"` = throw at dispatch. */
  readonly unhandled?: Unhandled;
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
      readonly cmd?: string;
      readonly resume?: { readonly fallback: string };
    };
type RtGraph = Readonly<Record<string, { readonly on?: Record<string, RtEdge> }>>;
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
        row[key] =
          parts.unhandled === "error"
            ? () => {
                throw new Error(
                  `@demlik/tea: state "${s}" declares no edge for event "${e}"`,
                );
              }
            : (st) => [st, []];
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

        const emitted: Cmd[] =
          fired && edge.cmd !== undefined && cmds[edge.cmd] !== undefined
            ? [{ ...cmds[edge.cmd]?.(st, msg, at), type: edge.cmd }]
            : [];

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
