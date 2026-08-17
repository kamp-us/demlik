// ═══════════════════════════════════════════════════════════════════════════
// IDENTITY ASSERTIONS — each one fails to compile if the derivation is wrong.
// `Eq<A,B>` is the invariant-position trick, so `any`/`never` do NOT slip past.
// ═══════════════════════════════════════════════════════════════════════════
import type {
  Poller,
  PollerDone,
  PollerGaveUp,
  PollerPolling,
  PollerState,
} from "../poller";
import type { Cmd, Reducer, SyncReturn, Transitions } from "../pure/core";
import type {
  issue42,
  LaneCmd,
  LaneG,
  LaneMsg,
  LaneMsgIn,
  LaneState,
  region,
} from "./__fixtures__/lane";
import type { FG, FMsg, FState } from "./__fixtures__/resilient-fetch-chart";
import type {
  RFG,
  RFMsg,
  RFState,
} from "./__fixtures__/resilient-fetch-reducer";
import type {
  JobStatus,
  PollerG,
  PollMsg,
  PollState,
} from "./__fixtures__/status-poller-chart";
import type {
  UCmd,
  UG,
  UMsg,
  UState,
  uploader,
  uploadMachine,
} from "./__fixtures__/upload";
import { compile, compileReducer } from "./compile";
import {
  type Assert,
  type Assigns,
  type CellEdgeKey,
  type CellName,
  type Cells,
  type CmdName,
  type CmdOf,
  type Cmds,
  defineChart,
  defineReducerChart,
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
  type MsgIn,
  type MsgOf,
  type ParkingState,
  type RAssigns,
  type RCellEvent,
  type RCellName,
  type RCells,
  type ResumeTargets,
  type RGuardName,
  type RGuards,
  type RStateName,
  type RStateOf,
  type RUsedCmdName,
  type StateName,
  type StateOf,
  ty,
  type UsedCmdName,
} from "./graph";

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
  Eq<
    EventName<LaneG>,
    "WIP" | "BLOCKED" | "DONE" | "PASS" | "FAIL" | "UNBLOCKED"
  >
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
export type A8 = Assert<
  Eq<ParkingState<LaneG>, "blocked" | "human:cp-approval">
>;
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
  Eq<
    "was" extends keyof Extract<LaneState, { type: "build" }> ? true : false,
    false
  >
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
  Eq<
    ReturnType<typeof region<"PR_99">>,
    Transitions<LaneState, LaneMsgIn<"PR_99">, LaneCmd>
  >
>;
export type A16 = Assert<
  Eq<LaneMsgIn<"A">["type"] & LaneMsgIn<"B">["type"], never>
>;

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
  Eq<typeof uploader, Transitions<UState, MsgIn<UG, "up">, UCmd>>
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
  Eq<
    ReturnType<UCmds["verify_object"]>,
    { readonly key: string; readonly etag: string }
  >
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
export type A37 = Assert<
  Eq<InitialData<UG, UState>, { readonly tries: number }>
>;
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
    only: {
      a: { initial: true, on: { go: "b" } },
      b: { initial: true, end: true },
    },
  },
});
export type A39 = Assert<
  Eq<
    InitialData<typeof twoEntries, StateOf<typeof twoEntries>>,
    { readonly __chartDeclaresManyInitialStates: "a" | "b" }
  >
>;
// the derived `init` is exactly `Machine["init"]`'s shape, rehydrate included
export type A40 = Assert<
  Eq<Parameters<typeof uploadMachine.init>[0], UState | null>
