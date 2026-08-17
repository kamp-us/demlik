// ═══════════════════════════════════════════════════════════════════════════
// TYPE MACHINERY — everything in this file is erased at runtime.
//
// ONE CHART, ONE SITE PER FACT.
//
// The chart is a single value with four sections. Each fact is DECLARED in
// exactly one of them and everything else is derived:
//
//   ctx     — the data every state carries.                          (1 site)
//   events  — the event alphabet: name, payload, and SCOPE.          (1 site)
//   cmds    — the effect alphabet: name and payload.                 (1 site)
//   states  — states grouped into named PHASES, each with its edges. (1 site)
//
// The Msg union, the State union, the Cmd union, the guard signatures, the cmd
// builder signatures, the `was` field on parking states, the entry state and
// the totality obligation are all DERIVED from that one value. Nothing in the
// author's file names a state, an event or a cmd twice as a *declaration*; the
// only repeats are *references* (an edge naming its target, an `assign` key
// naming the edge it implements), which are the facts themselves.
// ═══════════════════════════════════════════════════════════════════════════
import type { Cmd } from "../pure/core";

// ── 0. the phantom-type carrier ────────────────────────────────────────────
/**
 * A type smuggled through a value position. `ty<{ at: number }>()` is an empty
 * object at runtime whose TYPE remembers `{ at: number }` — which is what lets
 * an event declare its payload IN the chart instead of in a parallel type map
 * the author has to keep in step.
 */
export interface Ty<T> {
  readonly __ty: T;
}
export const ty = <T>(): Ty<T> => ({}) as unknown as Ty<T>;

/** `Ty<T>` → `T`; anything else (an absent `data`) → the neutral `unknown`. */
type Payload<X> = X extends Ty<infer T> ? T : unknown;

// ── 1. section accessors ───────────────────────────────────────────────────
type EvMap<C> = C extends { readonly events: infer E } ? E : never;
type CmdMap<C> = C extends { readonly cmds: infer M } ? M : Record<never, never>;
type Groups<C> = C extends { readonly states: infer G } ? G : never;
type CtxOf<C> = C extends { readonly ctx: infer T } ? Payload<T> : unknown;

export type EventName<C> = Extract<keyof EvMap<C>, string>;
export type CmdName<C> = Extract<keyof CmdMap<C>, string>;
/** The named phases — `keyof states`. A group name is declared by BEING a key. */
export type GroupName<C> = Extract<keyof Groups<C>, string>;

export type StateName<C> = Extract<
  { [G in keyof Groups<C>]: keyof Groups<C>[G] }[keyof Groups<C>],
  string
>;

/** The node for state `S`, found by scanning the groups. Groups partition. */
type NodeAt<C, S> = {
  [G in keyof Groups<C>]: S extends keyof Groups<C>[G] ? Groups<C>[G][S] : never;
}[keyof Groups<C>];

/** The phase `S` lives in. A union here means `S` was declared twice. */
export type GroupOf<C, S> = Extract<
  {
    [G in keyof Groups<C>]: S extends keyof Groups<C>[G] ? G : never;
  }[keyof Groups<C>],
  string
>;

// naked-parameter helpers: a conditional distributes only over a bare `X`.
type OnOf<X> = X extends { readonly on: infer O } ? O : Record<never, never>;
type IgnoreOf<X> = X extends { readonly ignore: readonly (infer I)[] }
  ? Extract<I, string>
  : never;
type DataOf<X> = X extends { readonly data: infer D } ? Payload<D> : unknown;
type IsEndOf<X> = X extends { readonly end: true } ? true : false;
type IsInitialOf<X> = X extends { readonly initial: true } ? true : false;
type ScopeOf<X> = X extends { readonly scope: infer S }
  ? S extends readonly string[]
    ? S[number]
    : S
  : never;

type On<C, S> = OnOf<NodeAt<C, S>>;
type IgnoredAt<C, S> = IgnoreOf<NodeAt<C, S>>;

