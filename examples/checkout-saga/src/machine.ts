/**
 * The order/checkout saga — PURE. No Effect, no Durable Object, no clock.
 *
 * Happy path:   idle → paying (retry ladder) → reserving → settled
 * Refund path:  idle → paying → reserving → refunding → failed
 *
 * Every phase that WAITS does so the same way: the reducer writes down the
 * instant the wait ends (`dueAt`) and the host arms a Durable Object alarm for
 * it. There is no sleeping function anywhere in this lane — not for the payment
 * retry, not for the reservation, not for the refund. That is what makes any of
 * these phases survivable: kill the process mid-refund and the refund still
 * completes, because "a refund is owed and confirms at T" is state, not a stack
 * frame.
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
  /**
   * The instant the current wait ends, or null when nothing is scheduled. What
   * it MEANS is read off `phase`: a payment retry while paying, the warehouse's
   * answer while reserving, the refund confirmation while refunding. One field,
   * one alarm, every phase durable by the same mechanism.
   */
  readonly dueAt: number | null;
  readonly paymentRef: string | null;
  readonly refunded: boolean;
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
  /** The scheduled instant arrived. What it triggers depends on the phase. */
  | { readonly type: "tick"; readonly at: number }
  | { readonly type: "reserve_accepted"; readonly at: number }
  | { readonly type: "reserve_ok"; readonly at: number }
  | {
      readonly type: "reserve_failed";
      readonly reason: string;
      readonly at: number;
    }
  | { readonly type: "refund_accepted"; readonly at: number }
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
  /** Lodge the reservation request with the warehouse. */
  | { readonly type: "reserve"; readonly orderId: string }
  /** Ask the warehouse what it decided. Runs after the wait, on a fresh isolate if need be. */
  | { readonly type: "reserve_confirm"; readonly orderId: string }
  | {
      readonly type: "refund";
      readonly orderId: string;
      readonly paymentRef: string;
    }
  | {
      readonly type: "refund_confirm";
      readonly orderId: string;
      readonly paymentRef: string;
    };

/** No Ctx dependency — the saga's edges all live in the Effect layer. */
export type Ctx = Record<string, never>;

// ── Scenarios ───────────────────────────────────────────────────────────────

/**
 * The order id carries which scenario to run. The UI mints the right id from
 * its two start buttons, so nobody has to know this convention exists.
 */
export function isRefundScenario(orderId: string): boolean {
  return orderId.includes("oos");
}

/**
 * How many times the card is declined before it goes through. The refund
 * scenario clears payment fast — its interesting part is what happens AFTER
 * the money is taken, and making people sit through the full ladder twice
 * buries the lede.
 */
export function declinesFor(orderId: string): number {
  return isRefundScenario(orderId) ? 1 : 3;
}

/** How long the warehouse takes to answer, and the refund to clear. */
export const RESERVE_WAIT_MS = 4_000;
export const REFUND_WAIT_MS = 3_000;

// ── Retry ladder ────────────────────────────────────────────────────────────

/** Window in which a second `start` for the same order reads as a double-click. */
const DOUBLE_CLICK_MS = 1_500;

/**
 * Jitter is "none" so the demo's timing is legible (3s, 6s, 12s) and the
 * reducer stays a pure function of `(state, msg)` with no rng at all.
 *
 * The ladder is deliberately SLOW. A presenter has to be able to talk over it
 * and still hit the kill button without sniping.
 */
export const paymentRetryPolicy: RetryPolicy = {
  baseMs: 3_000,
  factor: 2,
  capMs: 30_000,
  maxAttempts: 5,
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
    dueAt: null,
    paymentRef: null,
    refunded: false,
    failure: null,
    log: [],
  };
}

