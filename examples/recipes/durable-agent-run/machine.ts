/**
 * Recipe 1 — DURABLE AGENT RUN.
 *
 * Use case: an AI agent works a goal over several provider calls. It has a
 * spend cap, its provider is flaky, and some steps need a human to say yes
 * before the agent may act.
 *
 *   running → awaiting-approval → running → done | failed
 *
 * The durable insight: BOTH waits are the same shape — a fact written into
 * state, not a stack frame.
 *
 *   - The retry wait is `nextRetryAt`: a number. Kill the process mid-backoff
 *     and the retry still happens, because "attempt 3 is owed at T" is state.
 *   - The approval wait has NO timer at all. `pendingApproval` is set and
 *     nothing is scheduled. The run resumes only when an `approval_granted`
 *     Msg arrives — which may be four days and eleven redeploys later. A
 *     process holding a promise cannot wait four days. A row can.
 *
 * The budget is the third piece of visible state: `spentUsd` accumulates in
 * the reducer, so the cap is enforced by a pure function of the ledger rather
 * than by whatever the last isolate happened to remember.
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

export type Phase =
  | "idle"
  | "running"
  | "awaiting-approval"
  | "done"
  | "failed";

/** What the model proposed to do, waiting on a human. */
export interface PendingApproval {
  readonly step: number;
  readonly action: string;
  readonly askedAt: number;
}

export interface State {
  readonly phase: Phase;
  readonly runId: string;
  readonly goal: string;
  /** Steps COMPLETED. The step in flight is `step + 1`. */
  readonly step: number;
  readonly maxSteps: number;
  /** The ledger. Enforcing the cap is a pure read of this number. */
  readonly spentUsd: number;
  readonly budgetUsd: number;
  /** Provider attempts for the step in flight. Visible, so a resume resumes. */
  readonly attempt: number;
  /** When the next provider retry is owed, or null when nothing is scheduled. */
  readonly nextRetryAt: number | null;
  readonly pendingApproval: PendingApproval | null;
  readonly transcript: readonly string[];
  readonly failure: string | null;
}

export type Msg =
  | {
      readonly type: "start";
      readonly runId: string;
      readonly goal: string;
      readonly at: number;
    }
  | {
      readonly type: "step_ok";
      readonly output: string;
      readonly costUsd: number;
      /** Non-null when the model wants to take an action a human must bless. */
      readonly needsApproval: string | null;
      readonly at: number;
    }
  | {
      readonly type: "step_failed";
      readonly reason: string;
      readonly at: number;
    }
  /** The retry alarm came due. Idempotent — an early or duplicate fire is a no-op. */
  | { readonly type: "tick"; readonly at: number }
  | {
      readonly type: "approval_granted";
      readonly by: string;
      readonly at: number;
    }
  | {
      readonly type: "approval_denied";
      readonly by: string;
      readonly reason: string;
      readonly at: number;
    };

export type Cmd = {
  readonly type: "call_provider";
  readonly runId: string;
  readonly goal: string;
  readonly step: number;
  /** Carried in the Cmd, read off State — never a module-level counter. */
  readonly attempt: number;
};

export type Ctx = Record<string, never>;

export const providerRetryPolicy: RetryPolicy = {
  baseMs: 2_000,
  factor: 2,
  capMs: 60_000,
  maxAttempts: 4,
  jitter: "none",
};

/** Delay before retrying after `attempt` (1-based) has failed. PURE. */
export function retryDelayMs(attempt: number): number {
  return backoffDelay(attempt - 1, providerRetryPolicy);
}

export function initialState(): State {
  return {
    phase: "idle",
    runId: "",
    goal: "",
    step: 0,
    maxSteps: 3,
    spentUsd: 0,
    budgetUsd: 1,
    attempt: 0,
    nextRetryAt: null,
    pendingApproval: null,
    transcript: [],
    failure: null,
  };
}

function say(state: State, text: string): State {
  return { ...state, transcript: [...state.transcript, text] };
}

/** Ask the provider for step N. One place mints the Cmd. */
function callStep(
  state: State,
  step: number,
  attempt: number,
): readonly [State, readonly Cmd[]] {
  return [
    { ...state, phase: "running", attempt, nextRetryAt: null },
    [
      {
        type: "call_provider",
        runId: state.runId,
        goal: state.goal,
        step,
        attempt,
      },
    ],
  ];
}

