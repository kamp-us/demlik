// ═══════════════════════════════════════════════════════════════════════════
// IDENTITY ASSERTIONS — each one fails to compile if the derivation is wrong.
// `Eq<A,B>` is the invariant-position trick, so `any`/`never` do NOT slip past.
// ═══════════════════════════════════════════════════════════════════════════
import type { Cmd, SyncReturn, Transitions } from "../pure/core";
import { compile } from "./compile";
import {
  type Assert,
  type Assigns,
  type CellEdgeKey,
  type CellName,
  type Cells,
  type CmdName,
  type CmdOf,
  type Cmds,
  type EdgeKey,
  type Eq,
  type EventName,
  type GroupName,
  type GroupOf,
  type GuardName,
  type Guards,
  type InitialData,
  type InitialState,
  type MissingAt,
  type MissingPairs,
  type MsgOf,
  type Namespaced,
  type ParkingState,
  type ResumeTargets,
  type StateName,
  type StateOf,
  type UsedCmdName,
  defineChart,
  ty,
} from "./graph";
import {
  type LaneCmd,
  type LaneG,
  type LaneMsg,
  type LaneMsgIn,
  type LaneState,
  issue42,
  region,
} from "./lane";
import {
  type UCmd,
  type UG,
  type UMsg,
  type UState,
  uCmds,
  uploadMachine,
  uploader,
} from "./upload";

/** Local narrowing shorthands for the upload demo's unions. */
type U<K extends string> = Extract<UState, { type: K }>;
type UM<K extends string> = Extract<UMsg, { type: K }>;
type UCmds = Cmds<UG, UState, UMsg>;

/** Where a `blocked` resume can land — DERIVED, not written by hand. */
export type BlockedWas = ResumeTargets<LaneG, "blocked">;
export type CpWas = ResumeTargets<LaneG, "human:cp-approval">;

// ── §2 derivations ──────────────────────────────────────────────────────────
export type A1 = Assert<
  Eq<
    StateName<LaneG>,
    | "queued"
    | "build"
    | "review"
    | "ship"
    | "blocked"
    | "human:cp-approval"
    | "shipped"
    | "frozen"
  >
>;

export type A2 = Assert<
  Eq<EventName<LaneG>, "WIP" | "BLOCKED" | "DONE" | "PASS" | "FAIL" | "UNBLOCKED">
>;

// the phases are declared by BEING keys of `states` — no separate registry.
export type A2a = Assert<Eq<GroupName<LaneG>, "working" | "parked" | "done">>;
export type A2b = Assert<Eq<GroupOf<LaneG, "review">, "working">>;
export type A2c = Assert<Eq<GroupOf<LaneG, "human:cp-approval">, "parked">>;

// only the DECLARED pairs — not the 8×6 = 48 cross product, but the 11 edges.
export type A3 = Assert<
  Eq<
    EdgeKey<LaneG>,
    | "queued.WIP"
    | "queued.BLOCKED"
    | "build.DONE"
    | "build.BLOCKED"
    | "review.PASS"
    | "review.BLOCKED"
    | "review.FAIL"
    | "ship.DONE"
    | "ship.BLOCKED"
    | "blocked.UNBLOCKED"
    | "human:cp-approval.UNBLOCKED"
  >
>;

export type A4 = Assert<Eq<GuardName<LaneG>, "retriesRemaining">>;
export type A5 = Assert<Eq<CmdName<LaneG>, never>>;
// no `cmds` section → the Cmd union is the empty one, derived not written.
export type A5a = Assert<Eq<LaneCmd, Cmd<never>>>;

// ── §2b TOTALITY: every pair declared-or-refused ───────────────────────────
// The real lane chart is total — nothing falls through.
export type A43 = Assert<Eq<MissingPairs<LaneG>, never>>;
// row by row: declared ∪ out-of-scope ∪ end covers all six events, per state.
export type A44 = Assert<Eq<MissingAt<LaneG, "review">, never>>;
export type A45 = Assert<Eq<MissingAt<LaneG, "shipped">, never>>;