export const update: Reducer<State, Msg, Cmd> = {
  start: (state, msg) => {
    // An explicit start ALWAYS starts a fresh saga, from any state.
    //
    // A genuine double-click lands within a moment of the first start's own
    // events. A restart of a killed order lands seconds or minutes later. The
    // log's own timestamps tell the two apart without a clock in the reducer.
    const lastAt = state.log.at(-1)?.at ?? 0;
    if (
      state.orderId === msg.orderId &&
      state.phase !== "idle" &&
      msg.at - lastAt < DOUBLE_CLICK_MS
    ) {
      return [state, []];
    }
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
      dueAt: null,
    };
    return [
      note(
        next,
        msg.at,
        `payment captured (${msg.ref}) — asking the warehouse`,
      ),
      [{ type: "reserve", orderId: state.orderId }],
    ];
  },

  payment_failed: (state, msg) => {
    if (state.phase !== "paying") return [state, []];
    if (state.attempt >= paymentRetryPolicy.maxAttempts) {
      const next: State = {
        ...state,
        phase: "failed",
        dueAt: null,
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
    const next: State = { ...state, dueAt: msg.at + delay };
    return [
      note(
        next,
        msg.at,
        `payment attempt ${state.attempt} declined (${msg.reason}) — retry in ${delay}ms`,
      ),
      [],
    ];
  },

  /**
   * The single scheduled-transition Msg. The host fires it when the alarm comes
   * due; what it does is a function of the phase it lands in. Idempotent — a
   * duplicate or early fire is a no-op, which matters because an alarm can fire
   * twice across a cold wake.
   */
  tick: (state, msg) => {
    if (state.dueAt === null || msg.at < state.dueAt) return [state, []];
    const armed: State = { ...state, dueAt: null };

    if (state.phase === "paying") {
      const attempt = state.attempt + 1;
      return [
        note(
          { ...armed, attempt },
          msg.at,
          `retrying payment (attempt ${attempt})`,
        ),
        [
          {
            type: "charge",
            orderId: state.orderId,
            amountCents: state.amountCents,
            attempt,
          },
        ],
      ];
    }

    if (state.phase === "reserving") {
      return [
        note(armed, msg.at, "warehouse is answering…"),
        [{ type: "reserve_confirm", orderId: state.orderId }],
      ];
    }

    if (state.phase === "refunding") {
      const ref = state.paymentRef;
      if (ref === null) return [armed, []];
      return [
        note(armed, msg.at, "confirming the refund…"),
        [{ type: "refund_confirm", orderId: state.orderId, paymentRef: ref }],
      ];
    }

    return [armed, []];
  },

  /** The warehouse took the request. Its answer lands in RESERVE_WAIT_MS. */
  reserve_accepted: (state, msg) => {
    if (state.phase !== "reserving") return [state, []];
    const next: State = { ...state, dueAt: msg.at + RESERVE_WAIT_MS };
    return [
      note(
        next,
        msg.at,
        `reserving stock… (warehouse answers in ${RESERVE_WAIT_MS}ms)`,
      ),
      [],
    ];
  },

  reserve_ok: (state, msg) => {
    if (state.phase !== "reserving") return [state, []];
    return [
      note(
        { ...state, phase: "settled", dueAt: null },
        msg.at,
        "stock reserved — order settled",
      ),
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
          { ...state, phase: "failed", dueAt: null, failure: msg.reason },
          msg.at,
          `reservation failed (${msg.reason}) — nothing to refund`,
        ),
        [],
      ];
    }
    return [
      note(
        { ...state, phase: "refunding", dueAt: null, failure: msg.reason },
        msg.at,
        `reservation failed (${msg.reason}) — refunding ${ref}`,
      ),
      [{ type: "refund", orderId: state.orderId, paymentRef: ref }],
    ];
  },

  /** The refund is lodged. It clears in REFUND_WAIT_MS. */
  refund_accepted: (state, msg) => {
    if (state.phase !== "refunding") return [state, []];
    const next: State = { ...state, dueAt: msg.at + REFUND_WAIT_MS };
    return [
      note(next, msg.at, `refund submitted… (clears in ${REFUND_WAIT_MS}ms)`),
      [],
    ];
  },

  refund_ok: (state, msg) => {
    if (state.phase !== "refunding") return [state, []];
    return [
      note(
        { ...state, phase: "failed", dueAt: null, refunded: true },
        msg.at,
        "refund cleared — order failed cleanly, customer made whole",
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
          dueAt: null,
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
