// ═══════════════════════════════════════════════════════════════════════════
// TYPE MACHINERY — everything in this file is erased at runtime.
// ═══════════════════════════════════════════════════════════════════════════
import type { Cmd } from "../pure/core";

// ── 1. the graph shape ─────────────────────────────────────────────────────
// An edge is either a bare target name, a target with optional cmd, a GUARDED
// target (`when` + `otherwise`), or a RESUME edge (go back to `was ?? fallback`).
export type EdgeSpec<SN extends string> =
  | SN
  | { readonly target: SN; readonly cmd?: string }
  | {
      readonly target: SN;
      readonly when: string;
      readonly otherwise: SN;
      readonly cmd?: string;
    }
  | { readonly resume: { readonly fallback: SN }; readonly cmd?: string };

// F-bounded: `SN` is instantiated with `keyof G`, so every `target` /
// `otherwise` / `fallback` is validated against the SAME object's own keys.
export type Graph<G> = {
  readonly [S in keyof G]: {
    readonly on?: Readonly<Record<string, EdgeSpec<Extract<keyof G, string>>>>;
  };
};

/**
 * Second F-bound layer. Constraint checking is plain assignability — it does
 * NOT run excess-property checks — so `{ target, whn, otherwise }` structurally
 * satisfies `{ target: SN; cmd?: string }` and a typo'd `when` would silently
 * drop the guard. This maps each edge to `unknown` (fine) or to a marker object
 * naming the offending field, which the object-literal check then rejects.
 */
type KnownEdgeField = "target" | "cmd" | "when" | "otherwise" | "resume";
export type StrictEdges<G> = {
  readonly [S in keyof G]: {
    readonly on?: {
      readonly [E in keyof On<G, S>]: On<G, S>[E] extends string
        ? unknown
        : [Exclude<keyof On<G, S>[E], KnownEdgeField>] extends [never]
          ? unknown
          : {
              readonly __edgeHasUnknownField: Exclude<
                keyof On<G, S>[E],
                KnownEdgeField
              >;
            };
    };
  };
};

// `const G` preserves the nested literals with no `as const` at the call site
// (without it the edge VALUES — targets, guard names — widen to `string` and
// every derivation below collapses); `extends Graph<G> & StrictEdges<G>` closes
// the loop on target validity and on unknown edge fields.
// `StrictEdges` sits on the PARAMETER, not on the constraint: intersecting it
// into the constraint made the typo'd-target diagnostic collapse to a 4-line
// index-signature complaint about `string` and lose tsc's "Did you mean
// '"review"'?" suggestion. On the parameter, the constraint failure is reported
// first and cleanly, and the unknown-field check still fires on well-formed
// graphs.
export function defineGraph<const G extends Graph<G>>(g: G & StrictEdges<G>): G {
  return g;
}

// ── 2. derivations off the graph ───────────────────────────────────────────
type On<G, S extends keyof G> = G[S] extends { readonly on: infer O }
  ? O
  : Record<never, never>;

type EdgeAt<G, S extends keyof G, E> = E extends keyof On<G, S>
  ? On<G, S>[E]
  : never;

export type StateName<G> = Extract<keyof G, string>;

export type EventName<G> = Extract<
  { [S in keyof G]: keyof On<G, S> }[keyof G],
  string
>;

/** The `State.Event` pairs that are ACTUALLY declared — not the cross product. */
export type EdgeKey<G> = {
  [S in keyof G]: `${Extract<S, string>}.${Extract<keyof On<G, S>, string>}`;
}[keyof G];

// ── 3. the resume ("hist") derivation ──────────────────────────────────────
/** States that carry a `resume` edge out of them — the parking states. */
export type ParkingState<G> = Extract<
  {
    [S in keyof G]: {
      [E in keyof On<G, S>]: On<G, S>[E] extends { readonly resume: unknown }
        ? S
        : never;
    }[keyof On<G, S>];
  }[keyof G],
  string
>;

/** Every state an edge can land on (guarded edges contribute both arms). */
type TargetOf<X> = X extends string
  ? X
  : X extends { readonly target: infer T }
    ? T | (X extends { readonly otherwise: infer O } ? O : never)
    : never;

/** States with an edge INTO `P` — i.e. the states you could have been parked from. */
type ResumeSource<G, P> = {
  [S in keyof G]: {
    [E in keyof On<G, S>]: P extends TargetOf<On<G, S>[E]> ? S : never;
  }[keyof On<G, S>];
}[keyof G];

/** The `fallback` declared on `P`'s resume edge — Umut's `?? initial`. */
type FallbackOf<G, P extends keyof G> = {
  [E in keyof On<G, P>]: On<G, P>[E] extends {
    readonly resume: { readonly fallback: infer F };
  }
    ? F
    : never;
}[keyof On<G, P>];

/**
 * Where a resume edge out of parking state `P` can land: any state that has an
 * edge into `P`, plus the declared fallback. This is `was ?? initial` lifted to
 * a type — and it is DERIVED, so adding a `BLOCKED` edge from a new state
 * automatically widens the legal `was`.
 */
