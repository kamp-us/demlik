// ═══════════════════════════════════════════════════════════════════════════
// THE REAL INPUT — Umut's lane region (kamp-us/phoenix
// packages/fabrika-cli/src/lane/emit.ts) expressed in the config form.
// ═══════════════════════════════════════════════════════════════════════════
import type { Cmd, Transitions } from "../pure/core";
import { compile } from "./compile";
import {
  type Assigns,
  type Guards,
  type MsgOf,
  type Namespaced,
  type ResumeTargets,
  type StateOf,
  defineGraph,
} from "./graph";

// ── the graph. No `as const`. Every target checked against these same keys. ──
// Every (state × event) pair is DECLARED in `on` or REFUSED — named in
// `ignore`, or dismissed for the whole row by `end: true`. There is no third
// case: `Total<G>` fails to compile on one. Add a seventh event and every row
// that has not decided about it goes red.
export const lane = defineGraph({
  queued: {
    on: { WIP: "build", BLOCKED: "blocked" },
    ignore: ["DONE", "PASS", "FAIL", "UNBLOCKED"],
  },
  build: {
    on: { DONE: "review", BLOCKED: "blocked" },
    ignore: ["WIP", "PASS", "FAIL", "UNBLOCKED"],
  },
  review: {
    on: {
      PASS: "ship",
      BLOCKED: "blocked",
      // the one guarded edge: retries left → back to build, else freeze.
      FAIL: { target: "build", when: "retriesRemaining", otherwise: "frozen" },
    },
    ignore: ["WIP", "DONE", "UNBLOCKED"],
  },
  ship: {
    on: { DONE: "shipped", BLOCKED: "human:cp-approval" },
    ignore: ["WIP", "PASS", "FAIL", "UNBLOCKED"],
  },
  // `hist` is not a pseudostate — it is a property OF THE EDGE.
  // A parked lane is deaf to lane traffic until it is unblocked.
  blocked: {
    on: { UNBLOCKED: { resume: { fallback: "queued" } } },
    ignore: ["WIP", "DONE", "BLOCKED", "PASS", "FAIL"],
  },
  "human:cp-approval": {
    on: { UNBLOCKED: { resume: { fallback: "queued" } } },
    ignore: ["WIP", "DONE", "BLOCKED", "PASS", "FAIL"],
  },
  // terminal: declared, not inferred from "has no outgoing edges".
  shipped: { end: true },
  frozen: { end: true },
});

export type LaneG = typeof lane;

// ── the per-state / per-event payloads (types can't come from a value) ──────
/** Where a `blocked` resume can land — DERIVED, not written by hand. */
export type BlockedWas = ResumeTargets<LaneG, "blocked">;
export type CpWas = ResumeTargets<LaneG, "human:cp-approval">;

type Ctx = { readonly retries: number; readonly maxRetries: number };

type LaneData = {
  queued: Ctx;
  build: Ctx;
  review: Ctx;
  ship: Ctx;
  blocked: Ctx & { readonly was: BlockedWas };
  "human:cp-approval": Ctx & { readonly was: CpWas };
  shipped: Ctx;
  frozen: Ctx;
};

type LanePayload = {
  WIP: { readonly at: number };
  DONE: { readonly at: number };
  BLOCKED: { readonly at: number; readonly reason: string };
  PASS: { readonly at: number };
  FAIL: { readonly at: number; readonly reason: string };
  UNBLOCKED: { readonly at: number };
};

export type LaneState = StateOf<LaneG, LaneData>;
/** The BARE msg union — what the parts below are authored against. */
export type LaneMsg = MsgOf<LaneG, LanePayload>;
/** The namespaced msg union — what the compiled machine actually consumes. */
export type LaneMsgIn<NS extends string> = Namespaced<LaneMsg, NS>;
export type LaneCmd = Cmd<never>;

// ── the parts ───────────────────────────────────────────────────────────────
const ctx = (s: { retries: number; maxRetries: number }): Ctx => ({
  retries: s.retries,
  maxRetries: s.maxRetries,
});

export const assign: Assigns<LaneG, LaneState, LaneMsg> = {
  // `was` is absent from every BLOCKED return type: the compiler injects it.
  "queued.WIP": (s) => ctx(s),
  "queued.BLOCKED": (s) => ctx(s),
  "build.DONE": (s) => ctx(s),
  "build.BLOCKED": (s) => ctx(s),
  "review.PASS": (s) => ctx(s),
  "review.BLOCKED": (s) => ctx(s),
  // guarded edge → `{ then, else }`, each narrowed to ITS target's payload.
  "review.FAIL": {
    then: (s) => ({ retries: s.retries + 1, maxRetries: s.maxRetries }),
    else: (s) => ctx(s),
  },
  "ship.DONE": (s) => ctx(s),
  "ship.BLOCKED": (s) => ctx(s),
  "blocked.UNBLOCKED": (s) => ctx(s),
  "human:cp-approval.UNBLOCKED": (s) => ctx(s),
};

export const guards: Guards<LaneG, LaneState, LaneMsg> = {
  // `s` is EXACTLY the `review` state and `m` is EXACTLY the FAIL msg —
  // derived from the single edge that references this guard.
  retriesRemaining: (s, m) => s.retries < s.maxRetries && m.reason !== "fatal",
};

// ── namespace-as-type-parameter ─────────────────────────────────────────────
/**
 * One region template, N namespaces. `NS` survives as a literal all the way
 * into the emitted `Transitions` key set.
 */
export function region<const NS extends string>(
  ns: NS,
): Transitions<LaneState, LaneMsgIn<NS>, LaneCmd> {
  return compile<LaneG, LaneState, LaneMsg, LaneCmd, NS>(lane, ns, {
    assign,
    guards,
  });
}

export const issue42 = region("ISSUE_42");