// A deliberately INCOMPLETE chart, built WITHOUT `defineChart` (which would
// refuse it) so the derivation itself can be asserted on. All three events are
// `scope: "all"` — the old machine-wide obligation, still available per event.
// `open.B` is declared, `open.A` is ignored, `open.C` is neither.
type Holey = {
  events: {
    A: { scope: "all" };
    B: { scope: "all" };
    C: { scope: "all" };
  };
  states: {
    only: {
      open: { on: { B: "shut" }; ignore: ["A"] };
      shut: { on: { A: "open"; C: "open" } };
    };
  };
};
export type A46 = Assert<Eq<EventName<Holey>, "B" | "A" | "C">>;
export type A47 = Assert<Eq<MissingAt<Holey, "open">, "C">>;
export type A48 = Assert<Eq<MissingAt<Holey, "shut">, "B">>;
export type A49 = Assert<Eq<MissingPairs<Holey>, "open.C" | "shut.B">>;

// `end: true` dismisses a whole row in one token.
type Sealed = {
  events: { X: { scope: "all" } };
  states: { only: { a: { on: { X: "b" } }; b: { end: true } } };
};
export type A50 = Assert<Eq<MissingPairs<Sealed>, never>>;
// …and dropping the `end` re-opens exactly that pair.
type Unsealed = {
  events: { X: { scope: "all" } };
  states: { only: { a: { on: { X: "b" } }; b: Record<never, never> } };
};
export type A51 = Assert<Eq<MissingPairs<Unsealed>, "b.X">>;

// ── §2c SCOPE: the |S| × |M| enumeration, replaced by |M| declarations ─────
// The dial, asserted at each of its three settings on ONE chart shape.
type Scoped<S extends string> = {
  events: { PING: { scope: S } };
  states: {
    hot: { a: { on: { PING: "a" } }; b: Record<never, never> };
    cold: { c: Record<never, never> };
  };
};
// "edges": live exactly where routed → no obligation anywhere.
export type A52 = Assert<Eq<MissingPairs<Scoped<"edges">>, never>>;
// a phase name: every state IN that phase owes a decision, and only those.
export type A53 = Assert<Eq<MissingPairs<Scoped<"hot">>, "b.PING">>;
// "all": the old machine-wide obligation, now opt-in per event.
export type A54 = Assert<Eq<MissingPairs<Scoped<"all">>, "b.PING" | "c.PING">>;
// …and the obligation is discharged by `ignore` naming the pair, as before.
type ScopedIgnored = {
  events: { PING: { scope: "hot" } };
  states: {
    hot: { a: { on: { PING: "a" } }; b: { ignore: ["PING"] } };
    cold: { c: Record<never, never> };
  };
};
export type A55 = Assert<Eq<MissingPairs<ScopedIgnored>, never>>;

// ── §3 discriminated unions ────────────────────────────────────────────────
export type A6 = Assert<
  Eq<
    Extract<LaneState, { type: "review" }>,
    { readonly type: "review" } & {
      readonly retries: number;
      readonly maxRetries: number;
    }
  >
>;
export type A7 = Assert<
  Eq<
    Extract<LaneMsg, { type: "FAIL" }>,
    { readonly type: "FAIL" } & { readonly at: number; readonly reason: string }
  >
>;

// ── §5 the resume derivation ───────────────────────────────────────────────
export type A8 = Assert<Eq<ParkingState<LaneG>, "blocked" | "human:cp-approval">>;
// states with an edge INTO `blocked`, plus the declared fallback `queued`
export type A9 = Assert<Eq<BlockedWas, "queued" | "build" | "review">>;
// only `ship` blocks into cp-approval; `queued` is the fallback
export type A10 = Assert<Eq<CpWas, "ship" | "queued">>;
export type A11 = Assert<
  Eq<ResumeTargets<LaneG, "blocked">, "queued" | "build" | "review">