export const update: Reducer<State, Msg, Cmd> = {
  start: (state, msg) => {
    const fresh: State = {
      ...initialState(),
      maxSteps: state.maxSteps,
      budgetUsd: state.budgetUsd,
      runId: msg.runId,
      goal: msg.goal,
    };
    return callStep(say(fresh, `run ${msg.runId} started: ${msg.goal}`), 1, 1);
  },

  step_ok: (state, msg) => {
    if (state.phase !== "running") return [state, []];
    const spentUsd = state.spentUsd + msg.costUsd;
    const charged = say({ ...state, spentUsd, nextRetryAt: null }, msg.output);

    // The cap is checked AFTER the spend is recorded: the ledger tells the
    // truth even when the run dies here.
    if (spentUsd > state.budgetUsd) {
      const failure = `budget exceeded: $${spentUsd.toFixed(2)} of $${state.budgetUsd.toFixed(2)}`;
      return [
        say({ ...charged, phase: "failed", attempt: 0, failure }, failure),
        [],
      ];
    }

    if (msg.needsApproval !== null) {
      const pendingApproval: PendingApproval = {
        step: state.step + 1,
        action: msg.needsApproval,
        askedAt: msg.at,
      };
      // No dueAt. Nothing is scheduled. The run simply stops until a human
      // dispatches `approval_granted` — days later, on a different isolate.
      return [
        say(
          {
            ...charged,
            phase: "awaiting-approval",
            attempt: 0,
            pendingApproval,
          },
          `awaiting approval: ${msg.needsApproval}`,
        ),
        [],
      ];
    }

    return advance(charged, state.step + 1);
  },

  step_failed: (state, msg) => {
    if (state.phase !== "running") return [state, []];
    if (state.attempt >= providerRetryPolicy.maxAttempts) {
      const failure = `provider gave up after ${state.attempt}: ${msg.reason}`;
      return [
        say({ ...state, phase: "failed", nextRetryAt: null, failure }, failure),
        [],
      ];
    }
    const delay = retryDelayMs(state.attempt);
    return [
      say(
        { ...state, nextRetryAt: msg.at + delay },
        `attempt ${state.attempt} failed (${msg.reason}) — retry in ${delay}ms`,
      ),
      [],
    ];
  },

  tick: (state, msg) => {
    if (state.nextRetryAt === null || msg.at < state.nextRetryAt)
      return [state, []];
    if (state.phase !== "running") return [{ ...state, nextRetryAt: null }, []];
    const attempt = state.attempt + 1;
    return callStep(
      say(state, `retrying step ${state.step + 1} (attempt ${attempt})`),
      state.step + 1,
      attempt,
    );
  },

  approval_granted: (state, msg) => {
    if (state.phase !== "awaiting-approval" || state.pendingApproval === null)
      return [state, []];
    const approved = say(
      { ...state, pendingApproval: null },
      `${msg.by} approved "${state.pendingApproval.action}" after ${msg.at - state.pendingApproval.askedAt}ms`,
    );
    return advance(approved, state.pendingApproval.step);
  },

  approval_denied: (state, msg) => {
    if (state.phase !== "awaiting-approval") return [state, []];
    const failure = `${msg.by} denied the step: ${msg.reason}`;
    return [
      say(
        {
          ...state,
          phase: "failed",
          pendingApproval: null,
          attempt: 0,
          failure,
        },
        failure,
      ),
      [],
    ];
  },
};

/** Step `completed` landed. Either the goal is met, or the next call goes out. */
function advance(
  state: State,
  completed: number,
): readonly [State, readonly Cmd[]] {
  const next: State = { ...state, step: completed };
  if (completed >= state.maxSteps) {
    return [
      say(
        { ...next, phase: "done", attempt: 0, nextRetryAt: null },
        "run complete",
      ),
      [],
    ];
  }
  return callStep(next, completed + 1, 1);
}

export function isTerminal(state: State): boolean {
  return state.phase === "done" || state.phase === "failed";
}

/** Boundary parse for the store. Returns null (boot fresh) on a shape mismatch. */
export function parseState(raw: unknown): State | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as Partial<State>;
  if (typeof candidate.phase !== "string") return null;
  if (typeof candidate.spentUsd !== "number") return null;
  if (!Array.isArray(candidate.transcript)) return null;
  return candidate as State;
}

export function agentRunMachine(
  interpret: Interpret<Msg, Cmd, Ctx>,
  overrides: Partial<Pick<State, "maxSteps" | "budgetUsd">> = {},
) {
  return defineMachine<State, Msg, Cmd, never, Ctx>({
    init: (loaded) => [loaded ?? { ...initialState(), ...overrides }, []],
    update,
    interpret,
  });
}