// ── 2. the edge shape ──────────────────────────────────────────────────────
/** A cmd reference on an edge: one declared name, or an ORDERED list of them. */
export type CmdRef<N extends string> = N | readonly N[];

export type EdgeSpec<SN extends string, CN extends string> =
  | SN
  // ── THE ESCAPE HATCH ────────────────────────────────────────────────────
  // The author declares the SET of reachable targets; a hand-written cell
  // picks one at runtime and returns `[state, cmds]` itself. Everything the
  // chart is for is still declared here — `to` is the fan-out `machine-viz`
  // draws and the union the cell's return type is clamped to — and the one
  // thing the chart genuinely cannot know (WHICH of them, this time) is the
  // only thing left in code.
  | { readonly to: readonly SN[]; readonly cell: string }
  | { readonly target: SN; readonly cmd?: CmdRef<CN> }
  | {
      readonly target: SN;
      readonly when: string;
      readonly otherwise: SN;
      /** Fires only when the guard HOLDS. */
      readonly cmd?: CmdRef<CN>;
      /** Fires only when the guard FAILS — `Cmd.when` lifted onto the edge. */
      readonly otherwiseCmd?: CmdRef<CN>;
    }
  | { readonly resume: { readonly fallback: SN }; readonly cmd?: CmdRef<CN> };

// ── 3. SCOPE — the answer to the |S| × |M| enumeration problem ─────────────
//
// The old design made every state list the events it deliberately drops. That
// is correct and it scales as |S| × |M|: 30 states × 12 events is ~300 hand-
// typed strings, which the author produces by pasting the tsc error back.
//
// The fact being written 300 times is really |M| facts, one per event: WHERE
// DOES THIS EVENT MEAN ANYTHING? So it is declared once, on the event, as its
// `scope` — a dial with three settings:
//
//   "edges"   — targeted. Live exactly where it is routed; everywhere else it
//               is not "ignored", it is simply not addressed to that state.
//               Obligation: none. Cost: one word.
//   <phase>   — broadcast within a phase (or a list of phases). Every state in
//               that phase must handle it or `ignore` it BY NAME. Adding a
//               state to the phase turns that state red, naming the pair.
//   "all"     — broadcast machine-wide. Every state must decide. This is the
//               old behaviour, still available, now opt-in per event.
//
// Totality is unchanged in form: a pair that is neither handled nor covered by
// a decision fails to compile, naming the pair. What changed is that the
// decision may be QUANTIFIED (one word, on the event) instead of ENUMERATED
// (one string per cell). See `.decisions` note in the report: forcing a
// per-pair reconsideration on every new event *requires* |S| × |M| author-owned
// sites — that is the one thing the two goals genuinely trade against.
type ScopeRef<C> = "edges" | "all" | GroupName<C>;

/**
 * The event's declared scope — with one guard. When some OTHER error in the
 * chart literal (a typo'd target, say) defeats inference of `C`, tsc falls back
 * to the constraint, where `scope` is the whole `ScopeRef<C>` universe. Left
 * alone that makes every event look live in every phase and buries the one real
 * diagnostic under a wall of spurious unhandled-pair demands. A scope that
 * spans the entire universe is not a scope, so it is read as no scope at all.
 */
type ScopeAt<C, E extends keyof EvMap<C>> = [ScopeRef<C>] extends [
  ScopeOf<EvMap<C>[E]>,
]
  ? never
  : ScopeOf<EvMap<C>[E]>;

/** The events that are LIVE at `S` — i.e. that `S` owes a decision about. */
type LiveAt<C, S> = {
  [E in EventName<C>]: "all" extends ScopeAt<C, E>
    ? E
    : [GroupOf<C, S>] extends [ScopeAt<C, E>]
      ? E
      : never;
}[EventName<C>];

/** Pairs at `S` that are live, unhandled and unrefused. Empty = total. */
export type MissingAt<C, S> = [IsEndOf<NodeAt<C, S>>] extends [true]
  ? never
  : Exclude<LiveAt<C, S>, Extract<keyof On<C, S>, string> | IgnoredAt<C, S>>;