>;
// the parking state's payload really does carry `was` — INJECTED by `StateOf`,
// never written in the author's file: "blocked is a parking state" is already
// said by its resume edge.
export type A12 = Assert<
  Eq<
    Extract<LaneState, { type: "blocked" }>["was"],
    "queued" | "build" | "review"
  >
>;
// …and a NON-parking state has no `was` at all.
export type A12a = Assert<
  Eq<"was" extends keyof Extract<LaneState, { type: "build" }> ? true : false, false>
>;

// ── §6 namespace-as-type-parameter: a LITERAL union, never `string` ────────
export type A13 = Assert<
  Eq<
    LaneMsgIn<"ISSUE_42">["type"],
    | "ISSUE_42.WIP"
    | "ISSUE_42.BLOCKED"
    | "ISSUE_42.DONE"
    | "ISSUE_42.PASS"
    | "ISSUE_42.FAIL"
    | "ISSUE_42.UNBLOCKED"
  >
>;
// and the emitted TABLE is keyed by them
export type A14 = Assert<
  Eq<
    keyof (typeof issue42)["review"],
    | "ISSUE_42.WIP"
    | "ISSUE_42.BLOCKED"
    | "ISSUE_42.DONE"
    | "ISSUE_42.PASS"
    | "ISSUE_42.FAIL"
    | "ISSUE_42.UNBLOCKED"
  >
>;
// a DIFFERENT namespace is a different literal union — not collapsed
export type A15 = Assert<
  Eq<ReturnType<typeof region<"PR_99">>, Transitions<LaneState, LaneMsgIn<"PR_99">, LaneCmd>>
>;
export type A16 = Assert<Eq<LaneMsgIn<"A">["type"] & LaneMsgIn<"B">["type"], never>>;

// ── §4 guard parameters DERIVED FROM USE SITES (the xstate#4686 gap) ───────
type RetriesGuard = Guards<LaneG, LaneState, LaneMsg>["retriesRemaining"];
export type A17 = Assert<
  Eq<
    Parameters<RetriesGuard>,
    [
      state: Extract<LaneState, { type: "review" }>,
      msg: Extract<LaneMsg, { type: "FAIL" }>,
      at: "review.FAIL",
    ]
  >
>;
// the guarded edge's assign is a `{ then, else }` pair, each with ITS OWN
// target payload — `then` → build (no `was`), `else` → frozen.
type FailCell = Assigns<LaneG, LaneState, LaneMsg>["review.FAIL"];
export type A18 = Assert<
  Eq<
    ReturnType<FailCell["then"]>,
    { readonly retries: number; readonly maxRetries: number }
  >
>;
export type A19 = Assert<Eq<FailCell["then"], FailCell["else"]>>;
// an UNGUARDED edge into a parking state: `was` is STRIPPED from the return.
type QueuedBlocked = Assigns<LaneG, LaneState, LaneMsg>["queued.BLOCKED"];
export type A20 = Assert<
  Eq<
    ReturnType<QueuedBlocked>,
    { readonly retries: number; readonly maxRetries: number }
  >
>;
// the resume edge's return is the INTERSECTION over all resume targets
type BlockedUnblocked = Assigns<LaneG, LaneState, LaneMsg>["blocked.UNBLOCKED"];
export type A21 = Assert<
  Eq<
    Parameters<BlockedUnblocked>,
    [
      state: Extract<LaneState, { type: "blocked" }>,
      msg: Extract<LaneMsg, { type: "UNBLOCKED" }>,
    ]
  >
>;

// ── the emitted value IS a Transitions: structural, not nominal ────────────
export type A22 = Assert<
  Eq<typeof issue42, Transitions<LaneState, LaneMsgIn<"ISSUE_42">, LaneCmd>>
>;
// and a cell really returns the reentrancy-guarded SyncReturn
export type A23 = Assert<
  Eq<
    ReturnType<(typeof issue42)["review"]["ISSUE_42.FAIL"]>,
    SyncReturn<LaneState, LaneCmd>
  >
