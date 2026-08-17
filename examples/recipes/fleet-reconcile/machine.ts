/**
 * Recipe 5 — FLEET RECONCILE (one device).
 *
 * Use case: a device has a DESIRED config (set by an operator) and a REPORTED
 * config (whatever it last told us it is running). When the two differ, push the
 * desired config; when a push fails, back off and try again; when the device
 * reports back matching, converge and stop.
 *
 *   unknown → pushing → awaiting-report → converged
 *                    ↘ backoff ↗
 *
 * The durable insight: reconcile is a LOOP, and a loop that survives has to be
 * re-entrant from state alone. Nothing here remembers "I was halfway through a
 * push" in a stack frame — `desiredRev` / `inFlightRev` / `attempt` / `dueAt`
 * say it all, so any wake-up can recompute what is owed. That is also what makes
 * a mid-push config change safe: the operator bumps `desiredRev`, the in-flight
 * push's outcome arrives stamped with the OLD rev, and the reducer discards it
 * and re-pushes instead of converging on a config nobody wants any more.
 *
 * ── On reusing `@demlik/tea/reconciler` ─────────────────────────────────────
 * The reconciler battery is the right tool one level UP: it owns a paginated
 * scan of the whole actual world, a diff into a `Change[]` plan, and a TTL
 * applied-ledger so a resumed apply skips changes already made. Its unit of work
 * is a fleet-wide sweep. This recipe's unit of work is ONE device with one
 * config blob and no plan to page through, so embedding it would mean
 * configuring a scan with a single-page cursor to produce a one-element diff.
 * What DOES get reused is the backoff curve — `backoffDelay` from
 * `@demlik/tea/retry-backoff`, the same primitive the reconciler's own gate
 * uses, so the two agree on retry shape without sharing a lifecycle.
 */

import {
  defineMachine,
  type Interpret,
  type Reducer,
} from "../../../src/index";
import {
  backoffDelay,
  type RetryPolicy,
} from "../../../src/retry-backoff/index";

/** A config blob: flat, JSON, comparable by value. */
export type DeviceConfig = Readonly<Record<string, string | number | boolean>>;

export type Phase =
  | "unknown"
  | "pushing"
  | "awaiting-report"
  | "backoff"
  | "converged";

export interface State {
  readonly phase: Phase;
  readonly deviceId: string;
  readonly desired: DeviceConfig | null;
  readonly reported: DeviceConfig | null;
  /** Bumped every time the operator changes the target. Stamped onto each push. */
  readonly desiredRev: number;
  readonly inFlightRev: number | null;
  /** Consecutive push failures. Drives the backoff curve. */
  readonly attempt: number;
  readonly dueAt: number | null;
  readonly lastError: string | null;
}

export type Msg =
  | {
      readonly type: "set_desired";
      readonly deviceId: string;
      readonly config: DeviceConfig;
      readonly at: number;
    }
  | {
      readonly type: "reported";
      readonly config: DeviceConfig;
      readonly at: number;
    }
  | { readonly type: "push_ok"; readonly rev: number; readonly at: number }
  | {
      readonly type: "push_failed";
      readonly rev: number;
      readonly reason: string;
      readonly at: number;
    }
  | { readonly type: "tick"; readonly at: number };

export type Cmd = {
  readonly type: "push_config";
  readonly deviceId: string;
  readonly config: DeviceConfig;
  readonly rev: number;
};

export type Ctx = Record<string, never>;

export const pushRetryPolicy: RetryPolicy = {
  baseMs: 5_000,
  factor: 2,
  capMs: 10 * 60_000,
  maxAttempts: Number.MAX_SAFE_INTEGER,
  jitter: "none",
};

/** How long a device gets to report back before we assume the push was lost. */
export const REPORT_GRACE_MS = 60_000;

export function backoffMs(attempt: number): number {
  return backoffDelay(attempt - 1, pushRetryPolicy);
}

export function sameConfig(
  a: DeviceConfig | null,
  b: DeviceConfig | null,
): boolean {
  if (a === null || b === null) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => a[key] === b[key]);
}

export function initialState(): State {
  return {
    phase: "unknown",
    deviceId: "",
    desired: null,
    reported: null,
    desiredRev: 0,
    inFlightRev: null,
    attempt: 0,
    dueAt: null,
    lastError: null,
  };
}

