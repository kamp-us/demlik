// ═══════════════════════════════════════════════════════════════════════════
// IDENTITY ASSERTIONS — each one fails to compile if the derivation is wrong.
// `Eq<A,B>` is the invariant-position trick, so `any`/`never` do NOT slip past.
// ═══════════════════════════════════════════════════════════════════════════
import type { SyncReturn, Transitions } from "../pure/core";
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
    [state: Extract<LaneState, { type: "review" }>, msg: Extract<LaneMsg, { type: "FAIL" }>]
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
  Eq<Parameters<UCmds["put_object"]>, [state: U<"idle">, msg: UM<"pick">]>
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
    [state: U<"sending">, msg: UM<"done">] | [state: U<"sending">, msg: UM<"fail">]
  >
>;
// an `otherwiseCmd`-only builder is narrowed to its (single) site all the same
export type A31 = Assert<
  Eq<Parameters<UCmds["alert_human"]>, [state: U<"sending">, msg: UM<"fail">]>
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