export type ResumeTargets<G, P extends keyof G> = Extract<
  ResumeSource<G, P> | FallbackOf<G, P>,
  string
>;

// ── 4. state / msg unions ──────────────────────────────────────────────────
export type StateOf<G, D extends Record<StateName<G>, object>> = {
  [S in StateName<G>]: { readonly type: S } & D[S];
}[StateName<G>];

export type MsgOf<G, P extends Record<EventName<G>, object>> = {
  [E in EventName<G>]: { readonly type: E } & P[E];
}[EventName<G>];

/** Namespace a Msg union at the TYPE level — stays a literal union, never `string`. */
export type Namespaced<
  M extends { type: string },
  NS extends string,
> = M extends unknown
  ? Omit<M, "type"> & { readonly type: `${NS}.${M["type"]}` }
  : never;

// ── 5. the parts the config cannot own ─────────────────────────────────────
type Narrow<U, K> = Extract<U, { type: K }>;
type Data<S, K> = K extends string ? Omit<Narrow<S, K>, "type"> : never;

type UnionToIntersection<U> = (
  U extends unknown ? (x: U) => void : never
) extends (x: infer I) => void
  ? I
  : never;

/**
 * What an `assign` must return for a given target. `was` is stripped when the
 * target is a parking state: the compiler injects it from `state.type`, so the
 * author can neither forget it nor type it wrong.
 */
type Assigned<G, S, T> = T extends string
  ? T extends ParkingState<G>
    ? Omit<Data<S, T>, "was">
    : Data<S, T>
  : never;

type Fn<S, M, From, Ev, R> = (state: Narrow<S, From>, msg: Narrow<M, Ev>) => R;

type Cell<G, X, S, M, From extends keyof G, Ev> = X extends {
  readonly resume: unknown;
}
  ? // a resume edge may land on ANY resume target → the payload must satisfy
    // all of them, hence the intersection (not the union).
    Fn<S, M, From, Ev, UnionToIntersection<Assigned<G, S, ResumeTargets<G, From>>>>
  : X extends { readonly target: infer T; readonly otherwise: infer O }
    ? {
        readonly then: Fn<S, M, From, Ev, Assigned<G, S, T>>;
        readonly else: Fn<S, M, From, Ev, Assigned<G, S, O>>;
      }
    : X extends { readonly target: infer T }
      ? Fn<S, M, From, Ev, Assigned<G, S, T>>
      : X extends string
        ? Fn<S, M, From, Ev, Assigned<G, S, X>>
        : never;

export type Assigns<
  G,
  S extends { type: string },
  M extends { type: string },
> = {
  [K in EdgeKey<G>]: K extends `${infer From}.${infer Ev}`
    ? From extends keyof G
      ? Cell<G, EdgeAt<G, From, Ev>, S, M, From, Ev>
      : never
    : never;
};

// ── 6. guards / cmds, typed FROM THEIR USE SITES ───────────────────────────
export type GuardName<G> = Extract<
  {
    [S in keyof G]: {
      [E in keyof On<G, S>]: On<G, S>[E] extends { readonly when: infer W }
        ? W
        : never;
    }[keyof On<G, S>];
  }[keyof G],
  string
>;

export type CmdName<G> = Extract<
  {
    [S in keyof G]: {
      [E in keyof On<G, S>]: On<G, S>[E] extends { readonly cmd: infer W }
        ? W
        : never;
    }[keyof On<G, S>];
  }[keyof G],
  string
>;

/** Scan the graph for every edge whose `when`/`cmd` equals `Name`. */
type SitesWhere<G, F extends "when" | "cmd", Name> = {
  [S in keyof G]: {
    [E in keyof On<G, S>]: On<G, S>[E] extends Record<F, Name>
      ? `${Extract<S, string>}.${Extract<E, string>}`
      : never;
  }[keyof On<G, S>];
}[keyof G];

/** `"review.FAIL"` → `[state: ReviewState, msg: FailMsg]`. Distributes over N sites. */
type SiteArgs<K, S, M> = K extends `${infer From}.${infer Ev}`
  ? [state: Narrow<S, From>, msg: Narrow<M, Ev>]
  : never;

/**
 * THE POINT. A guard's parameters come from the edges that REFERENCE it, not
 * from a standalone registry declaration — so `retriesRemaining`, used only at
 * `review.FAIL`, receives exactly `review`'s state and `FAIL`'s msg.
 */
export type Guards<G, S extends { type: string }, M extends { type: string }> = {
  [N in GuardName<G>]: (...args: SiteArgs<SitesWhere<G, "when", N>, S, M>) => boolean;
};

export type Cmds<
  G,
  S extends { type: string },
  M extends { type: string },
  C extends Cmd,
> = {
  [N in CmdName<G>]: (
    ...args: SiteArgs<SitesWhere<G, "cmd", N>, S, M>
  ) => Omit<Narrow<C, N>, "type">;
};

// ── 7. identity assertion helpers ──────────────────────────────────────────
export type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <
  T,
>() => T extends B ? 1 : 2
  ? true
  : false;
export type Assert<T extends true> = T;