/**
 * The loop body: given the facts, decide what is owed. Every entry point funnels
 * through here, which is exactly why a resumed machine behaves like one that
 * never died — "what next?" is a pure function of state.
 */
export function reconcile(
  state: State,
  at: number,
): readonly [State, readonly Cmd[]] {
  if (state.desired === null) return [{ ...state, dueAt: null }, []];

  if (sameConfig(state.desired, state.reported)) {
    return [
      {
        ...state,
        phase: "converged",
        inFlightRev: null,
        attempt: 0,
        dueAt: null,
        lastError: null,
      },
      [],
    ];
  }

  return [
    {
      ...state,
      phase: "pushing",
      inFlightRev: state.desiredRev,
      dueAt: at + REPORT_GRACE_MS,
    },
    [
      {
        type: "push_config",
        deviceId: state.deviceId,
        config: state.desired,
        rev: state.desiredRev,
      },
    ],
  ];
}

/** A push failed (or timed out). Charge an attempt and arm the backoff. */
function backOff(
  state: State,
  at: number,
  reason: string,
): readonly [State, readonly Cmd[]] {
  const attempt = state.attempt + 1;
  return [
    {
      ...state,
      phase: "backoff",
      inFlightRev: null,
      attempt,
      dueAt: at + backoffMs(attempt),
      lastError: reason,
    },
    [],
  ];
}

export const update: Reducer<State, Msg, Cmd> = {
  set_desired: (state, msg) => {
    // A new target resets the retry budget: this is a different push now.
    const next: State = {
      ...state,
      deviceId: msg.deviceId,
      desired: msg.config,
      desiredRev: state.desiredRev + 1,
      attempt: 0,
      lastError: null,
    };
    return reconcile(next, msg.at);
  },

  reported: (state, msg) => {
    const next: State = { ...state, reported: msg.config };
    // Matching report always wins, whatever phase we were in.
    if (sameConfig(next.desired, next.reported)) return reconcile(next, msg.at);
    // A mismatching report while a push is in flight or backing off changes
    // nothing — the work already scheduled is still the right work.
    if (next.phase === "pushing" || next.phase === "backoff") return [next, []];
    return reconcile(next, msg.at);
  },

  push_ok: (state, msg) => {
    if (state.phase !== "pushing") return [state, []];
    // The operator moved the target while this push was in the air.
    if (msg.rev !== state.desiredRev)
      return reconcile({ ...state, attempt: 0 }, msg.at);
    return [
      {
        ...state,
        phase: "awaiting-report",
        attempt: 0,
        lastError: null,
        dueAt: msg.at + REPORT_GRACE_MS,
      },
      [],
    ];
  },

  push_failed: (state, msg) => {
    if (state.phase !== "pushing") return [state, []];
    if (msg.rev !== state.desiredRev)
      return reconcile({ ...state, attempt: 0 }, msg.at);
    return backOff(state, msg.at, msg.reason);
  },

  tick: (state, msg) => {
    if (state.dueAt === null || msg.at < state.dueAt) return [state, []];
    if (state.phase === "backoff")
      return reconcile({ ...state, dueAt: null }, msg.at);
    // The device never reported. Treat silence as a failed push and back off —
    // otherwise a dropped push wedges the device forever.
    if (state.phase === "awaiting-report" || state.phase === "pushing") {
      return backOff(
        { ...state, dueAt: null },
        msg.at,
        "device did not report back",
      );
    }
    return [{ ...state, dueAt: null }, []];
  },
};

export function isConverged(state: State): boolean {
  return state.phase === "converged";
}

export function parseState(raw: unknown): State | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as Partial<State>;
  if (typeof candidate.phase !== "string") return null;
  if (typeof candidate.desiredRev !== "number") return null;
  if (typeof candidate.attempt !== "number") return null;
  return candidate as State;
}

export function fleetReconcileMachine(interpret: Interpret<Msg, Cmd, Ctx>) {
  return defineMachine<State, Msg, Cmd, never, Ctx>({
    init: (loaded) => [loaded ?? initialState(), []],
    update,
    interpret,
  });
}