>;

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
        on: {
          TIMEOUT: {
            target: "fetching",
            when: "worthRetrying",
            otherwise: "dead",
          },
        },
      },
      parsing: {
        data: ty<{ readonly attempt: number; readonly bytes: number }>(),
        on: {
          CORRUPT: {
            target: "fetching",
            when: "worthRetrying",
            otherwise: "dead",
          },
        },
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

export const retrier = compile(
  retry,
  {
    assign: {
      "fetching.TIMEOUT": {
        // biome-ignore lint/suspicious/noThenProperty: the chart's guarded-assign shape is `{ then, else }` — the two arms of one edge's guard, never a thenable
        then: (s) => ({ attempt: s.attempt + 1, url: s.url }),
        else: (s) => ({ attempt: s.attempt }),
      },
      "parsing.CORRUPT": {
        // biome-ignore lint/suspicious/noThenProperty: the chart's guarded-assign shape is `{ then, else }` — the two arms of one edge's guard, never a thenable
        then: (s) => ({ attempt: s.attempt + 1, url: "refetch" }),
        else: (s) => ({ attempt: s.attempt }),
      },
    },
    guards: rGuards,
  },
  "r",
);

// ═══ §10 THE ESCAPE HATCH — `{ to, cell }` ═════════════════════════════════
// A chart whose ONE cell is reached from TWO sites with DIFFERENT msgs and
// DIFFERENT `to` sets. Everything the hatch claims is asserted off this shape:
// the cell's params come from its use sites (same `SitesWhere`/`SiteArgs` the
// guards use, not a second mechanism), its RETURN is clamped to each site's
// declared `to`, and the pair still counts as handled for totality.
export const picker = defineChart({
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

// a MULTI-SITE cell may be written in either form, so its type is a two-member
// union: the one-body FUNCTION form, and the exact PER-SITE form.
type DecideForm = Cells<PG, PState, PMsg>["decide"];
type Decide = Extract<DecideForm, (...args: never[]) => unknown>;
type DecideBySite = Exclude<DecideForm, (...args: never[]) => unknown>;

// THE POINT (params): two sites → a union of tuples with the `at` correlator,
// identical in construction to a two-site guard's.
export type A61 = Assert<
  Eq<
    Parameters<Decide>,
    | [state: P<"a">, msg: PM<"X">, at: "a.X"]
    | [state: P<"b">, msg: PM<"Y">, at: "b.Y"]
  >
>;
// THE POINT (return), function form: the states the edges DECLARED, and nothing
// else — but the UNION of both sites' `to`, not each site's own. This is the
// residual looseness: `a.X` declares only `["a","b"]`, yet a `c` returned from
// inside the `at === "a.X"` branch type-checks, because one rest signature over
// a union of tuples has no dependent return in TS 5.7. `CellTargetError` closes
// it at runtime; `A81`/`A82` close it at compile time for authors who want it.
export type A62 = Assert<
  Eq<
    ReturnType<Decide>,
    readonly [P<"a"> | P<"b"> | P<"c">, readonly CmdOf<PG>[]]
  >
>;

// ── the PER-SITE form: exact in BOTH directions, one entry per use site ─────
export type A81 = Assert<Eq<keyof DecideBySite, "a.X" | "b.Y">>;
// `a.X` declares `to: ["a","b"]` — so `c` is not in ITS return, only in `b.Y`'s.
export type A82 = Assert<
  Eq<
    ReturnType<DecideBySite["a.X"]>,
    readonly [P<"a"> | P<"b">, readonly CmdOf<PG>[]]
  >
>;
export type A83 = Assert<
  Eq<
    ReturnType<DecideBySite["b.Y"]>,
    readonly [P<"a"> | P<"c">, readonly CmdOf<PG>[]]
  >
>;
// each entry's parameters are that ONE site's lone tuple — no union to
// discriminate, because the key already said which site this is.
export type A84 = Assert<
  Eq<Parameters<DecideBySite["a.X"]>, [state: P<"a">, msg: PM<"X">, at: "a.X"]>
>;

// A SINGLE-SITE cell is offered NO second form: it is already exact in both
// directions, so its type is a lone function, byte-for-byte what it always was.
// `retryNow` in the resilient-fetch chart is reached from exactly one edge…
type FCells = Cells<FG, FState, FMsg>;
export type A85 = Assert<
  Eq<Exclude<FCells["retryNow"], (...args: never[]) => unknown>, never>
>;
export type A86 = Assert<
  Eq<
    Parameters<FCells["retryNow"]>,
    [
      state: Extract<FState, { type: "waiting_retry" }>,
      msg: Extract<FMsg, { type: "deadline_exceeded" }>,
      at: "waiting_retry.deadline_exceeded",
    ]
  >
>;
// …while `onErr` is reached from six, so IT gets the per-site form offered.
export type A87 = Assert<
  Eq<
    keyof Exclude<FCells["onErr"], (...args: never[]) => unknown>,
    | "idle.fetch_err"
    | "fetching.fetch_err"
    | "waiting_retry.fetch_err"
    | "circuit_open.fetch_err"
    | "failed.fetch_err"
    | "succeeded.fetch_err"
  >
>;

// …and the per-site form really does compile, and really is exact.
export const pCellsBySite: Cells<PG, PState, PMsg> = {
  decide: {
    "a.X": (s, m) => [{ ...s, type: m.lo > 0 ? "b" : "a" }, []],
    "b.Y": (s, m) => [
      { ...s, type: m.hi === "" ? "a" : "c" },
      [{ type: "beep", n: s.n }],
    ],
  },
};
export const pickedBySite = compile<PG, PState, PMsg, CmdOf<PG>, "q">(
  picker,
  { assign: {}, cells: pCellsBySite },
  "q",
);

// ═══ §11 `to` IS BOUNDED BY THE DELEGATE'S RETURN TYPE ═════════════════════
// The chart cannot declare a fan-out narrower than the code it delegates to can
// prove. When every `@demlik/tea/poller` verb returned the whole `PollerState`
// union, `slice.phase` was the whole union at every site and all four poller
// edges had to say `["polling","done","gave_up"]` — honest, but a drawing of 30
// edges where 16 are reachable. The fix is not on the chart's side: it is the
// verbs declaring the phases they actually reach. These assertions pin that
// down, so re-widening a verb's return type turns THIS red rather than silently
// re-widening the picture.
declare const pollVerbs: Poller<unknown, JobStatus>;
type PollCells = Cells<PollerG, PollState, PollMsg>;
/** The function form of a cell entry — see `A61`/`A81` for why it is a union. */
type FnForm<T> = Extract<T, (...args: never[]) => unknown>;

export type A88 = Assert<
  Eq<ReturnType<typeof pollVerbs.start>[0], PollerPolling<JobStatus>>
>;
// `tickResult` never builds `gave_up`…
export type A89 = Assert<
  Eq<
    ReturnType<typeof pollVerbs.tickResult>[0],
    PollerPolling<JobStatus> | PollerDone<JobStatus>
  >
>;
// …and `tickErr` never builds `done`.
export type A90 = Assert<
  Eq<
    ReturnType<typeof pollVerbs.tickErr>[0],
    PollerPolling<JobStatus> | PollerGaveUp<JobStatus>
  >
>;
// `tick` is deliberately NOT generic. A `tick<S extends PollerState<R>>(s: S)
// => [S, …]` states an identity no non-generic implementation can satisfy, so
// it made the whole `Poller` interface unimplementable by a consumer's
// hand-written or mocked poller (TS2322: "'S' could be instantiated with a
// different subtype"). The verb's real narrowness is recovered at the call
// site instead — the cell narrows the slice itself and carries THAT forward,
// which `A95` pins.
export type A91 = Assert<
  Eq<ReturnType<typeof pollVerbs.tick>[0], PollerState<JobStatus>>
>;
// and the fan-out the chart now declares is the narrow one, per edge.
export type A92 = Assert<
  Eq<
    ReturnType<FnForm<PollCells["start"]>>[0],
    Extract<PollState, { type: "polling" }>
  >
>;
export type A93 = Assert<
  Eq<
    ReturnType<FnForm<PollCells["onResult"]>>[0],
    Extract<PollState, { type: "polling" | "done" }>
  >
>;
export type A94 = Assert<
  Eq<
    ReturnType<FnForm<PollCells["onError"]>>[0],
    Extract<PollState, { type: "polling" | "gave_up" }>
  >
>;
export type A95 = Assert<
  Eq<ReturnType<PollCells["tick"]>[0], Extract<PollState, { type: "polling" }>>
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
        return [
          { ...s, type: m.hi === "" ? "a" : "c" },
          [{ type: "beep", n: s.n }],
        ];
    }
  },
};