/** Every unhandled pair in the whole chart — `never` when the chart is total. */
export type MissingPairs<C> = {
  [S in StateName<C>]: `${S}.${Extract<MissingAt<C, S>, string>}`;
}[StateName<C>];

// ── 4. the chart shape (F-bounded: every reference checked against itself) ──
export type Chart<C> = {
  /** Data EVERY state carries. Declared once; intersected into all of them. */
  readonly ctx?: Ty<object>;
  readonly events: {
    readonly [E in keyof EvMap<C>]: {
      readonly data?: Ty<object>;
      // written out rather than aliased: tsc prints the alias NAME in the
      // diagnostic, and the author needs to see the phase names themselves
      // (and get tsc's "Did you mean …?" against them).
      readonly scope:
        | "edges"
        | "all"
        | GroupName<C>
        | readonly ("edges" | "all" | GroupName<C>)[];
    };
  };
  readonly cmds?: { readonly [N in keyof CmdMap<C>]: Ty<object> };
  readonly states: {
    readonly [G in keyof Groups<C>]: {
      readonly [S in keyof Groups<C>[G]]: {
        /** Exactly one state in a machine-bearing chart marks itself the entry. */
        readonly initial?: true;
        /** Extra data only THIS state carries, on top of `ctx`. */
        readonly data?: Ty<object>;
        readonly on?: {
          readonly [E in EventName<C>]?: EdgeSpec<StateName<C>, CmdName<C>>;
        };
        /** Per-state exception: refuse a live event by name. */
        readonly ignore?: readonly EventName<C>[];
        readonly end?: true;
      };
    };
  };
};

// ── 5. the strictness layers that assignability alone does not buy ─────────
//
// Constraint checking is plain assignability — it does NOT run excess-property
// checks — so `{ target, whn, otherwise }` structurally satisfies
// `{ target: SN; cmd?: … }` and a typo'd `when` would silently drop the guard,
// and a typo'd EVENT key in `on` would silently invent an edge for an event
// that does not exist. These map the offending shape to a marker object naming
// the offender, which the object-literal check then rejects.
type KnownEdgeField =
  | "target"
  | "cmd"
  | "otherwiseCmd"
  | "when"
  | "otherwise"
  | "resume"
  | "to"
  | "cell";

/**
 * A cell edge OWNS its transition end to end — it picks the target and returns
 * its own cmds. So every declarative field that would also decide one of those
 * is illegal ALONGSIDE it, rather than silently ignored by the walk:
 *
 *   `cmd`/`otherwiseCmd` — the cell already returns the cmd list (req. 4)
 *   `when`/`otherwise`   — the cell already chose (a guard would choose twice)
 *   `target`/`resume`    — same fact as `to`, said a second way
 *
 * The `assign` bypass (req. 6) is caught one level up: `Assigns` is keyed by
 * `EdgeKey` MINUS the cell edges, so writing `"polling.poll_failed"` in the
 * assign bag of a cell edge is an excess property, named by tsc.
 */
type CellFieldConflict =
  | "target"
  | "cmd"
  | "otherwiseCmd"
  | "when"
  | "otherwise"
  | "resume";

type CellCheck<X> = X extends { readonly cell: string }
  ? X extends { readonly to: readonly unknown[] }
    ? [Extract<keyof X, CellFieldConflict>] extends [never]
      ? unknown
      : {
          readonly __cellEdgeCannotAlsoDeclare: Extract<
            keyof X,
            CellFieldConflict
          >;
        }
    : { readonly __cellEdgeMustDeclareItsTargetsInTo: true }
  : X extends { readonly to: readonly unknown[] }
    ? { readonly __toWithoutACellToPickFromIt: true }
    : unknown;

