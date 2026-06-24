/**
 * `stepHost` — the HTTP-pull control carrier (#92), under simulated DO eviction.
 *
 * The load-bearing property: a `/step` POST settles the posted result
 * IDEMPOTENTLY, resumes the run from its DURABLE checkpoint, returns the next
 * step, and lets the DO hibernate — with NO warm state held between steps. The
 * tests rebuild the host from the durable checkpoint on EVERY step (cold wake),
 * so anything that survives a step does so because it was persisted, not because
 * it sat in the heap.
 *
 *   - wake → resume → hibernate: a sequence of cold `/step` POSTs advances the
 *     run correctly; each step's host is a fresh construction over the persisted
 *     checkpoint, never a warm loop.
 *   - re-POST idempotency: a duplicate `/step` (same `callId`) is absorbed once
 *     and returns the SAME next step (the side effect runs once).
 *   - capability token: valid passes; missing/wrong is rejected; the compare is
 *     constant-time-shaped (verdict independent of mismatch position).
 *   - runStepLoop: drives a fake `/step` to completion, surfaces the terminal
 *     output, and respects the absolute deadline.
 *
 * Globals are NOT enabled in vitest.config.ts — describe/it/expect are imported
 * explicitly, matching the rest of the package. fast-check's seed + numRuns are
 * pinned by `src/test-setup.ts`.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  constantTimeEqual,
  mintRunToken,
  type NextStep,
  runStepLoop,
  type StepCtx,
  type StepEngine,
  type StepRequest,
  type StepResponse,
  type StepResult,
  stepHost,
} from "./step-host";

// ─────────────────────────────────────────────────────────────────────────────
// A toy run: a fixed script of tools. The run is "at step `cursor`"; settling a
// result for the tool at `cursor` advances the cursor by one. When `cursor`
// reaches the script length the run is terminal, its output the concatenation
// of every result. This stands in for an agent's durable checkpoint.
// ─────────────────────────────────────────────────────────────────────────────

type ToolInput = { readonly arg: string };
type ToolResult = string;
type RunOutput = string;

const SCRIPT: readonly { tool: string; input: ToolInput }[] = [
  { tool: "alpha", input: { arg: "a" } },
  { tool: "beta", input: { arg: "b" } },
  { tool: "gamma", input: { arg: "c" } },
];

/**
 * The DURABLE checkpoint — the ONLY thing that survives an eviction. A plain
 * serializable record standing in for DO storage. `cursor` is how far the run
 * has advanced; `collected` is the results settled so far; `token` is the
 * persisted capability; `alarmAt` records the last `setAlarm`.
 */
interface Durable {
  cursor: number;
  collected: ToolResult[];
  token: string;
  alarmAt: number | null;
  /** Count of times `resume` actually ran the settle — the side-effect counter. */
  settleCount: number;
}

/** The callId for the step at `cursor` — stable, so a re-POST matches. */
function callIdFor(runId: string, cursor: number): string {
  return `${runId}:${cursor}`;
}

/**
 * Build a FRESH host over the durable checkpoint — a COLD WAKE. Each `/step`
 * POST calls this anew, so no warm state crosses steps. The `StepEngine` reads
 * and mutates ONLY `durable` (the persisted checkpoint); `resume` is the
 * idempotent settle that advances the cursor.
 */
function coldWake(
  durable: Durable,
): ReturnType<typeof stepHost<ToolResult, ToolInput, RunOutput>> {
  const ctx: StepCtx = {
    storage: {
      setAlarm(at) {
        durable.alarmAt = at;
      },
    },
  };

  const engine: StepEngine<ToolResult, ToolInput, RunOutput> = {
    tokenFor: () => durable.token,
    resume(_runId, posted) {
      // Settle: append the result and advance the cursor. Idempotent against the
      // durable checkpoint — settling the SAME cursor's result twice is guarded
      // by the intake dedupe, but we also assert the engine only ever sees a
      // first-time settle per callId via `settleCount`.
      durable.settleCount += 1;
      durable.collected.push(posted.result);
      durable.cursor += 1;
    },
    nextStep(runId): NextStep<ToolInput> | null {
      if (durable.cursor >= SCRIPT.length) return null;
      const entry = SCRIPT[durable.cursor];
      return {
        callId: callIdFor(runId, durable.cursor),
        tool: entry.tool,
        input: entry.input,
      };
    },
    terminalOutput: () => durable.collected.join("|"),
  };

  return stepHost<ToolResult, ToolInput, RunOutput>(ctx, engine);
}

