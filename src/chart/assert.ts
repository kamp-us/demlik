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

// ═══ a second graph, purely to exercise `cmds` (the lane region emits none) ══
const upload = defineGraph({
  idle: { on: { pick: { target: "sending", cmd: "put_object" } } },
  sending: {
    on: {
      done: { target: "checking", cmd: "verify_object" },
      fail: { target: "idle", when: "hasBudget", otherwise: "dead" },
    },
  },
  checking: { on: { ok: "idle" } },
  dead: {},
});
type UG = typeof upload;
type UState = StateOf<
  UG,
  {
    idle: { readonly tries: number };
    sending: { readonly key: string; readonly tries: number };
    checking: { readonly key: string; readonly etag: string; readonly tries: number };
    dead: { readonly tries: number };
  }
>;
type UMsg = MsgOf<
  UG,
  {
    pick: { readonly key: string };
    done: { readonly etag: string };
    fail: { readonly error: string };
    ok: Record<never, never>;
  }
>;
type UCmd =
  | (Cmd<"put_object"> & { readonly key: string })
  | (Cmd<"verify_object"> & { readonly key: string; readonly etag: string });

const uCmds: Cmds<UG, UState, UMsg, UCmd> = {
  // one site (`idle.pick`) → exactly the idle state + the pick msg
  put_object: (_s, m) => ({ key: m.key }),
  // one site (`sending.done`) → the sending state + the done msg
  verify_object: (s, m) => ({ key: s.key, etag: m.etag }),
};
export type A26 = Assert<
  Eq<
    Parameters<Cmds<UG, UState, UMsg, UCmd>["put_object"]>,
    [state: Extract<UState, { type: "idle" }>, msg: Extract<UMsg, { type: "pick" }>]
  >
>;
export type A27 = Assert<Eq<ParkingState<UG>, never>>;

export const uploader = compile<UG, UState, UMsg, UCmd, "up">(upload, "up", {
  assign: {
    "idle.pick": (s, m) => ({ key: m.key, tries: s.tries }),
    "sending.done": (s, m) => ({ key: s.key, etag: m.etag, tries: s.tries }),
    "sending.fail": {
      then: (s) => ({ tries: s.tries + 1 }),
      else: (s) => ({ tries: s.tries }),
    },
    "checking.ok": (s) => ({ tries: s.tries }),
  },
  guards: { hasBudget: (s) => s.tries < 3 },
  cmds: uCmds,
  unhandled: "error",
});
export type A28 = Assert<
  Eq<typeof uploader, Transitions<UState, Namespaced<UMsg, "up">, UCmd>>
>;