type EdgeCheck<X> = X extends string
  ? unknown
  : [Exclude<keyof X, KnownEdgeField>] extends [never]
    ? CellCheck<X> &
        // `otherwiseCmd` is meaningless without a guard to have an "otherwise":
        // it would sit on an unguarded edge and silently never fire.
        (X extends { readonly otherwiseCmd: unknown }
          ? X extends { readonly when: string }
            ? unknown
            : { readonly __otherwiseCmdWithoutAGuard: true }
          : unknown)
    : { readonly __edgeHasUnknownField: Exclude<keyof X, KnownEdgeField> };

type StrictNode<C, N> = {
  readonly on?: {
    readonly [E in keyof OnOf<N>]: E extends EventName<C>
      ? EdgeCheck<OnOf<N>[E]>
      : { readonly __onDeclaresAnUndeclaredEvent: E };
  };
};

export type Strict<C> = {
  readonly states: {
    readonly [G in keyof Groups<C>]: {
      readonly [S in keyof Groups<C>[G]]: StrictNode<C, Groups<C>[G][S]>;
    };
  };
};

// The diagnostic IS the property name: tsc reports the missing property
// verbatim, so the author reads which pair and what the fixes are without
// decoding a type. Value `never` so it cannot be silenced by writing the key.
type Demand<S extends string, E extends string> = E extends string
  ? `unhandled pair "${S}.${E}" — declare it in \`on\`, or list "${E}" in this state's \`ignore\`, or narrow the \`scope\` of event "${E}"`
  : never;

type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;

export type Total<C> = {
  readonly states: {
    readonly [G in keyof Groups<C>]: {
      readonly [S in keyof Groups<C>[G]]: ([MissingAt<C, S>] extends [never]
        ? unknown
        : {
            readonly [K in Demand<
              Extract<S, string>,
              Extract<MissingAt<C, S>, string>
            >]: never;
          }) &
        // `end: true` means "accepts nothing" — it cannot also accept something.
        ([Extract<keyof On<C, S>, string>] extends [never]
          ? unknown
          : [IsEndOf<Groups<C>[G][S]>] extends [true]
            ? { readonly __endStateCannotDeclareEdges: keyof On<C, S> }
            : unknown) &
        // a state may live in exactly one phase.
        ([IsUnion<GroupOf<C, S>>] extends [true]
          ? { readonly __stateDeclaredInTwoPhases: GroupOf<C, S> }
          : unknown) &
        // an `ignore` entry that refuses an event which is not live here
        // refuses nothing — the paste-the-error-back loop, caught.
        ([Exclude<IgnoredAt<C, S>, LiveAt<C, S>>] extends [never]
          ? unknown
          : {
              readonly __refusalRefusesNothing: Exclude<
                IgnoredAt<C, S>,
                LiveAt<C, S>
              >;
            });
    };
  };
};

/**
 * `const C` preserves the nested literals with no `as const` at the call site
 * (without it every edge value widens to `string` and every derivation below
 * collapses). `Strict` and `Total` sit on the PARAMETER, not on the constraint:
 * intersecting them into the constraint makes the typo'd-target diagnostic
 * collapse to an index-signature complaint about `string` and lose tsc's
 * "Did you mean '"review"'?" suggestion.
 */
export function defineChart<const C extends Chart<C>>(
  c: C & Strict<C> & Total<C>,
): C {
  return c;
}

// ── 6. derivations off the chart ───────────────────────────────────────────
type EdgeAt<C, S, E> = E extends keyof On<C, S> ? On<C, S>[E] : never;

/** The `State.Event` pairs that are ACTUALLY declared — not the cross product. */
export type EdgeKey<C> = {
  [S in StateName<C>]: `${S}.${Extract<keyof On<C, S>, string>}`;
}[StateName<C>];

/** The subset of `EdgeKey` whose transition is delegated to a cell. */
export type CellEdgeKey<C> = Extract<
  {
    [S in StateName<C>]: {
      [E in keyof On<C, S>]: On<C, S>[E] extends { readonly cell: string }
        ? `${S}.${Extract<E, string>}`
        : never;
    }[keyof On<C, S>];
  }[StateName<C>],
  string
>;

/** The state marked `initial: true` — the chart's entry, as data. */
export type InitialState<C> = Extract<
  {
    [S in StateName<C>]: [IsInitialOf<NodeAt<C, S>>] extends [true] ? S : never;
  }[StateName<C>],
  string
