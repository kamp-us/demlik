// ═══════════════════════════════════════════════════════════════════════════
// TYPE MACHINERY — everything in this file is erased at runtime.
// ═══════════════════════════════════════════════════════════════════════════
import type { Cmd } from "../pure/core";

// ── 1. the graph shape ─────────────────────────────────────────────────────
// An edge is either a bare target name, a target with optional cmd, a GUARDED
// target (`when` + `otherwise`), or a RESUME edge (go back to `was ?? fallback`).
/**
 * A cmd reference on an edge: one name, or an ORDERED list of names. The list
 * is what buys `Cmd.batch` — an edge that fires N effects in a fixed order.
 */
export type CmdRef = string | readonly string[];

export type EdgeSpec<SN extends string> =
  | SN
  | { readonly target: SN; readonly cmd?: CmdRef }
  | {
      readonly target: SN;
      readonly when: string;
      readonly otherwise: SN;
      /** Fires only when the guard HOLDS. */
      readonly cmd?: CmdRef;
      /** Fires only when the guard FAILS — `Cmd.when` lifted onto the edge. */
      readonly otherwiseCmd?: CmdRef;
    }
  | { readonly resume: { readonly fallback: SN }; readonly cmd?: CmdRef };

// F-bounded: `SN` is instantiated with `keyof G`, so every `target` /
// `otherwise` / `fallback` is validated against the SAME object's own keys.
export type Graph<G> = {
  readonly [S in keyof G]: {
    /** Exactly one state in a machine-bearing graph marks itself the entry. */
    readonly initial?: true;
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
type KnownEdgeField =
  | "target"
  | "cmd"
  | "otherwiseCmd"
  | "when"
  | "otherwise"
  | "resume";
type EdgeCheck<X> = X extends string
  ? unknown
  : [Exclude<keyof X, KnownEdgeField>] extends [never]
    ? // `otherwiseCmd` is meaningless without a guard to have an "otherwise":
      // it would sit on an unguarded edge and silently never fire.
      X extends { readonly otherwiseCmd: unknown }
      ? X extends { readonly when: string }
        ? unknown
        : { readonly __otherwiseCmdWithoutAGuard: true }
      : unknown
    : { readonly __edgeHasUnknownField: Exclude<keyof X, KnownEdgeField> };

export type StrictEdges<G> = {
  readonly [S in keyof G]: {
    readonly on?: {
      readonly [E in keyof On<G, S>]: EdgeCheck<On<G, S>[E]>;
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

/**
 * The state marked `initial: true` — the graph's entry. Declared ON the graph
 * so the entry edge is data (`machine-viz` can draw `[*] --> queued`) instead
 * of a fact the author repeats in the hand-written `init`.
 */
export type InitialState<G> = Extract<
  {
    [S in keyof G]: G[S] extends { readonly initial: true } ? S : never;
  }[keyof G],
  string
>;

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

type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;

/**
 * What `boot()` must return: the initial state's payload, minus the `type` the
 * compiler stamps on. The two degenerate graphs get a NAMED marker type rather
 * than a silent `never`, so the diagnostic says which rule was broken.
 */
export type InitialData<G, S extends { type: string }> = [
  InitialState<G>,
] extends [never]
  ? { readonly __graphDeclaresNoInitialState: true }
  : [IsUnion<InitialState<G>>] extends [true]
    ? { readonly __graphDeclaresManyInitialStates: InitialState<G> }
    : Data<S, InitialState<G>>;

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

/** Flatten a `CmdRef` — one name, or every name in an ordered list. */
type Flatten<C> = C extends readonly string[] ? C[number] : C;

/** Every cmd an edge can fire, across BOTH guard arms. */
type EdgeCmds<X> =
  | (X extends { readonly cmd: infer C } ? Flatten<C> : never)
  | (X extends { readonly otherwiseCmd: infer C } ? Flatten<C> : never);

export type CmdName<G> = Extract<
  {
    [S in keyof G]: {
      [E in keyof On<G, S>]: EdgeCmds<On<G, S>[E]>;
    }[keyof On<G, S>];
  }[keyof G],
  string
>;

/** What field `F` on an edge REFERENCES — a guard name, or its cmd names. */
type Referenced<X, F extends "when" | "cmd"> = F extends "when"
  ? X extends { readonly when: infer W }
    ? W
    : never
  : EdgeCmds<X>;

/**
 * Scan the graph for every edge that references `Name` through field `F`.
 * `[Name] extends [Referenced<…>]` rather than an equality check, because an
 * edge's cmd list references SEVERAL names at once.
 */
type SitesWhere<G, F extends "when" | "cmd", Name> = {
  [S in keyof G]: {
    [E in keyof On<G, S>]: [Name] extends [Referenced<On<G, S>[E], F>]
      ? `${Extract<S, string>}.${Extract<E, string>}`
      : never;
  }[keyof On<G, S>];
}[keyof G];

/**
 * `"review.FAIL"` → `[state: ReviewState, msg: FailMsg, at: "review.FAIL"]`.
 * Distributes over N sites, so a multi-site name yields a UNION OF TUPLES.
 *
 * The third element is the correlator. A union of tuples does not, on its own,
 * keep `state` and `msg` in step: narrowing `state.type` is a NESTED
 * discriminant, and TypeScript's dependent-parameter control-flow analysis
 * (TS 4.6, microsoft/TypeScript#47109) only re-narrows sibling parameters from
 * a discriminant that is a DIRECT, literal-typed element of the union. `at` is
 * exactly that: one `switch (at)` / `if (at === …)` collapses the tuple union
 * to a single member, and `state` AND `msg` both narrow with it — in either
 * direction, since the tag determines both.
 *
 * For a single-site name `K` is not a union, so this is a lone tuple and the
 * author may keep writing `(s, m) => …`: a shorter parameter list is
 * assignable to a longer non-union rest signature. `at` only becomes
 * mandatory where it is the only thing that can carry the correlation.
 */
type SiteArgs<K, S, M> = K extends `${infer From}.${infer Ev}`
  ? [state: Narrow<S, From>, msg: Narrow<M, Ev>, at: K]
  : never;

/**
 * THE POINT. A guard's parameters come from the edges that REFERENCE it, not
 * from a standalone registry declaration — so `retriesRemaining`, used only at
 * `review.FAIL`, receives exactly `review`'s state and `FAIL`'s msg.
 */
export type Guards<G, S extends { type: string }, M extends { type: string }> = {
  [N in GuardName<G>]: (...args: SiteArgs<SitesWhere<G, "when", N>, S, M>) => boolean;
};

/**
 * The payload a builder owes: its Cmd variant minus the `type` the compiler
 * stamps on. A name with NO matching variant in `C` would otherwise collapse
 * to `Omit<never, "type">` — which accepts anything — so it gets a marker.
 */
type CmdPayload<C extends Cmd, N> = [Narrow<C, N>] extends [never]
  ? { readonly __noCmdVariantNamed: N }
  : Omit<Narrow<C, N>, "type">;

/**
 * Same technique as `Guards`: a cmd's parameters come from the edges that
 * REFERENCE it. A cmd fired from two edges gets the union of both sites'
 * `[state, msg]` tuples, so its builder must handle both.
 */
export type Cmds<
  G,
  S extends { type: string },
  M extends { type: string },
  C extends Cmd,
> = {
  [N in CmdName<G>]: (
    ...args: SiteArgs<SitesWhere<G, "cmd", N>, S, M>
  ) => CmdPayload<C, N>;
};

// ── 7. identity assertion helpers ──────────────────────────────────────────
export type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <
  T,
>() => T extends B ? 1 : 2
  ? true
  : false;
export type Assert<T extends true> = T;