export const picked = compile(
  picker,
  {
    assign: {},
    cells: pCells,
  },
  "p",
);
export type A66 = Assert<
  Eq<typeof picked, Transitions<PState, MsgIn<PG, "p">, CmdOf<PG>>>
>;

// ═══ §11 REDUCER FORM — the chart minus the state grouping ═════════════════
// One chart with every edge kind the form admits: a plain target, a guarded
// pair, and a cell used at TWO sites with DIFFERENT `to` sets. Every claim
// about the form is asserted off it, and each assertion below names the grid-
// form derivation it mirrors — because it IS that derivation, one loop up.
const flat = defineReducerChart({
  ctx: ty<{ readonly n: number }>(),
  states: ["a", "b", "c"],
  initial: "a",
  cmds: {
    beep: ty<{ readonly n: number }>(),
    boop: ty<{ readonly n: number }>(),
  },
  events: {
    X: { data: ty<{ readonly lo: number }>() },
    Y: { data: ty<{ readonly hi: string }>() },
    Z: { data: ty<{ readonly on: boolean }>() },
    // a library's Msg — not ours to decorate, exactly as in the grid form.
    deadline_exceeded: { data: ty<{ readonly atMs: number }>(), foreign: true },
  },
  on: {
    X: { to: ["a", "b"], cell: "decide" },
    Y: { to: ["a", "c"], cell: "decide" },
    Z: { target: "c", when: "isOn", otherwise: "a", cmd: "beep" },
    deadline_exceeded: "a",
  },
});
export type FG2 = typeof flat;
export type FState2 = RStateOf<FG2>;
export type FMsg2 = MsgOf<FG2>;
type FM<K extends string> = Extract<FMsg2, { type: K }>;