>;

// ── 7. the resume ("hist") derivation ──────────────────────────────────────
/** States that carry a `resume` edge out of them — the parking states. */
export type ParkingState<C> = Extract<
  {
    [S in StateName<C>]: {
      [E in keyof On<C, S>]: On<C, S>[E] extends { readonly resume: unknown }
        ? S
        : never;
    }[keyof On<C, S>];
  }[StateName<C>],
  string
>;

/** The targets a CELL edge declares — the union its cell is clamped to. */
type ToOf<X> = X extends { readonly to: readonly (infer T)[] } ? T : never;

/**
 * Every state an edge can land on. A guarded edge contributes both arms; a
 * cell edge contributes its whole declared `to` fan-out — which is precisely
 * why the escape hatch does not blind the derivations (`ResumeTargets`,
 * `chartMermaid`) that read the graph's shape.
 */
type TargetOf<X> = X extends string
  ? X
  : X extends { readonly to: readonly unknown[] }
    ? ToOf<X>
    : X extends { readonly target: infer T }
      ? T | (X extends { readonly otherwise: infer O } ? O : never)
      : never;

/** States with an edge INTO `P` — i.e. the states you could be parked from. */
type ResumeSource<C, P> = {
  [S in StateName<C>]: {
    [E in keyof On<C, S>]: P extends TargetOf<On<C, S>[E]> ? S : never;
  }[keyof On<C, S>];
}[StateName<C>];

/** The `fallback` declared on `P`'s resume edge — Umut's `?? initial`. */
type FallbackOf<C, P> = {
  [E in keyof On<C, P>]: On<C, P>[E] extends {
    readonly resume: { readonly fallback: infer F };
  }
    ? F
    : never;
}[keyof On<C, P>];

/**
 * Where a resume edge out of parking state `P` can land: any state with an edge
 * into `P`, plus the declared fallback. `was ?? initial` lifted to a type — and
 * DERIVED, so adding a `BLOCKED` edge from a new state widens the legal `was`.
 */
export type ResumeTargets<C, P> = Extract<
  ResumeSource<C, P> | FallbackOf<C, P>,
  string
>;

// ── 8. the three unions, all derived from the one chart ────────────────────
/**
 * `was` is INJECTED here, not authored: a parking state is one with a `resume`
 * edge, which the chart already says. Writing `blocked: Ctx & { was: … }` by
 * hand would be that same fact a second time.
 */
export type StateOf<C> = {
  [S in StateName<C>]: { readonly type: S } & CtxOf<C> &
    DataOf<NodeAt<C, S>> &
    (S extends ParkingState<C> ? { readonly was: ResumeTargets<C, S> } : unknown);
}[StateName<C>];

export type MsgOf<C> = {
  [E in EventName<C>]: { readonly type: E } & DataOf<EvMap<C>[E]>;
}[EventName<C>];

export type CmdOf<C> = [CmdName<C>] extends [never]
  ? Cmd<never>
  : {
      [N in CmdName<C>]: { readonly type: N } & Payload<CmdMap<C>[N]>;
    }[CmdName<C>];

/** Namespace a Msg union at the TYPE level — stays a literal union, never `string`. */
export type Namespaced<
  M extends { type: string },
  NS extends string,
> = M extends unknown
  ? Omit<M, "type"> & { readonly type: `${NS}.${M["type"]}` }
  : never;

// ── 9. the parts the chart cannot own ──────────────────────────────────────
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
type Assigned<C, S, T> = T extends string
  ? T extends ParkingState<C>
    ? Omit<Data<S, T>, "was">
    : Data<S, T>
  : never;

/**
 * What `boot()` must return: the initial state's payload, minus the `type` the
 * compiler stamps on. The two degenerate charts get a NAMED marker type rather
 * than a silent `never`, so the diagnostic says which rule was broken.
 */
