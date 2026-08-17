/**
 * The order/checkout saga — PURE. No Effect, no Durable Object, no clock.
 *
 * `idle → paying → reserving → settled`, with a payment retry ladder whose
 * bookkeeping lives IN THE REDUCER (attempt count + next-retry-at are ordinary
 * State fields, not `Schedule` state hidden inside a running fiber) and a
 * compensation path (`reserving` fails → refund → `failed`).
 *
 * That placement is the whole point of the demo: because the retry ladder is
 * State, it is whatever the Store persisted. Kill the process mid-retry and
 * the ladder comes back exactly where it was. A `Schedule` living in a fiber
 * dies with the isolate.
 */

import { defineMachine, type Reducer } from "../../../src/index";
import {
  backoffDelay,
  type RetryPolicy,
} from "../../../src/retry-backoff/index";

// ── Vocabulary ──────────────────────────────────────────────────────────────

export type Phase =
  | "idle"
  | "paying"
  | "reserving"
  | "refunding"
  | "settled"
  | "failed";

export interface LogLine {
  readonly at: number;
  readonly text: string;
}

export interface State {
  readonly phase: Phase;
  readonly orderId: string;
  readonly amountCents: number;
  /** Payment attempts STARTED so far. Visible state — that is the demo. */
  readonly attempt: number;
  /** Absolute epoch-ms the next payment retry is due, or null when not waiting. */
  readonly nextRetryAt: number | null;
  readonly paymentRef: string | null;
  readonly failure: string | null;
  readonly log: readonly LogLine[];
}

export type Msg =
  | {
      readonly type: "start";
      readonly orderId: string;
      readonly amountCents: number;
      readonly at: number;
    }
  | { readonly type: "payment_ok"; readonly ref: string; readonly at: number }
  | {
      readonly type: "payment_failed";
      readonly reason: string;
      readonly at: number;
    }
  | { readonly type: "retry_now"; readonly at: number }
  | { readonly type: "reserve_ok"; readonly at: number }
  | {
      readonly type: "reserve_failed";
      readonly reason: string;
      readonly at: number;
    }
  | { readonly type: "refund_ok"; readonly at: number }
  | {
      readonly type: "refund_failed";
      readonly reason: string;
      readonly at: number;
    };

export type Cmd =
  | {
      readonly type: "charge";
      readonly orderId: string;
      readonly amountCents: number;
      /**
       * Carried from reducer State, NOT read off a module-level counter. The
       * fake provider is a pure function of this number, so it survives an
       * isolate restart — which is what makes the kill/resume proof honest.
       */
      readonly attempt: number;
    }
  | { readonly type: "reserve"; readonly orderId: string }
  | {
      readonly type: "refund";
      readonly orderId: string;
      readonly paymentRef: string;
    };

/** No Ctx dependency — the saga's edges all live in the Effect layer. */
export type Ctx = Record<string, never>;

// ── Retry ladder ────────────────────────────────────────────────────────────

/**
 * Jitter is "none" so the demo's timing is legible (2.5s, then 5s) and the
 * reducer stays a pure function of `(state, msg)` with no rng at all.
 */
export const paymentRetryPolicy: RetryPolicy = {
  baseMs: 2_500,
  factor: 2,
  capMs: 20_000,
  maxAttempts: 4,
  jitter: "none",
};

/** Delay before retrying after `attempt` (1-based) has failed. PURE. */
export function retryDelayMs(attempt: number): number {
  return backoffDelay(attempt - 1, paymentRetryPolicy);
}

// ── Reducer ─────────────────────────────────────────────────────────────────

const MAX_LOG = 40;

function note(state: State, at: number, text: string): State {
  const log = [...state.log, { at, text }];
  return { ...state, log: log.slice(Math.max(0, log.length - MAX_LOG)) };
}

export function initialState(): State {
  return {
    phase: "idle",
    orderId: "",
    amountCents: 0,
    attempt: 0,
    nextRetryAt: null,
    paymentRef: null,
    failure: null,
    log: [],
  };
}

