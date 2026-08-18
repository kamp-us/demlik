// ═══════════════════════════════════════════════════════════════════════════
// THE REAL INPUT — Umut's lane region (kamp-us/phoenix
// packages/fabrika-cli/src/lane/emit.ts) expressed in the config form.
//
// Every name below is written ONCE as a declaration. States are declared by
// being keys under a phase; events by being keys under `events`; their payloads
// travel with them. The Msg union, the State union, `was`, the entry state and
// the totality obligation are all derived from this one value.
// ═══════════════════════════════════════════════════════════════════════════
import type { Transitions } from "../../pure/core";
import { compile } from "../compile";
import {
  type Assigns,
  type CmdOf,
  defineChart,
  type Guards,
  type MsgIn,
  type MsgOf,
  type StateOf,
  ty,
} from "../graph";

export const lane = defineChart({
  // carried by every state — one declaration, not one per state.
  ctx: ty<{ readonly retries: number; readonly maxRetries: number }>(),

  // `scope` answers "where does this event mean anything?" once, on the event.
  // "edges"  → targeted: live exactly where it is routed, dead elsewhere.
  // <phase>  → live in that phase; EVERY state there must handle or `ignore` it.
  //
  // `from` answers the other half — WHERE DOES THIS EVENT COME FROM? — and it
  // is fabrika's cast, not the library's: the taxonomy (`"cmd"`, `"sub"`, a
  // named world role) is TEA's, the role NAMES below belong to the lane. A
  // reader builds its sentence out of these, so the role is written the way it
  // is said: "the operator" (there is one) and "a human" (any of them).
  events: {
    WIP: {
      data: ty<{ readonly at: number }>(),
      scope: "edges",
      from: { world: "the operator" },
    },
    // the work the lane dispatched, answering. `build`/`review`/`ship` each
    // spawn a shell and the shell reports back; that is a Cmd's result.
    DONE: { data: ty<{ readonly at: number }>(), scope: "edges", from: "cmd" },
    // a block can arrive at any point in the work — and every working state
    // routes it. Adding a state to `working` without a BLOCKED edge goes red.
    BLOCKED: {
      data: ty<{ readonly at: number; readonly reason: string }>(),
      scope: "working",
      from: { world: "the operator" },
    },
    PASS: { data: ty<{ readonly at: number }>(), scope: "edges", from: "cmd" },
    FAIL: {
      data: ty<{ readonly at: number; readonly reason: string }>(),
      scope: "edges",
      from: "cmd",
    },
    // only a parked lane can be unblocked — and both parked states route it.
    UNBLOCKED: {
      data: ty<{ readonly at: number }>(),
      scope: "parked",
      from: { world: "a human" },
    },
  },

  states: {
    working: {
      // the entry point is DATA on the chart — `init` is derived from it, and
      // `machine-viz` draws `[*] --> queued` off the same fact.
      queued: { initial: true, on: { WIP: "build", BLOCKED: "blocked" } },
      build: { on: { DONE: "review", BLOCKED: "blocked" } },
      review: {
        on: {
          PASS: "ship",
          BLOCKED: "blocked",
          // the one guarded edge: retries left → back to build, else freeze.
          FAIL: {
            target: "build",
            when: "retriesRemaining",
            otherwise: "frozen",
          },
        },
      },
      ship: { on: { DONE: "shipped", BLOCKED: "human:cp-approval" } },
    },
    // `hist` is not a pseudostate — it is a property OF THE EDGE. A parked lane
    // is deaf to lane traffic until it is unblocked, and that deafness is the
    // `scope` of the lane events, not 10 strings written out here.
    parked: {
      blocked: { on: { UNBLOCKED: { resume: { fallback: "queued" } } } },
      "human:cp-approval": {
        on: { UNBLOCKED: { resume: { fallback: "queued" } } },
      },
    },
    // terminal: declared, not inferred from "has no outgoing edges" — and with
    // its POLARITY, because `shipped` and `frozen` are not the same ending.
    // `frozen` is where the one guarded edge falls through when the retry
    // budget is spent, which is what trips the whole lane; a chart that spelled
    // both `end: true` could not tell the driver which of the two it reached.
    done: {
      shipped: { end: true },
      frozen: { end: "error" },
    },
  },
});

export type LaneG = typeof lane;

export type LaneState = StateOf<LaneG>;
/** The BARE msg union — what the parts below are authored against. */
export type LaneMsg = MsgOf<LaneG>;
/** The namespaced msg union — what the compiled machine actually consumes. */
export type LaneMsgIn<NS extends string | undefined = undefined> = MsgIn<
  LaneG,
  NS
>;
export type LaneCmd = CmdOf<LaneG>;

// ── the parts ───────────────────────────────────────────────────────────────
const ctx = (s: {
  readonly retries: number;
  readonly maxRetries: number;
}): { readonly retries: number; readonly maxRetries: number } => ({
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
    // biome-ignore lint/suspicious/noThenProperty: the chart's guarded-assign shape is `{ then, else }` — the two arms of one edge's guard, never a thenable
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
  return compile(lane, { assign, guards }, ns);
}

export const issue42 = region("ISSUE_42");