// THE SHAPE. `StateOf` collapses from a union of members to ONE object whose
// `type` is a union of literals — which is the original's
// `interface State { phase: Phase; … }`, derived instead of hand-written.
export type A67 = Assert<
  Eq<FState2, { readonly type: "a" | "b" | "c" } & { readonly n: number }>
>;
// the alphabets are DERIVED off `on`, exactly as the grid form's are off the
// nested `on`s — one reference site each, no declaration.
export type A68 = Assert<Eq<RStateName<FG2>, "a" | "b" | "c">>;
export type A69 = Assert<Eq<RCellName<FG2>, "decide">>;
export type A70 = Assert<Eq<RGuardName<FG2>, "isOn">>;
export type A71 = Assert<Eq<RCellEvent<FG2>, "X" | "Y">>;
// a cmd only a CELL could emit owes no builder; one an EDGE fires does.
export type A72 = Assert<Eq<CmdName<FG2>, "beep" | "boop">>;
export type A73 = Assert<Eq<RUsedCmdName<FG2>, "beep">>;
// `assign` is keyed by the DECLARATIVE events only — cell events own their
// whole transition, so a builder for one is not merely optional, it is not a
// key of the bag at all (the grid form's `Exclude<EdgeKey, CellEdgeKey>`).
export type A74 = Assert<
  Eq<keyof RAssigns<FG2, FState2, FMsg2>, "Z" | "deadline_exceeded">
>;

type Decide2Form = RCells<FG2, FState2, FMsg2>["decide"];
type Decide2 = Extract<Decide2Form, (...args: never[]) => unknown>;
type Decide2BySite = Exclude<Decide2Form, (...args: never[]) => unknown>;
// THE POINT (params): two sites → a union of tuples with the `at` correlator,
// identical in construction to the grid form's — except the STATE is not
// narrowed, because in this form there is nothing to narrow it to.
export type A75 = Assert<
  Eq<
    Parameters<Decide2>,
    | [state: FState2, msg: FM<"X">, at: "X"]
    | [state: FState2, msg: FM<"Y">, at: "Y"]
  >