export const update: Reducer<State, Msg, Cmd> = {
  start: (state, msg) => {
    // Restarting a finished order is a fresh saga; restarting an in-flight one
    // is a no-op, so a double-click can't fork the ladder.
    if (state.phase !== "idle" && !isTerminal(state)) return [state, []];
    const fresh: State = {
      ...initialState(),
      phase: "paying",
      orderId: msg.orderId,
      amountCents: msg.amountCents,
      attempt: 1,
    };
    return [
      note(
        fresh,
        msg.at,
        `order ${msg.orderId} started — charging (attempt 1)`,
      ),
      [
        {
          type: "charge",
          orderId: msg.orderId,
          amountCents: msg.amountCents,
          attempt: 1,
        },
      ],
    ];
  },

  payment_ok: (state, msg) => {
    if (state.phase !== "paying") return [state, []];
    const next: State = {
      ...state,
      phase: "reserving",
      paymentRef: msg.ref,
      nextRetryAt: null,
    };
    return [
      note(next, msg.at, `payment captured (${msg.ref}) — reserving stock`),
      [{ type: "reserve", orderId: state.orderId }],
    ];
  },

  payment_failed: (state, msg) => {
    if (state.phase !== "paying") return [state, []];
    if (state.attempt >= paymentRetryPolicy.maxAttempts) {
      const next: State = {
        ...state,
        phase: "failed",
        nextRetryAt: null,
        failure: msg.reason,
      };
      return [
        note(
          next,
          msg.at,
          `payment gave up after ${state.attempt}: ${msg.reason}`,
        ),
        [],
      ];
    }
    const delay = retryDelayMs(state.attempt);
    const next: State = { ...state, nextRetryAt: msg.at + delay };
    return [
      note(
        next,
        msg.at,
        `payment attempt ${state.attempt} declined (${msg.reason}) — retry in ${delay}ms`,
      ),
      [],
    ];
  },

  retry_now: (state, msg) => {
    // Idempotent: the alarm can fire twice (re-arm on cold wake), and a stale
    // fire must not double-charge.
    if (state.phase !== "paying" || state.nextRetryAt === null) {
      return [state, []];
    }
    if (msg.at < state.nextRetryAt) return [state, []];
    const attempt = state.attempt + 1;
    const next: State = { ...state, attempt, nextRetryAt: null };
    return [
      note(next, msg.at, `retrying payment (attempt ${attempt})`),
      [
        {
          type: "charge",
          orderId: state.orderId,
          amountCents: state.amountCents,
          attempt,
        },
      ],
    ];
  },

  reserve_ok: (state, msg) => {
    if (state.phase !== "reserving") return [state, []];
    return [
      note({ ...state, phase: "settled" }, msg.at, "stock reserved — settled"),
      [],
    ];
  },

  reserve_failed: (state, msg) => {
    if (state.phase !== "reserving") return [state, []];
    const ref = state.paymentRef;
    // Compensation is only owed for money we actually took.
    if (ref === null) {
      return [
        note(
          { ...state, phase: "failed", failure: msg.reason },
          msg.at,
          `reservation failed (${msg.reason}) — nothing to refund`,
        ),
        [],
      ];
    }
    return [
      note(
        { ...state, phase: "refunding", failure: msg.reason },
        msg.at,
        `reservation failed (${msg.reason}) — refunding ${ref}`,
      ),
      [{ type: "refund", orderId: state.orderId, paymentRef: ref }],
    ];
  },

  refund_ok: (state, msg) => {
    if (state.phase !== "refunding") return [state, []];
    return [
      note(
        { ...state, phase: "failed" },
        msg.at,
        "refund issued — order failed cleanly",
      ),
      [],
    ];
  },

  refund_failed: (state, msg) => {
    if (state.phase !== "refunding") return [state, []];
    return [
      note(
        {
          ...state,
          phase: "failed",
          failure: `${state.failure}; refund stuck: ${msg.reason}`,
        },
        msg.at,
        `REFUND FAILED (${msg.reason}) — manual reconciliation owed`,
      ),
      [],
    ];
  },
};

export function isTerminal(state: State): boolean {
  return state.phase === "settled" || state.phase === "failed";
}

/**
 * The boundary parse for `doStore`. Returns `null` (boot fresh) rather than
 * throwing on a shape mismatch, per the `Store.migrate` contract.
 */
export function parseState(raw: unknown): State | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as Partial<State>;
  if (typeof candidate.phase !== "string") return null;
  if (typeof candidate.attempt !== "number") return null;
  if (!Array.isArray(candidate.log)) return null;
  return candidate as State;
}

export function checkoutMachine(
  interpret: import("../../../src/index").Interpret<Msg, Cmd, Ctx>,
) {
  return defineMachine<State, Msg, Cmd, never, Ctx>({
    init: (loaded) => [loaded ?? initialState(), []],
    update,
    interpret,
  });
}