function freshDurable(token: string): Durable {
  return { cursor: 0, collected: [], token, alarmAt: null, settleCount: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// wake → resume → hibernate round-trip
// ─────────────────────────────────────────────────────────────────────────────

describe("stepHost — wake → resume → hibernate", () => {
  it("advances the run across cold `/step` POSTs with no warm state between them", async () => {
    const runId = "run-1";
    const token = mintRunToken();
    const durable = freshDurable(token);
    let now = 1_000;

    // First request: no posted result yet — hand out the first step.
    const first = await coldWake(durable).handle(
      { token, runId, posted: null },
      now,
    );
    expect(first.status).toBe(200);
    if (first.status !== 200 || first.body.done)
      throw new Error("expected step");
    expect(first.body.step.tool).toBe("alpha");
    expect(durable.alarmAt).toBe(now + 5 * 60_000); // alarm re-armed
    expect(durable.settleCount).toBe(0); // nothing settled on the first ask

    // Walk the rest of the script: each iteration is a SEPARATE cold wake.
    let pending = first.body.step;
    const outputs: string[] = [];
    for (let i = 0; i < SCRIPT.length; i++) {
      now += 100;
      const result = `${pending.tool}!`;
      const posted: StepResult<ToolResult> = {
        callId: pending.callId,
        result,
      };
      const resp = await coldWake(durable).handle(
        { token, runId, posted },
        now,
      );
      expect(resp.status).toBe(200);
      if (resp.status !== 200) throw new Error("unexpected status");
      if (resp.body.done) {
        outputs.push(resp.body.output);
        break;
      }
      pending = resp.body.step;
    }

    // The run advanced to terminal; the output is every settled result joined.
    expect(durable.cursor).toBe(SCRIPT.length);
    expect(durable.settleCount).toBe(SCRIPT.length);
    expect(outputs).toEqual(["alpha!|beta!|gamma!"]);
    // The alarm was re-armed on the LAST step too — a give-up deadline survives
    // an eviction regardless of whether more steps ever come.
    expect(durable.alarmAt).toBe(now + 5 * 60_000);
  });

  it("absorbs a re-POSTed result exactly once and returns the SAME next step", async () => {
    const runId = "run-dup";
    const token = mintRunToken();
    const durable = freshDurable(token);

    // Get the first step, then settle it.
    const firstResp = await coldWake(durable).handle(
      { token, runId, posted: null },
      0,
    );
    if (firstResp.status !== 200 || firstResp.body.done)
      throw new Error("expected step");
    const step0 = firstResp.body.step;
    const posted: StepResult<ToolResult> = {
      callId: step0.callId,
      result: "X",
    };

    // POST the result — advances cursor to 1, hands out step 1.
    const settledHost = coldWake(durable);
    const a = await settledHost.handle({ token, runId, posted }, 10);
    if (a.status !== 200 || a.body.done) throw new Error("expected step");
    expect(durable.cursor).toBe(1);
    expect(durable.settleCount).toBe(1);
    const nextAfterFirst = a.body.step;

    // RE-POST the SAME result on the SAME host (within-activation duplicate).
    const b = await settledHost.handle({ token, runId, posted }, 11);
    if (b.status !== 200 || b.body.done) throw new Error("expected step");
    // Idempotent: the cursor did NOT advance again, the side effect did NOT
    // re-run, and the SAME next step is returned.
    expect(durable.cursor).toBe(1);
    expect(durable.settleCount).toBe(1);
    expect(b.body.step).toEqual(nextAfterFirst);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// capability token
// ─────────────────────────────────────────────────────────────────────────────

describe("stepHost — capability token", () => {
  it("accepts a valid token, rejects a missing run (404) and a wrong token (401)", async () => {
    const runId = "run-tok";
    const token = mintRunToken();
    const durable = freshDurable(token);

    // Valid token → 200.
    const ok = await coldWake(durable).handle(
      { token, runId, posted: null },
      0,
    );
    expect(ok.status).toBe(200);

    // Wrong token → 401, and the run is NOT advanced.
    const wrong = await coldWake(durable).handle(
      { token: mintRunToken(), runId, posted: null },
      0,
    );
    expect(wrong.status).toBe(401);

    // Unknown run (engine returns null token) → 404.
    const unknownEngine: StepEngine<ToolResult, ToolInput, RunOutput> = {
      tokenFor: () => null,
      resume: () => {},
      nextStep: () => null,
      terminalOutput: () => "",
    };
    const missing = await stepHost<ToolResult, ToolInput, RunOutput>(
      { storage: { setAlarm() {} } },
      unknownEngine,
    ).handle({ token, runId, posted: null }, 0);
    expect(missing.status).toBe(404);
  });

  it("constantTimeEqual is a true equality and its verdict is independent of mismatch position", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "ab")).toBe(false); // length mismatch
    expect(constantTimeEqual("", "")).toBe(true);

    // Property: it agrees with `===` on every pair (correctness), and the
    // mismatch POSITION never changes the verdict for equal-length strings — a
    // mismatch at index 0 and a mismatch at the last index both return false.
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        expect(constantTimeEqual(a, b)).toBe(a === b);
      }),
    );
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.integer({ min: 0 }),
        (s, rawIdx) => {
          const idx = rawIdx % s.length;
          // Flip one char at `idx` — different position, same false verdict.
          const flipped =
            s.slice(0, idx) +
            String.fromCharCode(s.charCodeAt(idx) ^ 1) +
            s.slice(idx + 1);
          expect(constantTimeEqual(s, flipped)).toBe(false);
        },
      ),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runStepLoop — the hands-side pull loop
// ─────────────────────────────────────────────────────────────────────────────

describe("runStepLoop", () => {
  it("drives a fake `/step` endpoint to completion and surfaces the terminal output", async () => {
    const runId = "loop-1";
    const token = mintRunToken();
    const durable = freshDurable(token);

    // The transport is a FRESH cold-wake host per POST — exactly the production
    // shape (each request hits a possibly-evicted DO).
    const transport = (req: StepRequest<ToolResult>) =>
      coldWake(durable)
        .handle(req, 0)
        .then((outcome) => {
          if (outcome.status !== 200) throw new Error(`HTTP ${outcome.status}`);
          return outcome.body as StepResponse<ToolInput, RunOutput>;
        });

    const executed: string[] = [];
    const outcome = await runStepLoop<ToolResult, ToolInput, RunOutput>(
      token,
      runId,
      transport,
      (step) => {
        executed.push(step.tool);
        return `${step.tool}!`;
      },
      { deadlineMs: Number.POSITIVE_INFINITY, now: () => 0 },
    );

    expect(outcome.kind).toBe("done");
    if (outcome.kind !== "done") throw new Error("expected done");
    expect(outcome.output).toBe("alpha!|beta!|gamma!");
    expect(executed).toEqual(["alpha", "beta", "gamma"]);
  });

  it("respects the absolute deadline and stops asking", async () => {
    const token = mintRunToken();
    // A transport that would loop forever (always hands out a step).
    const endless: typeof neverDoneTransport = neverDoneTransport;

    let clock = 0;
    const outcome = await runStepLoop<ToolResult, ToolInput, RunOutput>(
      token,
      "loop-deadline",
      endless,
      (step) => `${step.tool}!`,
      {
        deadlineMs: 50,
        // The clock advances past the deadline after the first POST.
        now: () => {
          const t = clock;
          clock += 100;
          return t;
        },
      },
    );

    expect(outcome.kind).toBe("deadline_exceeded");
  });

  it("backs off on transport failure and eventually gives up", async () => {
    const token = mintRunToken();
    let calls = 0;
    const alwaysFails = (): Promise<StepResponse<ToolInput, RunOutput>> => {
      calls += 1;
      return Promise.reject(new Error("boom"));
    };
    const sleeps: number[] = [];

    const outcome = await runStepLoop<ToolResult, ToolInput, RunOutput>(
      token,
      "loop-fail",
      alwaysFails,
      (step) => `${step.tool}!`,
      {
        deadlineMs: Number.POSITIVE_INFINITY,
        now: () => 0,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
        retry: {
          baseMs: 1,
          factor: 2,
          capMs: 10,
          maxAttempts: 3,
          jitter: "none",
        },
      },
    );

    expect(outcome.kind).toBe("gave_up");
    // maxAttempts: 3 → 3 failures recorded, the 3rd stops; 2 backoff sleeps.
    // `recordFailure` runs BEFORE `nextDelayMs`, so the delays use attempt
    // indices 1 then 2: baseMs*factor^1 = 2, baseMs*factor^2 = 4 (no jitter).
    expect(calls).toBe(3);
    expect(sleeps).toEqual([2, 4]);
  });
});

// A transport that never reaches a terminal state — always hands out a step.
function neverDoneTransport(): Promise<StepResponse<ToolInput, RunOutput>> {
  return Promise.resolve({
    done: false,
    step: { callId: "x", tool: "alpha", input: { arg: "a" } },
  });
}
