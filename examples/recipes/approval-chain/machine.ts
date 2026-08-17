/**
 * Recipe 3 — APPROVAL CHAIN.
 *
 * Use case: an expense report walks an ordered list of approvers. Each one gets
 * the request, a reminder after two days of silence, and an escalation to their
 * manager after seven. Any rejection kills the request; the last approval
 * carries it.
 *
 *   pending (per approver: assigned → reminded → escalated) → approved | rejected
 *
 * The durable insight: state IS the audit log. `decisions` and `notices` are
 * append-only arrays with timestamps, so "who approved this, when, and what did
 * we chase them with" is answered by reading the same row the machine runs on —
 * not by joining a separate events table that a failed write can desynchronise
 * from the workflow. There is nothing to reconcile because there is one record.
 *
 * No Effect handlers here: the interesting part is entirely pure.
 */

import {
  defineMachine,
  type Interpret,
  type Reducer,
} from "../../../src/index";

const DAY = 24 * 60 * 60 * 1000;

export const REMIND_AFTER_MS = 2 * DAY;
export const ESCALATE_AFTER_MS = 7 * DAY;

export type Phase = "draft" | "pending" | "approved" | "rejected";
export type Verdict = "approved" | "rejected";

export interface Decision {
  readonly approver: string;
  readonly verdict: Verdict;
  readonly at: number;
  readonly comment: string | null;
}

export interface Notice {
  readonly approver: string;
  readonly kind: "assigned" | "reminded" | "escalated";
  readonly at: number;
}

export interface State {
  readonly phase: Phase;
  readonly requestId: string;
  readonly amountCents: number;
  readonly approvers: readonly string[];
  /** Index of the approver the ball is with. */
  readonly cursor: number;
  /** When the CURRENT approver received it. Both deadlines derive from this. */
  readonly assignedAt: number | null;
  readonly remindedAt: number | null;
  readonly escalatedAt: number | null;
  readonly dueAt: number | null;
  /** The audit log — same row as the workflow, so it cannot drift. */
  readonly decisions: readonly Decision[];
  readonly notices: readonly Notice[];
}

export type Msg =
  | {
      readonly type: "submit";
      readonly requestId: string;
      readonly amountCents: number;
      readonly approvers: readonly string[];
      readonly at: number;
    }
  | {
      readonly type: "decide";
      readonly approver: string;
      readonly verdict: Verdict;
      readonly comment?: string;
      readonly at: number;
    }
  | { readonly type: "tick"; readonly at: number };

export type Cmd =
  | {
      readonly type: "notify_approver";
      readonly requestId: string;
      readonly approver: string;
      readonly reason: "assigned" | "reminder";
    }
  | {
      readonly type: "escalate";
      readonly requestId: string;
      readonly stalledOn: string;
    };

export type Ctx = Record<string, never>;

export function initialState(): State {
  return {
    phase: "draft",
    requestId: "",
    amountCents: 0,
    approvers: [],
    cursor: 0,
    assignedAt: null,
    remindedAt: null,
    escalatedAt: null,
    dueAt: null,
    decisions: [],
    notices: [],
  };
}

/** The next chase deadline for the current approver, or null once escalated. */
export function chaseDueAt(
  assignedAt: number,
  remindedAt: number | null,
  escalatedAt: number | null,
): number | null {
  if (escalatedAt !== null) return null;
  if (remindedAt === null) return assignedAt + REMIND_AFTER_MS;
  return assignedAt + ESCALATE_AFTER_MS;
}

/** Hand the request to `cursor`. One place mints the assignment. */
function assign(
  state: State,
  cursor: number,
  at: number,
): readonly [State, readonly Cmd[]] {
  const approver = state.approvers[cursor];
  if (approver === undefined) return [state, []];
  return [
    {
      ...state,
      phase: "pending",
      cursor,
      assignedAt: at,
      remindedAt: null,
      escalatedAt: null,
      dueAt: chaseDueAt(at, null, null),
      notices: [...state.notices, { approver, kind: "assigned", at }],
    },
    [
      {
        type: "notify_approver",
        requestId: state.requestId,
        approver,
        reason: "assigned",
      },
    ],
  ];
}

export const update: Reducer<State, Msg, Cmd> = {
  submit: (state, msg) => {
    if (state.phase !== "draft") return [state, []];
    if (msg.approvers.length === 0) return [state, []];
    const fresh: State = {
      ...initialState(),
      requestId: msg.requestId,
      amountCents: msg.amountCents,
      approvers: msg.approvers,
    };
    return assign(fresh, 0, msg.at);
  },

  decide: (state, msg) => {
    if (state.phase !== "pending") return [state, []];
    // Out-of-order decisions are ignored: the chain is ORDERED, and silently
    // accepting a later approver's yes would forge the audit log.
    if (state.approvers[state.cursor] !== msg.approver) return [state, []];

    const decision: Decision = {
      approver: msg.approver,
      verdict: msg.verdict,
      at: msg.at,
      comment: msg.comment ?? null,
    };
    const logged: State = {
      ...state,
      decisions: [...state.decisions, decision],
    };

    if (msg.verdict === "rejected") {
      return [{ ...logged, phase: "rejected", dueAt: null }, []];
    }

    const next = state.cursor + 1;
    if (next >= state.approvers.length) {
      return [{ ...logged, phase: "approved", cursor: next, dueAt: null }, []];
    }
    return assign(logged, next, msg.at);
  },

  /**
   * The chase alarm. Reminder first, escalation second, then nothing — the
   * request sits with a human and no further automation is owed.
   */
  tick: (state, msg) => {
    if (
      state.phase !== "pending" ||
      state.dueAt === null ||
      msg.at < state.dueAt
    )
      return [state, []];
    const approver = state.approvers[state.cursor];
    const assignedAt = state.assignedAt;
    if (approver === undefined || assignedAt === null)
      return [{ ...state, dueAt: null }, []];

    if (state.remindedAt === null) {
      return [
        {
          ...state,
          remindedAt: msg.at,
          dueAt: chaseDueAt(assignedAt, msg.at, null),
          notices: [
            ...state.notices,
            { approver, kind: "reminded", at: msg.at },
          ],
        },
        [
          {
            type: "notify_approver",
            requestId: state.requestId,
            approver,
            reason: "reminder",
          },
        ],
      ];
    }

    return [
      {
        ...state,
        escalatedAt: msg.at,
        dueAt: null,
        notices: [
          ...state.notices,
          { approver, kind: "escalated", at: msg.at },
        ],
      },
      [{ type: "escalate", requestId: state.requestId, stalledOn: approver }],
    ];
  },
};

export function isTerminal(state: State): boolean {
  return state.phase === "approved" || state.phase === "rejected";
}

export function parseState(raw: unknown): State | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as Partial<State>;
  if (typeof candidate.phase !== "string") return null;
  if (!Array.isArray(candidate.approvers)) return null;
  if (!Array.isArray(candidate.decisions)) return null;
  return candidate as State;
}

export function approvalChainMachine(interpret: Interpret<Msg, Cmd, Ctx>) {
  return defineMachine<State, Msg, Cmd, never, Ctx>({
    init: (loaded) => [loaded ?? initialState(), []],
    update,
    interpret,
  });
}
