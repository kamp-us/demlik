// ═══════════════════════════════════════════════════════════════════════════
// A FOREIGN MSG, IN A NAMESPACED MACHINE.
//
// The generality blocker this file exists to close: a machine that consumes a
// Msg minted by a LIBRARY cannot rename it. `@demlik/tea/deadline` dispatches
// `{ type: "deadline_exceeded", id, atMs }` from its own subscribe cell, and no
// amount of author intent turns that into `"JOB_A.deadline_exceeded"`. Before
// per-event namespacing, such a machine could not be compiled at all: the only
// escape was `ns: ""`, which keys the table `".deadline_exceeded"` — a name
// nothing dispatches.
//
// The chart now says whose name it is. `foreign: true` on the event, one word,
// visible in the chart because "this event is not mine" is a fact ABOUT THE
// MACHINE, not a compile-time flag.
//
// The machine itself is a per-job watchdog — N copies of one chart, one per
// job, sharing a dispatch surface. `START` / `FINISHED` are the author's, so
// they are namespaced and instance-private. `deadline_exceeded` is the
// library's, so it is bare and SHARED — which is correct: it is the same event.
// ═══════════════════════════════════════════════════════════════════════════
import {
  type DeadlineSub,
  deadlineSub,
  subscribeDeadline,
} from "../../deadline";
import type { Cmd } from "../../pure/core";
import { defineMachine } from "../../runtime-types";
import { compile, initFrom } from "../compile";
import {
  type Assert,
  defineChart,
  type Eq,
  type ForeignEvent,
  type MsgIn,
  type MsgOf,
  type StateOf,
  ty,
} from "../graph";

export const watchdog = defineChart({
  ctx: ty<{ readonly jobId: string; readonly deadlineAtMs: number }>(),

  events: {
    // ── the author's own events. Namespaced, so instance A's START can never
    //    be delivered to instance B.
    START: {
      data: ty<{ readonly jobId: string; readonly deadlineAtMs: number }>(),
      scope: "edges",
    },
    FINISHED: { data: ty<{ readonly at: number }>(), scope: "live" },

    // ── the LIBRARY's event. `@demlik/tea/deadline` owns this name; the shape
    //    below is `DeadlineExceeded` verbatim, and `foreign: true` is what keeps
    //    it bare in the emitted table under every namespace.
    //
    //    Note it is a NORMAL event otherwise: it declares a `scope`, so `idle`
    //    still owes a decision about it and discharges that by `ignore`.
    deadline_exceeded: {
      data: ty<{ readonly id: string; readonly atMs: number }>(),
      foreign: true,
      scope: "live",
    },
  },

  states: {
    live: {
      idle: {
        initial: true,
        on: { START: "working" },
        // both live events are refused here BY NAME — totality is unchanged for
        // a foreign event.
        ignore: ["FINISHED", "deadline_exceeded"],
      },
      working: {
        on: { FINISHED: "settled", deadline_exceeded: "expired" },
      },
    },
    over: {
      settled: { end: true },
      expired: { end: true },
    },
  },
});

export type WG = typeof watchdog;
export type WState = StateOf<WG>;
/** The BARE msg union — what the parts are authored against. */
export type WMsg = MsgOf<WG>;
/** The msg union as an INSTANCE consumes it: own events prefixed, foreign bare. */
export type WMsgIn<NS extends string | undefined = undefined> = MsgIn<WG, NS>;

// ── the parts. Written ONCE; every instance shares them. ────────────────────
const ctx = (s: {
  readonly jobId: string;
  readonly deadlineAtMs: number;
}): { readonly jobId: string; readonly deadlineAtMs: number } => ({
  jobId: s.jobId,
  deadlineAtMs: s.deadlineAtMs,
});

const parts = {
  assign: {
    "idle.START": (_s, m) => ({
      jobId: m.jobId,
      deadlineAtMs: m.deadlineAtMs,
    }),
    "working.FINISHED": (s) => ctx(s),
    // the library's payload, read like any other msg — `m.atMs` is typed off
    // the chart's own `data`, not off an `any` that leaked in from the Sub.
    "working.deadline_exceeded": (s, m) => ({
      jobId: s.jobId,
      deadlineAtMs: m.atMs,
    }),
  },
} satisfies Parameters<typeof compile<WG, WState, WMsg>>[1];

/**
 * One chart, N instances. `ns` decorates the author's events and leaves the
 * library's alone — the whole point, in one call.
 */
export function jobWatcher<const NS extends string>(ns: NS) {
  return defineMachine<
    WState,
    WMsgIn<NS>,
    Cmd<never>,
    DeadlineSub,
    Record<never, never>
  >({
    init: initFrom<WG, WState, Cmd<never>>(watchdog, () => ({
      jobId: "",
      deadlineAtMs: 0,
    })),
    update: compile(watchdog, parts, ns),
    // the REAL deadline path: the Sub is armed while the job is working, and
    // the substrate's reconcile pass disarms it the moment the state leaves
    // `working`. Nothing here fakes a Msg.
    subscriptions: (s) =>
      s.type === "working"
        ? [deadlineSub(`deadline:${s.jobId}`, s.deadlineAtMs)]
        : [],
    subscribe: { deadline: subscribeDeadline },
  });
}

/** The un-namespaced form: a single-instance machine passes NO namespace. */
export const solo = compile(watchdog, parts);

// ── the guarantee, asserted ────────────────────────────────────────────────
export type W1 = Assert<Eq<ForeignEvent<WG>, "deadline_exceeded">>;

// the author's events are namespaced; the library's is not.
export type W2 = Assert<
  Eq<
    WMsgIn<"JOB_A">["type"],
    "JOB_A.START" | "JOB_A.FINISHED" | "deadline_exceeded"
  >
>;
// THE LITERAL-DISJOINTNESS GUARANTEE, refined. Two namespaces still produce
// genuinely disjoint OWN events — and the overlap is EXACTLY the foreign event,
// because that one really is the same event for both instances.
export type W3 = Assert<
  Eq<WMsgIn<"JOB_A">["type"] & WMsgIn<"JOB_B">["type"], "deadline_exceeded">
>;
// …and the author-owned half alone is still `never`, as before.
export type W4 = Assert<
  Eq<
    Exclude<WMsgIn<"JOB_A">["type"], ForeignEvent<WG>> &
      Exclude<WMsgIn<"JOB_B">["type"], ForeignEvent<WG>>,
    never
  >
>;
// no namespace at all: every key is bare, and the type says so.
export type W5 = Assert<
  Eq<WMsgIn<undefined>["type"], "START" | "FINISHED" | "deadline_exceeded">
>;
export type W6 = Assert<
  Eq<keyof (typeof solo)["idle"], WMsgIn<undefined>["type"]>
>;
// the emitted TABLE for a namespaced instance is keyed exactly like the msg
// union — including at a TERMINAL state, where the refusal cells live.
const jobA = compile(watchdog, parts, "JOB_A");
export type W7 = Assert<
  Eq<keyof (typeof jobA)["working"], WMsgIn<"JOB_A">["type"]>
>;
export type W7a = Assert<
  Eq<keyof (typeof jobA)["expired"], WMsgIn<"JOB_A">["type"]>
>;
// the library's Msg really is assignable to the instance's Msg union — the
// thing that was impossible before.
export type W8 = Assert<
  Eq<
    Extract<WMsgIn<"JOB_A">, { type: "deadline_exceeded" }>,
    { readonly type: "deadline_exceeded" } & {
      readonly id: string;
      readonly atMs: number;
    }
  >
>;
