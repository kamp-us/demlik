// ═══════════════════════════════════════════════════════════════════════════
// IDENTITY ASSERTIONS — each one fails to compile if the derivation is wrong.
// `Eq<A,B>` is the invariant-position trick, so `any`/`never` do NOT slip past.
// ═══════════════════════════════════════════════════════════════════════════
import type { Cmd, SyncReturn, Transitions } from "../pure/core";
import { compile } from "./compile";
import {
  type Assert,
  type Assigns,
  type CmdName,
  type Cmds,
  type EdgeKey,
  type Eq,
  type EventName,
  type GuardName,
  type Guards,
  type InitialData,
  type InitialState,
  type MsgOf,
  type Namespaced,
  type ParkingState,
  type ResumeTargets,
  type StateName,
  type StateOf,
  defineGraph,
} from "./graph";
import {
  type BlockedWas,
  type CpWas,
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
type UCmds = Cmds<UG, UState, UMsg, UCmd>;

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
// the parking state's payload really does carry `was`
export type A12 = Assert<
  Eq<
    Extract<LaneState, { type: "blocked" }>["was"],
    "queued" | "build" | "review"
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
export type A24 = Assert<
  Eq<keyof typeof issue42, StateName<LaneG>>
>;
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
// through `otherwiseCmd`.
export type A29 = Assert<
  Eq<CmdName<UG>, "put_object" | "verify_object" | "log" | "alert_human">
>;
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
// the payload owed is the Cmd variant MINUS `type` — the compiler stamps it
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

// ═══ §8 `init`, DERIVED from the graph ══════════════════════════════════════
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
// a graph with NO entry marked gets a NAMED marker, not a silent `never`
const noEntry = defineGraph({ a: { on: { go: "b" } }, b: {} });
export type A38 = Assert<
  Eq<
    InitialData<typeof noEntry, StateOf<typeof noEntry, { a: object; b: object }>>,
    { readonly __graphDeclaresNoInitialState: true }
  >
>;
// …and so does a graph with TWO
const twoEntries = defineGraph({
  a: { initial: true, on: { go: "b" } },
  b: { initial: true },
});
export type A39 = Assert<
  Eq<
    InitialData<
      typeof twoEntries,
      StateOf<typeof twoEntries, { a: object; b: object }>
    >,
    { readonly __graphDeclaresManyInitialStates: "a" | "b" }
  >
>;
// the derived `init` is exactly `Machine["init"]`'s shape, rehydrate included
export type A40 = Assert<
  Eq<Parameters<typeof uploadMachine.init>[0], UState | null>
>;

// ═══ §9 a third graph: ONE guard referenced from TWO sites ═════════════════════
// The single-site case above is exact by construction. The multi-site case is
// the one that needs the `at` correlator: `SiteArgs` distributes, so the guard's
// parameters are a UNION OF TUPLES, and narrowing `s.type` is a NESTED
// discriminant that TypeScript will not propagate to the sibling `m`.
const retry = defineGraph({
  fetching: {
    on: { TIMEOUT: { target: "fetching", when: "worthRetrying", otherwise: "dead" } },
  },
  parsing: {
    on: { CORRUPT: { target: "fetching", when: "worthRetrying", otherwise: "dead" } },
  },
  dead: {},
});
export type RG = typeof retry;
export type RState = StateOf<
  RG,
  {
    fetching: { readonly attempt: number; readonly url: string };
    parsing: { readonly attempt: number; readonly bytes: number };
    dead: { readonly attempt: number };
  }
>;
export type RMsg = MsgOf<
  RG,
  {
    TIMEOUT: { readonly afterMs: number };
    CORRUPT: { readonly offset: number };
  }
>;

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
  unhandled: "ignore",
});

