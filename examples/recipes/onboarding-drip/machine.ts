/**
 * Recipe 4 — ONBOARDING DRIP.
 *
 * Use case: a new user gets a welcome on day 1, a tip on day 3 and a check-in on
 * day 7. The moment they actually do the thing the drip is nudging them toward,
 * the remaining sends are cancelled.
 *
 *   scheduled → (send, send, send) → completed
 *            ↘ completed  (the user became active)
 *
 * The durable insight: cancellation is deletion of a number, not the killing of
 * a job. There is no queued message to find and revoke and no scheduler entry to
 * chase — `dueAt` becomes null and the drip is over. Compare the usual shape,
 * where three delayed jobs are enqueued up front and every one of them has to
 * re-check "is this user still eligible?" against a database that may disagree
 * with whatever the job payload said when it was written.
 *
 * The sends are Cmds: fire-and-forget email, no follow-up Msg. That makes the
 * whole machine a pure schedule walker.
 */

import {
  defineMachine,
  type Interpret,
  type Reducer,
} from "../../../src/index";

const DAY = 24 * 60 * 60 * 1000;

export interface DripStep {
  readonly template: string;
  /** Offset from enrollment. Absolute deadlines derive from `startedAt`. */
  readonly offsetMs: number;
}

export const DRIP: readonly DripStep[] = [
  { template: "welcome", offsetMs: 1 * DAY },
  { template: "first-tip", offsetMs: 3 * DAY },
  { template: "check-in", offsetMs: 7 * DAY },
];

export type Phase = "idle" | "scheduled" | "completed";

export interface State {
  readonly phase: Phase;
  readonly userId: string;
  readonly startedAt: number;
  /** Index of the next step to send. Equals DRIP.length when the drip is spent. */
  readonly cursor: number;
  readonly sent: readonly { readonly template: string; readonly at: number }[];
  readonly dueAt: number | null;
  readonly endedBy: "finished" | "activity" | null;
  /** What the user did that cancelled the rest, and when. */
  readonly cancelledBy: { readonly what: string; readonly at: number } | null;
}

export type Msg =
  | { readonly type: "enrolled"; readonly userId: string; readonly at: number }
  | { readonly type: "tick"; readonly at: number }
  /** The user did the thing. Everything still owed is cancelled. */
  | {
      readonly type: "user_active";
      readonly what: string;
      readonly at: number;
    };

export type Cmd = {
  readonly type: "send_email";
  readonly userId: string;
  readonly template: string;
};

export type Ctx = Record<string, never>;

export function initialState(): State {
  return {
    phase: "idle",
    userId: "",
    startedAt: 0,
    cursor: 0,
    sent: [],
    dueAt: null,
    endedBy: null,
    cancelledBy: null,
  };
}

/** When step `cursor` is due, or null when the drip is spent. */
export function stepDueAt(startedAt: number, cursor: number): number | null {
  const step = DRIP[cursor];
  return step === undefined ? null : startedAt + step.offsetMs;
}

export const update: Reducer<State, Msg, Cmd> = {
  enrolled: (state, msg) => {
    if (state.phase !== "idle") return [state, []];
    return [
      {
        ...initialState(),
        phase: "scheduled",
        userId: msg.userId,
        startedAt: msg.at,
        dueAt: stepDueAt(msg.at, 0),
      },
      [],
    ];
  },

  tick: (state, msg) => {
    if (
      state.phase !== "scheduled" ||
      state.dueAt === null ||
      msg.at < state.dueAt
    )
      return [state, []];
    const step = DRIP[state.cursor];
    if (step === undefined)
      return [
        { ...state, phase: "completed", dueAt: null, endedBy: "finished" },
        [],
      ];

    const cursor = state.cursor + 1;
    const sent = [...state.sent, { template: step.template, at: msg.at }];
    const dueAt = stepDueAt(state.startedAt, cursor);
    const advanced: State =
      dueAt === null
        ? {
            ...state,
            cursor,
            sent,
            dueAt: null,
            phase: "completed",
            endedBy: "finished",
          }
        : { ...state, cursor, sent, dueAt };

    return [
      advanced,
      [{ type: "send_email", userId: state.userId, template: step.template }],
    ];
  },

  user_active: (state, msg) => {
    if (state.phase !== "scheduled") return [state, []];
    // Cancellation is this line. No job to revoke, no queue to scan.
    return [
      {
        ...state,
        phase: "completed",
        dueAt: null,
        endedBy: "activity",
        cancelledBy: { what: msg.what, at: msg.at },
      },
      [],
    ];
  },
};

export function isTerminal(state: State): boolean {
  return state.phase === "completed";
}

/** What the drip never got round to sending. Useful for the "why did we stop?" report. */
export function unsent(state: State): readonly string[] {
  return DRIP.slice(state.cursor).map((step) => step.template);
}

export function parseState(raw: unknown): State | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as Partial<State>;
  if (typeof candidate.phase !== "string") return null;
  if (typeof candidate.cursor !== "number") return null;
  if (!Array.isArray(candidate.sent)) return null;
  return candidate as State;
}

export function onboardingDripMachine(interpret: Interpret<Msg, Cmd, Ctx>) {
  return defineMachine<State, Msg, Cmd, never, Ctx>({
    init: (loaded) => [loaded ?? initialState(), []],
    update,
    interpret,
  });
}