export type InitialData<C, S extends { type: string }> = [
  InitialState<C>,
] extends [never]
  ? { readonly __chartDeclaresNoInitialState: true }
  : [IsUnion<InitialState<C>>] extends [true]
    ? { readonly __chartDeclaresManyInitialStates: InitialState<C> }
    : Data<S, InitialState<C>>;

type Fn<S, M, From, Ev, R> = (state: Narrow<S, From>, msg: Narrow<M, Ev>) => R;

type Cell<C, X, S, M, From, Ev> = X extends { readonly resume: unknown }
  ? // a resume edge may land on ANY resume target → the payload must satisfy
    // all of them, hence the intersection (not the union).
    Fn<S, M, From, Ev, UnionToIntersection<Assigned<C, S, ResumeTargets<C, From>>>>
  : X extends { readonly target: infer T; readonly otherwise: infer O }
    ? {
        readonly then: Fn<S, M, From, Ev, Assigned<C, S, T>>;
        readonly else: Fn<S, M, From, Ev, Assigned<C, S, O>>;
      }
    : X extends { readonly target: infer T }
      ? Fn<S, M, From, Ev, Assigned<C, S, T>>
      : X extends string
        ? Fn<S, M, From, Ev, Assigned<C, S, X>>
        : never;

/**
 * The payload builders — one per DECLARATIVE edge. Cell edges are excluded:
 * a cell returns the whole next state itself, so an `assign` entry for one
 * would be dead code the walk never calls. Because this is a mapped type over
 * a closed key union, writing that entry anyway is an excess property and tsc
 * names it (req. 6 — the bypass is a compile error, not a surprise).
 */
export type Assigns<
  C,
  S extends { type: string },
  M extends { type: string },
> = {
  [K in Exclude<EdgeKey<C>, CellEdgeKey<C>>]: K extends `${infer From}.${infer Ev}`
    ? Cell<C, EdgeAt<C, From, Ev>, S, M, From, Ev>
    : never;
};

// ── 10. guards / cmds, typed FROM THEIR USE SITES ──────────────────────────
export type GuardName<C> = Extract<
  {
    [S in StateName<C>]: {
      [E in keyof On<C, S>]: On<C, S>[E] extends { readonly when: infer W }
        ? W
        : never;
    }[keyof On<C, S>];
  }[StateName<C>],
  string
>;

/** Every cell named by a `{ to, cell }` edge — the escape hatch's alphabet. */
export type CellName<C> = Extract<
  {
    [S in StateName<C>]: {
      [E in keyof On<C, S>]: On<C, S>[E] extends { readonly cell: infer W }
        ? W
        : never;
    }[keyof On<C, S>];
  }[StateName<C>],
  string
>;

/** Flatten a `CmdRef` — one name, or every name in an ordered list. */
type Flatten<X> = X extends readonly string[] ? X[number] : X;

/** Every cmd an edge can fire, across BOTH guard arms. */
type EdgeCmds<X> =
  | (X extends { readonly cmd: infer Q } ? Flatten<Q> : never)
  | (X extends { readonly otherwiseCmd: infer Q } ? Flatten<Q> : never);

/** Every cmd name any edge in the chart actually FIRES declaratively. */
export type UsedCmdName<C> = Extract<
  {
    [S in StateName<C>]: {
      [E in keyof On<C, S>]: EdgeCmds<On<C, S>[E]>;
    }[keyof On<C, S>];
  }[StateName<C>],
  string
>;

/** What field `F` on an edge REFERENCES — a guard/cell name, or its cmd names. */
type Referenced<X, F extends "when" | "cmd" | "cell"> = F extends "when"
  ? X extends { readonly when: infer W }
    ? W
    : never
  : F extends "cell"
    ? X extends { readonly cell: infer W }
      ? W
      : never
    : EdgeCmds<X>;

/**
 * Scan the chart for every edge that references `Name` through field `F`.
 * `[Name] extends [Referenced<…>]` rather than an equality check, because an
 * edge's cmd list references SEVERAL names at once.
 */