>;
// the table is TOTAL: every state × every namespaced event, incl. terminals
export type A24 = Assert<Eq<keyof typeof issue42, StateName<LaneG>>>;
export type A25 = Assert<
  Eq<keyof (typeof issue42)["shipped"], LaneMsgIn<"ISSUE_42">["type"]>
>;

// ═══ §7 the CMD surface (the lane region emits none — see `upload.ts`) ═══════
export type A26 = Assert<
  Eq<
    Parameters<UCmds["put_object"]>,
    [state: U<"idle">, msg: UM<"pick">, at: "idle.pick"]
  >
>;
export type A27 = Assert<Eq<ParkingState<UG>, never>>;

export type A28 = Assert<
  Eq<typeof uploader, Transitions<UState, Namespaced<UMsg, "up">, UCmd>>
>;
// every name reachable from ANY edge, through `cmd` (scalar OR list) and
// through `otherwiseCmd` — and it agrees with the `cmds` DECLARATION, because
// the edges are constrained to reference only declared names.
export type A29 = Assert<
  Eq<CmdName<UG>, "put_object" | "verify_object" | "log" | "alert_human">
>;
// the whole Cmd union, DERIVED from the one `cmds` section — not hand-written.
export type A29a = Assert<
  Eq<
    UCmd,
    | ({ readonly type: "put_object" } & { readonly key: string })
    | ({ readonly type: "verify_object" } & {
        readonly key: string;
        readonly etag: string;
      })
    | ({ readonly type: "log" } & { readonly line: string })
    | ({ readonly type: "alert_human" } & { readonly reason: string })
  >
>;
export type A29b = Assert<Eq<UCmd, CmdOf<UG>>>;
// a builder's params are the UNION of its use sites — `log` fires from
// `sending.done` and from both arms of `sending.fail`.
export type A30 = Assert<
  Eq<
    Parameters<UCmds["log"]>,
    | [state: U<"sending">, msg: UM<"done">, at: "sending.done"]
    | [state: U<"sending">, msg: UM<"fail">, at: "sending.fail"]
  >
>;
// an `otherwiseCmd`-only builder is narrowed to its (single) site all the same
export type A31 = Assert<
  Eq<
    Parameters<UCmds["alert_human"]>,
    [state: U<"sending">, msg: UM<"fail">, at: "sending.fail"]
  >
>;
// the payload owed is exactly what the `cmds` section declared
export type A32 = Assert<
  Eq<ReturnType<UCmds["verify_object"]>, { readonly key: string; readonly etag: string }>
>;
// and the emitted cell genuinely returns `[nextState, cmds]` as a SyncReturn
export type A33 = Assert<
  Eq<
    ReturnType<(typeof uploader)["sending"]["up.done"]>,
    SyncReturn<UState, UCmd>
  >
>;

// ═══ §8 `init`, DERIVED from the chart ══════════════════════════════════════
export type A34 = Assert<Eq<InitialState<LaneG>, "queued">>;
export type A35 = Assert<Eq<InitialState<UG>, "idle">>;
// `boot()` owes EXACTLY the entry state's data — no `type`, nothing else
export type A36 = Assert<
  Eq<
    InitialData<LaneG, LaneState>,
    { readonly retries: number; readonly maxRetries: number }
  >
>;
export type A37 = Assert<Eq<InitialData<UG, UState>, { readonly tries: number }>>;
// a chart with NO entry marked gets a NAMED marker, not a silent `never`
const noEntry = defineChart({
  events: { go: { scope: "edges" } },
  states: { only: { a: { on: { go: "b" } }, b: { end: true } } },
});
export type A38 = Assert<
  Eq<
    InitialData<typeof noEntry, StateOf<typeof noEntry>>,
    { readonly __chartDeclaresNoInitialState: true }
  >
>;
// …and so does a chart with TWO
const twoEntries = defineChart({
  events: { go: { scope: "edges" } },
  states: {
    only: { a: { initial: true, on: { go: "b" } }, b: { initial: true, end: true } },
  },
});
export type A39 = Assert<
  Eq<
    InitialData<typeof twoEntries, StateOf<typeof twoEntries>>,
    { readonly __chartDeclaresManyInitialStates: "a" | "b" }
  >
