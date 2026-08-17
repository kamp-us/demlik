/**
 * Recipe 2 — DUNNING.
 *
 * Use case: a subscription's card is declined. Billing retries on day 1, day 3
 * and day 7; if all three fail the account gets a 14-day grace period, and then
 * it is downgraded. A payment landing at any point ends the whole thing.
 *
 *   idle → retrying → grace → downgraded
 *                  ↘ recovered  (a payment at any point)
 *
 * The durable insight: a 21-day process cannot live in a process. There is no
 * runtime you can hold open for three weeks — not a fiber, not a container, not
 * a queue message. So the schedule is not a schedule, it is arithmetic:
 * `firstFailedAt + RETRY_OFFSETS[n]` is a number in a row, and the host arms
 * ONE alarm for whatever `dueAt` currently says. The reducer never sleeps and
 * never reads a clock; `at` arrives on the Msg.
 */

import {
  defineMachine,
  type Interpret,
  type Reducer,
} from "../../../src/index";

const DAY = 24 * 60 * 60 * 1000;

/** Retries land on day 1, 3 and 7 — measured from the FIRST decline. */
export const RETRY_OFFSETS_MS: readonly number[] = [1 * DAY, 3 * DAY, 7 * DAY];
export const GRACE_MS = 14 * DAY;

export type Phase = "idle" | "retrying" | "grace" | "downgraded" | "recovered";

export interface State {
  readonly phase: Phase;
  readonly subscriptionId: string;
  readonly amountCents: number;
  /** Anchor for the whole ladder. Every deadline is derived from it. */
  readonly firstFailedAt: number;
  /** Which rung of RETRY_OFFSETS_MS is next. Equals the ladder length when spent. */
  readonly rung: number;
  /** The one instant the host arms an alarm for, or null when nothing is owed. */
  readonly dueAt: number | null;
  readonly declines: readonly {
    readonly at: number;
    readonly reason: string;
  }[];
  readonly outcomeAt: number | null;
}

export type Msg =
  /** The renewal charge was declined — dunning opens here. */
  | {
      readonly type: "renewal_declined";
      readonly subscriptionId: string;
      readonly amountCents: number;
      readonly reason: string;
      readonly at: number;
    }
  /** A retry charge came back declined. */
  | {
      readonly type: "charge_declined";
      readonly reason: string;
      readonly at: number;
    }
  /** Money arrived — a retry landing, or the customer fixing their card in the portal. */
  | { readonly type: "payment_succeeded"; readonly at: number }
  | { readonly type: "tick"; readonly at: number };

export type Cmd =
  | {
      readonly type: "charge";
      readonly subscriptionId: string;
      readonly amountCents: number;
      readonly rung: number;
    }
  | {
      readonly type: "notify";
      readonly subscriptionId: string;
      readonly kind:
        | "retry_failed"
        | "grace_started"
        | "downgraded"
        | "recovered";
    }
  | { readonly type: "downgrade"; readonly subscriptionId: string };

export type Ctx = Record<string, never>;

export function initialState(): State {
  return {
    phase: "idle",
    subscriptionId: "",
    amountCents: 0,
    firstFailedAt: 0,
    rung: 0,
    dueAt: null,
    declines: [],
    outcomeAt: null,
  };
}

/** The absolute instant retry `rung` is owed, or null when the ladder is spent. */
export function retryDueAt(firstFailedAt: number, rung: number): number | null {
  const offset = RETRY_OFFSETS_MS[rung];
  return offset === undefined ? null : firstFailedAt + offset;
}

function recovered(state: State, at: number): readonly [State, readonly Cmd[]] {
  return [
    { ...state, phase: "recovered", dueAt: null, outcomeAt: at },
    [
      {
        type: "notify",
        subscriptionId: state.subscriptionId,
        kind: "recovered",
      },
    ],
  ];
}

export const update: Reducer<State, Msg, Cmd> = {
  renewal_declined: (state, msg) => {
    if (state.phase !== "idle") return [state, []];
    const next: State = {
      ...initialState(),
      phase: "retrying",
      subscriptionId: msg.subscriptionId,
      amountCents: msg.amountCents,
      firstFailedAt: msg.at,
      rung: 0,
      dueAt: retryDueAt(msg.at, 0),
      declines: [{ at: msg.at, reason: msg.reason }],
    };
    return [next, []];
  },

  /**
   * The alarm came due. What it means is read off `phase` — a retry charge
   * while retrying, the end of the grace window while in grace. Idempotent: an
   * early or duplicate fire is a no-op, which matters because an alarm can fire
   * twice across a cold wake.
   */
  tick: (state, msg) => {
    if (state.dueAt === null || msg.at < state.dueAt) return [state, []];

    if (state.phase === "retrying") {
      // Disarm while the charge is in flight; the outcome Msg re-arms.
      return [
        { ...state, dueAt: null },
        [
          {
            type: "charge",
            subscriptionId: state.subscriptionId,
            amountCents: state.amountCents,
            rung: state.rung,
          },
        ],
      ];
    }

    if (state.phase === "grace") {
      return [
        { ...state, phase: "downgraded", dueAt: null, outcomeAt: msg.at },
        [
          { type: "downgrade", subscriptionId: state.subscriptionId },
          {
            type: "notify",
            subscriptionId: state.subscriptionId,
            kind: "downgraded",
          },
        ],
      ];
    }

    return [{ ...state, dueAt: null }, []];
  },

  charge_declined: (state, msg) => {
    if (state.phase !== "retrying") return [state, []];
    const rung = state.rung + 1;
    const declines = [...state.declines, { at: msg.at, reason: msg.reason }];
    const nextDue = retryDueAt(state.firstFailedAt, rung);

    if (nextDue !== null) {
      return [
        { ...state, rung, declines, dueAt: nextDue },
        [
          {
            type: "notify",
            subscriptionId: state.subscriptionId,
            kind: "retry_failed",
          },
        ],
      ];
    }

    // The ladder is spent. Grace is measured from the LAST decline, not from
    // the anchor — the customer gets their full 14 days however the retries
    // happened to land.
    return [
      { ...state, phase: "grace", rung, declines, dueAt: msg.at + GRACE_MS },
      [
        {
          type: "notify",
          subscriptionId: state.subscriptionId,
          kind: "grace_started",
        },
      ],
    ];
  },

  /** Money at any non-terminal point ends dunning. */
  payment_succeeded: (state, msg) => {
    if (state.phase !== "retrying" && state.phase !== "grace")
      return [state, []];
    return recovered(state, msg.at);
  },
};

export function isTerminal(state: State): boolean {
  return state.phase === "downgraded" || state.phase === "recovered";
}

export function parseState(raw: unknown): State | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as Partial<State>;
  if (typeof candidate.phase !== "string") return null;
  if (typeof candidate.rung !== "number") return null;
  if (!Array.isArray(candidate.declines)) return null;
  return candidate as State;
}

export function dunningMachine(interpret: Interpret<Msg, Cmd, Ctx>) {
  return defineMachine<State, Msg, Cmd, never, Ctx>({
    init: (loaded) => [loaded ?? initialState(), []],
    update,
    interpret,
  });
}