type SitesWhere<C, F extends "when" | "cmd" | "cell", Name> = {
  [S in StateName<C>]: {
    [E in keyof On<C, S>]: [Name] extends [Referenced<On<C, S>[E], F>]
      ? `${S}.${Extract<E, string>}`
      : never;
  }[keyof On<C, S>];
}[StateName<C>];

/**
 * `"review.FAIL"` → `[state: ReviewState, msg: FailMsg, at: "review.FAIL"]`.
 * Distributes over N sites, so a multi-site name yields a UNION OF TUPLES.
 *
 * The third element is the correlator. A union of tuples does not, on its own,
 * keep `state` and `msg` in step: narrowing `state.type` is a NESTED
 * discriminant, and TypeScript's dependent-parameter control-flow analysis
 * (TS 4.6, microsoft/TypeScript#47109) only re-narrows sibling parameters from
 * a discriminant that is a DIRECT, literal-typed element of the union. `at` is
 * exactly that: one `switch (at)` collapses the tuple union to a single member,
 * and `state` AND `msg` both narrow with it.
 *
 * For a single-site name `K` is not a union, so this is a lone tuple and the
 * author may keep writing `(s, m) => …`.
 */
type SiteArgs<K, S, M> = K extends `${infer From}.${infer Ev}`
  ? [state: Narrow<S, From>, msg: Narrow<M, Ev>, at: K]
  : never;

/**
 * THE POINT. A guard's parameters come from the edges that REFERENCE it, not
 * from a standalone registry declaration — so `retriesRemaining`, used only at
 * `review.FAIL`, receives exactly `review`'s state and `FAIL`'s msg.
 */
export type Guards<C, S extends { type: string }, M extends { type: string }> = {
  [N in GuardName<C>]: (...args: SiteArgs<SitesWhere<C, "when", N>, S, M>) => boolean;
};

/**
 * Same technique: a cmd's parameters come from the edges that REFERENCE it, and
 * the payload it owes is the one DECLARED in the chart's `cmds` section — the
 * single site where the effect alphabet lives. A cmd fired from two edges gets
 * the union of both sites' `[state, msg]` tuples.
 */
export type Cmds<C, S extends { type: string }, M extends { type: string }> = {
  // keyed by the cmds edges FIRE, not by every cmd declared. A cmd only ever
  // emitted from inside a cell needs no builder — the cell built the payload
  // when it built the cmd — but its name still belongs in the `cmds` section,
  // because that section is where the Cmd union comes from.
  [N in UsedCmdName<C>]: (
    ...args: SiteArgs<SitesWhere<C, "cmd", N>, S, M>
  ) => Payload<CmdMap<C>[N]>;
};

/**
 * THE ESCAPE HATCH's parts bag. Same shape and the same `SitesWhere`/`SiteArgs`
 * narrowing as `guards` and `cmds` — a cell used at one site gets exactly that
 * site's state and msg, a cell used at N sites gets the union of N tuples plus
 * the `at` correlator to discriminate on.
 *
 * What is different is the RETURN: a cell returns the transition itself,
 * `[nextState, cmds]`, clamped to the states the edge DECLARED in `to`. That
 * clamp is the whole bargain — code may decide, but only among the targets the
 * chart admits, so the chart stays a truthful drawing of the machine.
 */
export type Cells<C, S extends { type: string }, M extends { type: string }> = {
  [N in CellName<C>]: (
    ...args: SiteArgs<SitesWhere<C, "cell", N>, S, M>
  ) => readonly [CellTarget<C, SitesWhere<C, "cell", N>, S>, readonly CmdOf<C>[]];
};

/** The `to` union of every site `N` is used at, resolved to real State members. */
type CellTarget<C, Sites, S> = Sites extends `${infer From}.${infer Ev}`
  ? Narrow<S, ToOf<EdgeAt<C, From, Ev>>>
  : never;

// ── 11. identity assertion helpers ─────────────────────────────────────────
export type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <
  T,
>() => T extends B ? 1 : 2
  ? true
  : false;
export type Assert<T extends true> = T;