>;
// the derived `init` is exactly `Machine["init"]`'s shape, rehydrate included
export type A40 = Assert<Eq<Parameters<typeof uploadMachine.init>[0], UState | null>>;

// ═══ §9 a third chart: ONE guard referenced from TWO sites ═════════════════════
// The single-site case above is exact by construction. The multi-site case is
// the one that needs the `at` correlator: `SiteArgs` distributes, so the guard's
// parameters are a UNION OF TUPLES, and narrowing `s.type` is a NESTED
// discriminant that TypeScript will not propagate to the sibling `m`.
const retry = defineChart({
  events: {
    TIMEOUT: { data: ty<{ readonly afterMs: number }>(), scope: "edges" },
    CORRUPT: { data: ty<{ readonly offset: number }>(), scope: "edges" },
  },
  states: {
    trying: {
      fetching: {
        data: ty<{ readonly attempt: number; readonly url: string }>(),
        on: { TIMEOUT: { target: "fetching", when: "worthRetrying", otherwise: "dead" } },
      },
      parsing: {
        data: ty<{ readonly attempt: number; readonly bytes: number }>(),
        on: { CORRUPT: { target: "fetching", when: "worthRetrying", otherwise: "dead" } },
      },
    },
    finished: {
      dead: { data: ty<{ readonly attempt: number }>(), end: true },
    },
  },
});
export type RG = typeof retry;
export type RState = StateOf<RG>;
export type RMsg = MsgOf<RG>;

// the guard is named from TWO edges, so `at` is a two-member literal union…
export type A41 = Assert<Eq<GuardName<RG>, "worthRetrying">>;
type RetryGuard = Guards<RG, RState, RMsg>["worthRetrying"];
export type A42 = Assert<
  Eq<
    Parameters<RetryGuard>,
    | [
        state: Extract<RState, { type: "fetching" }>,
        msg: Extract<RMsg, { type: "TIMEOUT" }>,
        at: "fetching.TIMEOUT",
      ]
    | [
        state: Extract<RState, { type: "parsing" }>,
        msg: Extract<RMsg, { type: "CORRUPT" }>,
        at: "parsing.CORRUPT",
      ]
  >
>;

// …and THE POINT: discriminating on `at` narrows the state AND the msg together.
// Every field read below exists on exactly one site. Before the `at` correlator
// this body did not compile: `m` stayed the full union in both branches.
export const rGuards: Guards<RG, RState, RMsg> = {
  worthRetrying: (s, m, at) =>
    at === "fetching.TIMEOUT"
      ? s.attempt < 3 && s.url !== "" && m.afterMs < 30_000
      : s.attempt < 5 && s.bytes > 0 && m.offset >= 0,
};

// the "vice versa" direction: narrow to the OTHER site first, and the state
// follows the msg just as readily. A `switch` works as well as an `if`.
export const rGuardsSwitch: Guards<RG, RState, RMsg> = {
  worthRetrying: (s, m, at) => {
    switch (at) {
      case "parsing.CORRUPT":
        return m.offset < s.bytes;
      case "fetching.TIMEOUT":
        return m.afterMs < s.attempt * 1000;
    }
  },
};

export const retrier = compile<RG, RState, RMsg, Cmd<never>, "r">(retry, "r", {
  assign: {
    "fetching.TIMEOUT": {
      then: (s) => ({ attempt: s.attempt + 1, url: s.url }),
      else: (s) => ({ attempt: s.attempt }),
    },
    "parsing.CORRUPT": {
      then: (s) => ({ attempt: s.attempt + 1, url: "refetch" }),
      else: (s) => ({ attempt: s.attempt }),
    },
  },
  guards: rGuards,
});

