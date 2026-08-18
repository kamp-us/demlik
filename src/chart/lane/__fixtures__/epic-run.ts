// ═══════════════════════════════════════════════════════════════════════════
// A RUNNABLE EPIC — the coder region, written to fabrika's OWN transition
// semantics, three instances of it, two phases.
//
// `../../__fixtures__/lane.ts` is the same region as a drawing exercise; this
// one exists to be RUN and to be folded, and the two have to be the same
// machine for that comparison to mean anything. So two things are deliberate:
//
//   THE GUARD IS THE FOLD'S GUARD. `report/fold.ts` walks a guarded edge with
//   the one inline predicate `retries < maxRetries` — the guard NAME in a
//   `workflow.json` is inert data nobody dereferences. `retriesRemaining` here
//   is that predicate and nothing else, so the two sides can be compared rather
//   than merely described as similar.
//
//   THE `then` ARM INCREMENTS. Same reason: the fold's guarded branch returns
//   `retries + 1`.
//
// It emits cmds, which the fold has no opinion about at all — a fold replays a
// log of things that already happened, so the effects are exactly the part it
// cannot have. That is where the two genuinely differ and why the runtime is
// not a fold with extra steps.
// ═══════════════════════════════════════════════════════════════════════════
import type { Parts } from "../../compile";
import {
  type Assigns,
  type Cmds,
  defineChart,
  type Guards,
  type MsgOf,
  type StateOf,
  ty,
} from "../../graph";
import { defineLane } from "../structure";

export const coder = defineChart({
  ctx: ty<{ readonly retries: number; readonly maxRetries: number }>(),
  cmds: { spawn_shell: ty<{ readonly step: string }>() },
  events: {
    WIP: { data: ty<{ readonly at: number }>(), scope: "edges" },
    DONE: { data: ty<{ readonly at: number }>(), scope: "edges" },
    PASS: { data: ty<{ readonly at: number }>(), scope: "edges" },
    FAIL: {
      data: ty<{ readonly at: number; readonly reason: string }>(),
      scope: "edges",
    },
    BLOCKED: {
      data: ty<{ readonly at: number; readonly reason: string }>(),
      scope: "working",
    },
    UNBLOCKED: { data: ty<{ readonly at: number }>(), scope: "parked" },
  },
  states: {
    working: {
      queued: {
        initial: true,
        on: {
          WIP: { target: "build", cmd: "spawn_shell" },
          BLOCKED: "blocked",
        },
      },
      build: { on: { DONE: "review", BLOCKED: "blocked" } },
      review: {
        on: {
          PASS: { target: "ship", cmd: "spawn_shell" },
          FAIL: {
            target: "build",
            when: "retriesRemaining",
            otherwise: "frozen",
          },
          BLOCKED: "blocked",
        },
      },
      ship: { on: { DONE: "shipped", BLOCKED: "blocked" } },
    },
    parked: {
      blocked: { on: { UNBLOCKED: { resume: { fallback: "queued" } } } },
    },
    done: {
      shipped: { end: true },
      frozen: { end: "error" },
    },
  },
});

export type Coder = typeof coder;
export type CoderState = StateOf<Coder>;
export type CoderMsg = MsgOf<Coder>;

const ctx = (s: CoderState): { retries: number; maxRetries: number } => ({
  retries: s.retries,
  maxRetries: s.maxRetries,
});

const assign: Assigns<Coder, CoderState, CoderMsg> = {
  "queued.WIP": ctx,
  "queued.BLOCKED": ctx,
  "build.DONE": ctx,
  "build.BLOCKED": ctx,
  "review.PASS": ctx,
  "review.BLOCKED": ctx,
  "review.FAIL": {
    // biome-ignore lint/suspicious/noThenProperty: the chart's guarded-assign shape is `{ then, else }` — the two arms of one edge's guard, never a thenable
    then: (s) => ({ retries: s.retries + 1, maxRetries: s.maxRetries }),
    else: ctx,
  },
  "ship.DONE": ctx,
  "ship.BLOCKED": ctx,
  "blocked.UNBLOCKED": ctx,
};

const guards: Guards<Coder, CoderState, CoderMsg> = {
  // fabrika's guard, verbatim: the budget, and nothing else in it.
  retriesRemaining: (s) => s.retries < s.maxRetries,
};

const cmds: Cmds<Coder, CoderState, CoderMsg> = {
  spawn_shell: (_s, _m, at) => ({ step: at }),
};

export const coderParts: Parts<Coder, CoderState, CoderMsg> = {
  assign,
  guards,
  cmds,
};

/** Two phases, three instances of one template — `issue_3` on a longer leash. */
export const epic = defineLane({
  id: "epic-5728",
  phases: {
    phase1: { issue_1: coder, issue_2: coder },
    phase2: { issue_3: coder },
  },
  terminals: { complete: "complete", tripped: "tripped" },
  retries: { issue_3: 5 },
});

export type Epic = typeof epic;

/** The zero every task boots at when nothing says otherwise. */
export const bootQueued = (maxRetries: number) => (): CoderState => ({
  type: "queued",
  retries: 0,
  maxRetries,
});