>;
// THE POINT (return): the tag is clamped to the union of both sites' `to`, and
// nothing else about the state is.
export type A76 = Assert<
  Eq<
    ReturnType<Decide2>,
    readonly [
      (
        | ({ readonly type: "a" | "b" } & { readonly n: number })
        | ({ readonly type: "a" | "c" } & { readonly n: number })
      ),
      readonly CmdOf<FG2>[],
    ]
  >
>;
// …and the reducer form gets the PER-SITE dial too, on the same condition and
// for the same reason (`A81`–`A84`): the phase dimension is the only thing that
// went away, so a multi-site cell here is offered one entry per EVENT, each
// clamped to that event's own `to`.
export type A96 = Assert<Eq<keyof Decide2BySite, "X" | "Y">>;
export type A97 = Assert<
  Eq<
    ReturnType<Decide2BySite["X"]>,
    readonly [
      { readonly type: "a" | "b" } & { readonly n: number },
      readonly CmdOf<FG2>[],
    ]
  >
>;
export type A98 = Assert<
  Eq<
    ReturnType<Decide2BySite["Y"]>,
    readonly [
      { readonly type: "a" | "c" } & { readonly n: number },
      readonly CmdOf<FG2>[],
    ]
  >
>;
export type A99 = Assert<
  Eq<Parameters<Decide2BySite["X"]>, [state: FState2, msg: FM<"X">, at: "X"]>
>;
// …and a SINGLE-site reducer cell is offered no second form, exactly as in the
// grid form: it is already exact in both directions, so the common case cannot
// regress. `attempt` in the reducer-form fetch chart is reached from one event.
export type A100 = Assert<
  Eq<
    Exclude<
      RCells<RFG, RFState, RFMsg>["attempt"],
      (...args: never[]) => unknown
    >,
    never
  >
>;

/** The per-site bag really compiles, and really is routed per event. */
export const flatCellsBySite: RCells<FG2, FState2, FMsg2> = {
  decide: {
    X: (s, m) => [{ ...s, type: m.lo > 0 ? "b" : "a" }, []],
    Y: (s, m) => [
      { ...s, type: m.hi === "" ? "a" : "c" },
      [{ type: "boop", n: s.n }],
    ],
  },
};

// a guard's params come from its use site, same as ever.
export type A77 = Assert<
  Eq<
    Parameters<RGuards<FG2, FState2, FMsg2>["isOn"]>,
    [state: FState2, msg: FM<"Z">, at: "Z"]
  >
>;

export const flatCells: RCells<FG2, FState2, FMsg2> = {
  decide: (s, m, at) => {
    switch (at) {
      case "X":
        return [{ ...s, type: m.lo > 0 ? "b" : "a" }, []];
      case "Y":
        return [
          { ...s, type: m.hi === "" ? "a" : "c" },
          [{ type: "boop", n: s.n }],
        ];
    }
  },
};

export const flatUpdate = compileReducer(
  flat,
  {
    assign: {
      // biome-ignore lint/suspicious/noThenProperty: the chart's guarded-assign shape is `{ then, else }` — the two arms of one edge's guard, never a thenable
      Z: { then: (s) => ({ n: s.n + 1 }), else: (s) => ({ n: s.n }) },
      deadline_exceeded: (s) => ({ n: s.n }),
    },
    guards: { isOn: (_s, m) => m.on },
    cmds: { beep: (s) => ({ n: s.n }) },
    cells: flatCells,
  },
  "f",
);
// THE OUTPUT IS A REAL `Reducer` — flat, msg-keyed, namespaced per-event with
// the foreign name kept bare. Not a `Transitions` with one row.
export type A78 = Assert<
  Eq<typeof flatUpdate, Reducer<FState2, MsgIn<FG2, "f">, CmdOf<FG2>>>
>;
export type A79 = Assert<
  Eq<keyof typeof flatUpdate, "f.X" | "f.Y" | "f.Z" | "deadline_exceeded">
>;
// un-namespaced, the keys are bare — the single-instance call, no dummy string.
export type A80 = Assert<
  Eq<
    keyof Reducer<FState2, MsgIn<FG2>, CmdOf<FG2>>,
    "X" | "Y" | "Z" | "deadline_exceeded"
  >
>;