// ═══ §10 THE ESCAPE HATCH — `{ to, cell }` ═════════════════════════════════
// A chart whose ONE cell is reached from TWO sites with DIFFERENT msgs and
// DIFFERENT `to` sets. Everything the hatch claims is asserted off this shape:
// the cell's params come from its use sites (same `SitesWhere`/`SiteArgs` the
// guards use, not a second mechanism), its RETURN is clamped to each site's
// declared `to`, and the pair still counts as handled for totality.
const picker = defineChart({
  ctx: ty<{ readonly n: number }>(),
  cmds: { beep: ty<{ readonly n: number }>() },
  events: {
    X: { data: ty<{ readonly lo: number }>(), scope: "edges" },
    Y: { data: ty<{ readonly hi: string }>(), scope: "edges" },
  },
  states: {
    open: {
      a: { initial: true, on: { X: { to: ["a", "b"], cell: "decide" } } },
      b: { on: { Y: { to: ["a", "c"], cell: "decide" } } },
    },
    shut: { c: { end: true } },
  },
});
export type PG = typeof picker;
export type PState = StateOf<PG>;
export type PMsg = MsgOf<PG>;
type P<K extends string> = Extract<PState, { type: K }>;
type PM<K extends string> = Extract<PMsg, { type: K }>;

// the cell alphabet is DERIVED from the edges that name a cell — one site or
// twenty, the name is written once as a reference and never as a declaration.
export type A56 = Assert<Eq<CellName<PG>, "decide">>;
export type A57 = Assert<Eq<CellEdgeKey<PG>, "a.X" | "b.Y">>;
// a cell edge is a real edge for every other derivation…
export type A58 = Assert<Eq<EdgeKey<PG>, "a.X" | "b.Y">>;
// …and TOTALITY counts it as handled, so the chart is total.
export type A59 = Assert<Eq<MissingPairs<PG>, never>>;
// …but it owes NO `assign`: the cell returns the whole next state, so the
// builder is not merely optional, it is not a key of the bag at all.
export type A60 = Assert<Eq<keyof Assigns<PG, PState, PMsg>, never>>;

type Decide = Cells<PG, PState, PMsg>["decide"];
// THE POINT (params): two sites → a union of tuples with the `at` correlator,
// identical in construction to a two-site guard's.
export type A61 = Assert<
  Eq<
    Parameters<Decide>,
    | [state: P<"a">, msg: PM<"X">, at: "a.X"]
    | [state: P<"b">, msg: PM<"Y">, at: "b.Y"]
  >
>;
// THE POINT (return): the states the edges DECLARED, and nothing else — the
// union of both sites' `to`, paired with the chart's own Cmd union.
export type A62 = Assert<
  Eq<ReturnType<Decide>, readonly [P<"a"> | P<"b"> | P<"c">, readonly CmdOf<PG>[]]>
>;
// `c` is reachable ONLY through a cell edge's `to`, and the derivations that
// read the graph's shape see it — the hatch does not blind them.
export type A63 = Assert<Eq<ParkingState<PG>, never>>;
// a cmd DECLARED but never named by an edge owes no builder: only a cell can
// emit it, and a cell builds its own payload.
export type A64 = Assert<Eq<CmdName<PG>, "beep">>;
export type A65 = Assert<Eq<UsedCmdName<PG>, never>>;

// …and it all actually compiles: one `switch (at)` collapses the tuple union,
// and each branch may return only ITS site's declared targets.
export const pCells: Cells<PG, PState, PMsg> = {
  decide: (s, m, at) => {
    switch (at) {
      case "a.X":
        return m.lo > 0 ? [{ ...s, type: "b" }, []] : [{ ...s, type: "a" }, []];
      case "b.Y":
        return [{ ...s, type: m.hi === "" ? "a" : "c" }, [{ type: "beep", n: s.n }]];
    }
  },
};

export const picked = compile<PG, PState, PMsg, CmdOf<PG>, "p">(picker, "p", {
  assign: {},
  cells: pCells,
});
export type A66 = Assert<
  Eq<typeof picked, Transitions<PState, Namespaced<PMsg, "p">, CmdOf<PG>>>
>;
