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
import { durableTimer } from "./durable-timer";
import {
  type AlarmStorage,
  constantTimeEqual,
  type DeferResumeHook,
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

/** The script entry at `cursor`; a cursor past the script has no step to hand out. */
function entryAt(cursor: number): (typeof SCRIPT)[number] {
  const entry = SCRIPT[cursor];
  if (entry === undefined) throw new Error(`no script entry at ${cursor}`);
  return entry;
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
      const entry = entryAt(durable.cursor);
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

  it("gives up at once on a failure `retryable` refuses, without a backoff sleep for it", async () => {
    const fatal = new Error("401");
    let calls = 0;
    const transport = (): Promise<StepResponse<ToolInput, RunOutput>> => {
      calls += 1;
      return Promise.reject(calls === 1 ? new Error("flaky") : fatal);
    };
    const sleeps: number[] = [];

    const outcome = await runStepLoop<ToolResult, ToolInput, RunOutput>(
      mintRunToken(),
      "loop-fatal",
      transport,
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
          maxAttempts: 9,
          jitter: "none",
        },
        retryable: (error) => error !== fatal,
      },
    );

    expect(outcome).toEqual({ kind: "gave_up", error: fatal });
    expect(calls).toBe(2);
    expect(sleeps).toEqual([2]);
  });

  it("gives up when a duration bound runs out, measured on now() from the first failure", async () => {
    let clock = 0;
    let calls = 0;
    const transport = (): Promise<StepResponse<ToolInput, RunOutput>> => {
      calls += 1;
      return Promise.reject(new Error("down"));
    };

    const outcome = await runStepLoop<ToolResult, ToolInput, RunOutput>(
      mintRunToken(),
      "loop-outage",
      transport,
      (step) => `${step.tool}!`,
      {
        deadlineMs: Number.POSITIVE_INFINITY,
        now: () => clock,
        sleep: async (ms) => {
          if (calls > 50) throw new Error("runaway retry");
          clock += ms;
        },
        retry: {
          baseMs: 10,
          factor: 1,
          capMs: 10,
          maxElapsedMs: 35,
          jitter: "none",
        },
      },
    );

    expect(outcome.kind).toBe("gave_up");
    expect(calls).toBe(5);
    expect(clock).toBe(40);
  });

  it("reads the clock once for a failed POST, as it did before a duration bound", async () => {
    let reads = 0;
    let calls = 0;
    const flaky = (): Promise<StepResponse<ToolInput, RunOutput>> => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error("down"))
        : Promise.resolve({ done: true, output: "ok" });
    };

    const outcome = await runStepLoop<ToolResult, ToolInput, RunOutput>(
      mintRunToken(),
      "loop-clock",
      flaky,
      (step) => `${step.tool}!`,
      {
        deadlineMs: Number.POSITIVE_INFINITY,
        now: () => {
          reads += 1;
          return 0;
        },
        sleep: async () => {},
      },
    );

    expect(outcome.kind).toBe("done");
    expect(calls).toBe(2);
    expect(reads).toBe(2);
  });

  it("stops at the deadline a failed POST runs into, with no backoff sleep", async () => {
    const clock = [0, 150];
    const sleeps: number[] = [];
    const down = (): Promise<StepResponse<ToolInput, RunOutput>> =>
      Promise.reject(new Error("down"));

    const outcome = await runStepLoop<ToolResult, ToolInput, RunOutput>(
      mintRunToken(),
      "loop-late",
      down,
      (step) => `${step.tool}!`,
      {
        deadlineMs: 100,
        now: () => clock.shift() ?? 150,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );

    expect(outcome).toEqual({ kind: "deadline_exceeded" });
    expect(sleeps).toEqual([100]);
  });
});

// A transport that never reaches a terminal state — always hands out a step.
function neverDoneTransport(): Promise<StepResponse<ToolInput, RunOutput>> {
  return Promise.resolve({
    done: false,
    step: { callId: "x", tool: "alpha", input: { arg: "a" } },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// defer-resume working arm — the behavioral tracer on a REAL host, end to end
//
// A NON-BLOCKING host cannot resolve a step inside the held request. It adopts
// the defer-resume hook: a `/step` POST ENQUEUES the resume to run out-of-band
// and returns the WORKING (not-ready) arm immediately; a returning activation
// runs the compute and lands it in the durable checkpoint; a subsequent pull
// reads the next step, then done. This drives that full round-trip on a real
// cold-wake host — NOT a per-unit mock of the arm — and proves the held request
// never inline-awaits the step compute (the engine's inline `resume` throws if
// the defer path ever calls it).
// ─────────────────────────────────────────────────────────────────────────────

describe("stepHost — defer-resume working arm (real host, end to end)", () => {
  it("pull returns working-not-ready; the deferred compute lands in the durable next-step; a later pull returns the step, then done", async () => {
    const runId = "run-defer";
    const token = mintRunToken();
    const durable = freshDurable(token);
    // Out-of-band defer state — ALSO durable (survives a cold wake): the
    // enqueued-but-unrun resumes, and the callIds whose resume has LANDED.
    const pending = new Map<string, StepResult<ToolResult>>();
    const settledIds = new Set<string>();

    // The settle the RETURNING ACTIVATION runs — the SAME cursor advance the
    // inline `resume` does, but driven out-of-band, not by the held request.
    const applySettle = (posted: StepResult<ToolResult>) => {
      durable.settleCount += 1;
      durable.collected.push(posted.result);
      durable.cursor += 1;
      settledIds.add(posted.callId);
    };

    // A COLD-WAKE defer host: a fresh `stepHost` per pull over the shared durable
    // + defer state, wired with the defer-resume hook. The engine's inline
    // `resume` THROWS — proving the defer path never inline-runs the compute.
    const coldWakeDefer = () => {
      const ctx: StepCtx = {
        storage: {
          setAlarm(at) {
            durable.alarmAt = at;
          },
        },
      };
      const engine: StepEngine<ToolResult, ToolInput, RunOutput> = {
        tokenFor: () => durable.token,
        resume: () => {
          throw new Error("inline resume must not run on the defer path");
        },
        nextStep(rid): NextStep<ToolInput> | null {
          if (durable.cursor >= SCRIPT.length) return null;
          const entry = entryAt(durable.cursor);
          return {
            callId: callIdFor(rid, durable.cursor),
            tool: entry.tool,
            input: entry.input,
          };
        },
        terminalOutput: () => durable.collected.join("|"),
      };
      const deferResume: DeferResumeHook<ToolResult> = {
        // Settle-and-enqueue: record the resume to run out-of-band. Idempotent —
        // a re-POST of a callId already settled or already queued is a no-op.
        enqueue(_rid, posted) {
          if (!settledIds.has(posted.callId))
            pending.set(posted.callId, posted);
        },
        settled: (_rid, callId) => settledIds.has(callId),
        retryAfterMs: 250,
      };
      return stepHost<ToolResult, ToolInput, RunOutput>(ctx, engine, {
        deferResume,
      });
    };

    // The RETURNING ACTIVATION — drains the out-of-band inbox, running the settle
    // that lands each resume in the durable checkpoint.
    const drainOutOfBand = () => {
      for (const [callId, posted] of pending) {
        applySettle(posted);
        pending.delete(callId);
      }
    };

    let now = 1_000;

    // Pull 1 — first request (posted null): hand out the first step, no settle.
    const first = await coldWakeDefer().handle(
      { token, runId, posted: null },
      now,
    );
    expect(first.status).toBe(200);
    if (first.status !== 200 || first.body.done || "working" in first.body)
      throw new Error("expected the first step");
    const step0 = first.body.step;
    expect(step0.tool).toBe("alpha");
    const posted0: StepResult<ToolResult> = {
      callId: step0.callId,
      result: "A",
    };

    // Pull 2 — posts step0's result. The host DEFERS: it enqueues the resume and
    // returns WORKING-NOT-READY. The held request did NOT advance the checkpoint.
    now += 100;
    const working = await coldWakeDefer().handle(
      { token, runId, posted: posted0 },
      now,
    );
    expect(working.status).toBe(200);
    if (working.status !== 200 || !("working" in working.body))
      throw new Error("expected the working arm");
    expect(working.body.working).toBe(true);
    expect(working.body.retryAfterMs).toBe(250);
    // PROOF the compute did NOT run inline: cursor unchanged, nothing settled,
    // and the resume is sitting in the out-of-band inbox.
    expect(durable.cursor).toBe(0);
    expect(durable.settleCount).toBe(0);
    expect(pending.has(step0.callId)).toBe(true);

    // A re-poll BEFORE the out-of-band compute lands is STILL working (idempotent
    // enqueue — no double settle, cursor still 0).
    now += 100;
    const stillWorking = await coldWakeDefer().handle(
      { token, runId, posted: posted0 },
      now,
    );
    if (stillWorking.status !== 200 || !("working" in stillWorking.body))
      throw new Error("expected still-working");
    expect(durable.cursor).toBe(0);

    // OUT-OF-BAND: the returning activation runs the deferred compute — it lands
    // in the durable next-step (cursor advances, result collected).
    drainOutOfBand();
    expect(durable.cursor).toBe(1);
    expect(durable.settleCount).toBe(1);

    // Pull 3 — re-posts the SAME result. Now settled ⇒ the host reads the NEXT
    // step off the advanced checkpoint (no re-settle).
    now += 100;
    const afterReady = await coldWakeDefer().handle(
      { token, runId, posted: posted0 },
      now,
    );
    if (
      afterReady.status !== 200 ||
      afterReady.body.done ||
      "working" in afterReady.body
    )
      throw new Error("expected the next step");
    expect(afterReady.body.step.tool).toBe("beta");
    expect(durable.settleCount).toBe(1); // no double settle on the re-post

    // Drive the remaining steps the same working → drain → step round-trip to
    // terminal, proving the full arc lands `done` with the collected output.
    let pending2 = afterReady.body.step;
    let output: string | null = null;
    for (let i = 1; i < SCRIPT.length; i++) {
      const posted: StepResult<ToolResult> = {
        callId: pending2.callId,
        result: pending2.tool.charAt(0).toUpperCase(),
      };
      now += 100;
      const w = await coldWakeDefer().handle({ token, runId, posted }, now);
      if (w.status !== 200 || !("working" in w.body))
        throw new Error("expected working before drain");
      drainOutOfBand();
      now += 100;
      const r = await coldWakeDefer().handle({ token, runId, posted }, now);
      if (r.status !== 200) throw new Error("unexpected status");
      if (r.body.done) {
        output = r.body.output;
        break;
      }
      if ("working" in r.body) throw new Error("should be ready after drain");
      pending2 = r.body.step;
    }

    expect(output).toBe("A|B|G");
    expect(durable.cursor).toBe(SCRIPT.length);
    expect(durable.settleCount).toBe(SCRIPT.length);
  });

  it("runStepLoop drives a defer host end to end — re-polling the working arm until each step is ready", async () => {
    const runId = "loop-defer";
    const token = mintRunToken();
    const durable = freshDurable(token);
    const pending = new Map<string, StepResult<ToolResult>>();
    const settledIds = new Set<string>();

    // Cold-wake defer host, same shape as above. Here the out-of-band compute is
    // driven synchronously by the `settled` probe: the first probe for a callId
    // records it as "in flight"; the second probe reports it ready — modelling a
    // returning activation that completes between two polls. This lets the loop
    // observe a real working → ready transition without an external scheduler.
    const inFlight = new Set<string>();
    const coldWakeDefer = () => {
      const ctx: StepCtx = { storage: { setAlarm() {} } };
      const engine: StepEngine<ToolResult, ToolInput, RunOutput> = {
        tokenFor: () => durable.token,
        resume: () => {
          throw new Error("inline resume must not run on the defer path");
        },
        nextStep(rid): NextStep<ToolInput> | null {
          if (durable.cursor >= SCRIPT.length) return null;
          const entry = entryAt(durable.cursor);
          return {
            callId: callIdFor(rid, durable.cursor),
            tool: entry.tool,
            input: entry.input,
          };
        },
        terminalOutput: () => durable.collected.join("|"),
      };
      const deferResume: DeferResumeHook<ToolResult> = {
        enqueue(_rid, posted) {
          if (!settledIds.has(posted.callId))
            pending.set(posted.callId, posted);
        },
        settled(_rid, callId) {
          if (settledIds.has(callId)) return true;
          // Second sighting → the returning activation has completed: land it.
          if (inFlight.has(callId)) {
            const posted = pending.get(callId);
            if (posted) {
              durable.settleCount += 1;
              durable.collected.push(posted.result);
              durable.cursor += 1;
              settledIds.add(callId);
              pending.delete(callId);
              inFlight.delete(callId);
            }
            return true;
          }
          inFlight.add(callId);
          return false; // first sighting → still working
        },
      };
      return stepHost<ToolResult, ToolInput, RunOutput>(ctx, engine, {
        deferResume,
      });
    };

    const transport = (req: StepRequest<ToolResult>) =>
      coldWakeDefer()
        .handle(req, 0)
        .then((outcome) => {
          if (outcome.status !== 200) throw new Error(`HTTP ${outcome.status}`);
          return outcome.body;
        });

    const executed: string[] = [];
    const outcome = await runStepLoop<ToolResult, ToolInput, RunOutput>(
      token,
      runId,
      transport,
      (step) => {
        executed.push(step.tool);
        return step.tool.charAt(0).toUpperCase();
      },
      {
        deadlineMs: Number.POSITIVE_INFINITY,
        now: () => 0,
        sleep: () => Promise.resolve(),
      },
    );

    expect(outcome.kind).toBe("done");
    if (outcome.kind !== "done") throw new Error("expected done");
    expect(outcome.output).toBe("A|B|G");
    expect(executed).toEqual(["alpha", "beta", "gamma"]);
    expect(durable.cursor).toBe(SCRIPT.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// beforeResume — the admission hook that runs before any resume work
//
// A host that must refuse more work for a run (a stop it persisted) answers the
// pull itself: after the token is accepted and the alarm re-armed, and before
// the settle, the deferred enqueue, or the next-step read. These tests pin the
// ORDER and the short-circuit with a trace of every engine and hook call.
// ─────────────────────────────────────────────────────────────────────────────

type Admission = Extract<
  StepResponse<ToolInput, RunOutput>,
  { readonly done: true }
>;
type Hook = (runId: string) => Promise<Admission | null> | Admission | null;

const STOPPED: Admission = { done: true, output: "stopped" };

function admissionRig(deferred: boolean, beforeResume?: Hook) {
  const runId = "run-admit";
  const durable = freshDurable(mintRunToken());
  const trace: string[] = [];
  const ctx: StepCtx = {
    storage: {
      setAlarm(at) {
        trace.push("setAlarm");
        durable.alarmAt = at;
      },
    },
  };
  const engine: StepEngine<ToolResult, ToolInput, RunOutput> = {
    tokenFor: () => durable.token,
    resume(_runId, posted) {
      trace.push("resume");
      durable.settleCount += 1;
      durable.collected.push(posted.result);
      durable.cursor += 1;
    },
    nextStep(rid): NextStep<ToolInput> | null {
      trace.push("nextStep");
      if (durable.cursor >= SCRIPT.length) return null;
      const entry = entryAt(durable.cursor);
      return {
        callId: callIdFor(rid, durable.cursor),
        tool: entry.tool,
        input: entry.input,
      };
    },
    terminalOutput() {
      trace.push("terminalOutput");
      return durable.collected.join("|");
    },
    ...(beforeResume === undefined
      ? {}
      : {
          beforeResume(rid: string) {
            trace.push("beforeResume");
            return beforeResume(rid);
          },
        }),
  };
  const deferResume: DeferResumeHook<ToolResult> = {
    settled() {
      trace.push("settled");
      return false;
    },
    enqueue() {
      trace.push("enqueue");
    },
  };
  const host = deferred
    ? stepHost<ToolResult, ToolInput, RunOutput>(ctx, engine, { deferResume })
    : stepHost<ToolResult, ToolInput, RunOutput>(ctx, engine);
  const request = (
    posted: StepResult<ToolResult> | null,
  ): StepRequest<ToolResult> => ({
    token: durable.token,
    runId,
    posted,
  });
  return { host, durable, trace, request, runId };
}

const POSTED: StepResult<ToolResult> = { callId: "run-admit:0", result: "A" };

describe.each([
  ["inline", false],
  ["deferred", true],
] as const)("stepHost beforeResume — %s host", (_mode, deferred) => {
  it("answers a terminal response before intake, resume, readiness, enqueue, step read and output read", async () => {
    const rig = admissionRig(deferred, () => STOPPED);

    const outcome = await rig.host.handle(rig.request(POSTED), 1_000);

    expect(outcome).toEqual({ status: 200, body: STOPPED });
    expect(rig.trace).toEqual(["setAlarm", "beforeResume"]);
    expect(rig.durable.alarmAt).toBe(1_000 + 5 * 60_000);
    expect(rig.durable.settleCount).toBe(0);
  });

  it("runs for a first pull with nothing posted", async () => {
    const rig = admissionRig(deferred, () => STOPPED);

    const outcome = await rig.host.handle(rig.request(null), 0);

    expect(outcome).toEqual({ status: 200, body: STOPPED });
    expect(rig.trace).toEqual(["setAlarm", "beforeResume"]);
  });

  it("runs on every duplicate request and never resumes", async () => {
    const rig = admissionRig(deferred, () => STOPPED);

    for (let duplicate = 0; duplicate < 3; duplicate++) {
      const outcome = await rig.host.handle(rig.request(POSTED), duplicate);
      expect(outcome).toEqual({ status: 200, body: STOPPED });
    }

    expect(rig.trace.filter((call) => call === "beforeResume")).toHaveLength(3);
    expect(rig.trace).not.toContain("resume");
    expect(rig.trace).not.toContain("enqueue");
    expect(rig.durable.settleCount).toBe(0);
  });

  it("awaits an async hook", async () => {
    const rig = admissionRig(deferred, async () => {
      await Promise.resolve();
      return STOPPED;
    });

    const outcome = await rig.host.handle(rig.request(POSTED), 0);

    expect(outcome).toEqual({ status: 200, body: STOPPED });
    expect(rig.trace).toEqual(["setAlarm", "beforeResume"]);
  });

  it("continues exactly as it did without a hook when the hook answers null", async () => {
    const withHook = admissionRig(deferred, async () => null);
    const without = admissionRig(deferred);

    const a = await withHook.host.handle(withHook.request(POSTED), 0);
    const b = await without.host.handle(without.request(POSTED), 0);

    expect(a).toEqual(b);
    expect(withHook.trace.filter((call) => call !== "beforeResume")).toEqual(
      without.trace,
    );
    expect(withHook.trace.slice(0, 2)).toEqual(["setAlarm", "beforeResume"]);
  });

  it.each([
    [
      "throws",
      () => {
        throw new Error("hook failed");
      },
    ],
    ["rejects", () => Promise.reject(new Error("hook failed"))],
  ] as const)("a hook that %s propagates before intake is touched", async (_how, failing) => {
    let failures = 1;
    const rig = admissionRig(deferred, () =>
      failures-- > 0 ? failing() : null,
    );

    await expect(rig.host.handle(rig.request(POSTED), 0)).rejects.toThrow(
      "hook failed",
    );
    expect(rig.trace).toEqual(["setAlarm", "beforeResume"]);

    // The same result posted again is still new: the failed hook marked nothing complete.
    await rig.host.handle(rig.request(POSTED), 1);
    expect(rig.trace.slice(2)).toEqual([
      "setAlarm",
      "beforeResume",
      ...(deferred ? ["settled", "enqueue"] : ["resume", "nextStep"]),
    ]);
  });

  it("never reaches the hook when the token is refused", async () => {
    const calls: string[] = [];
    const rig = admissionRig(deferred, () => {
      calls.push("hook");
      return STOPPED;
    });

    const wrong = await rig.host.handle(
      { ...rig.request(POSTED), token: mintRunToken() },
      0,
    );
    expect(wrong.status).toBe(401);
    expect(calls).toEqual([]);
    expect(rig.trace).toEqual([]);
    expect(rig.durable.alarmAt).toBeNull();
  });

  it("never reaches the hook for an unknown run", async () => {
    const calls: string[] = [];
    const host = deferred
      ? stepHost<ToolResult, ToolInput, RunOutput>(
          {
            storage: {
              setAlarm() {
                calls.push("setAlarm");
              },
            },
          },
          {
            tokenFor: () => null,
            resume() {
              calls.push("resume");
            },
            nextStep: () => null,
            terminalOutput: () => "",
            beforeResume: () => {
              calls.push("hook");
              return STOPPED;
            },
          },
          { deferResume: { settled: () => false, enqueue: () => {} } },
        )
      : stepHost<ToolResult, ToolInput, RunOutput>(
          {
            storage: {
              setAlarm() {
                calls.push("setAlarm");
              },
            },
          },
          {
            tokenFor: () => null,
            resume() {
              calls.push("resume");
            },
            nextStep: () => null,
            terminalOutput: () => "",
            beforeResume: () => {
              calls.push("hook");
              return STOPPED;
            },
          },
        );

    const outcome = await host.handle(
      { token: "any", runId: "missing", posted: POSTED },
      0,
    );

    expect(outcome.status).toBe(404);
    expect(calls).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// One run's requests take turns — per run, after the token, inside one instance
//
// A request that passes the token check waits for the run's earlier requests to
// settle, then runs its whole turn: alarm, admission hook, settle (or the
// deferred probe and enqueue), and the read of the next step or the output. The
// rig holds a resume or an enqueue on a gate the test opens, so a request that
// reads too early is caught by what it saw, not by a sleep.
// ─────────────────────────────────────────────────────────────────────────────

/** Let every microtask the requests already queued run. */
const quiesce = () => new Promise<void>((resolve) => setImmediate(resolve));

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}
type Gate = ReturnType<typeof gate>;

/** A held gate that never opens fails the suite here, not at the default. */
const TURN_TIMEOUT_MS = 5_000;

/** Many runs behind one host. A `callId` is only unique inside its own run. */
function runsRig(deferred: boolean) {
  const runs = new Map<string, { cursor: number; collected: string[] }>();
  const runOf = (runId: string) => {
    let run = runs.get(runId);
    if (run === undefined) {
      run = { cursor: 0, collected: [] };
      runs.set(runId, run);
    }
    return run;
  };
  const log: string[] = [];
  const alarms: number[] = [];
  const resumes: string[] = [];
  const busy = new Map<string, number>();
  const midFlight: string[] = [];
  const holds = new Map<string, Gate>();
  const entered = new Map<string, Gate>();
  const faults = new Map<string, Error[]>();
  const landed = new Set<string>();
  const inbox = new Map<string, StepResult<ToolResult>>();
  let hookActive = 0;
  let hookOverlap = 0;
  let hook: Hook | undefined;

  const holdAt = (key: string): Gate => {
    let held = holds.get(key);
    if (held === undefined) {
      held = gate();
      holds.set(key, held);
    }
    return held;
  };
  const enteredAt = (key: string): Gate => {
    let signal = entered.get(key);
    if (signal === undefined) {
      signal = gate();
      entered.set(key, signal);
    }
    return signal;
  };
  const throwOnce = (stage: string) => {
    const error = faults.get(stage)?.shift();
    if (error !== undefined) throw error;
  };
  const reading = (runId: string, what: string) => {
    log.push(`${what}:${runId}`);
    if ((busy.get(runId) ?? 0) > 0) midFlight.push(`${what}:${runId}`);
  };
  const stepOf = (runId: string): NextStep<ToolInput> | null => {
    const run = runOf(runId);
    if (run.cursor >= SCRIPT.length) return null;
    const entry = entryAt(run.cursor);
    return { callId: `c${run.cursor}`, tool: entry.tool, input: entry.input };
  };
  const settle = (runId: string, posted: StepResult<ToolResult>) => {
    const run = runOf(runId);
    run.cursor += 1;
    run.collected.push(posted.result);
    landed.add(`${runId}/${posted.callId}`);
  };

  const ctx: StepCtx = {
    storage: {
      setAlarm(at) {
        log.push("setAlarm");
        alarms.push(at);
        throwOnce("setAlarm");
      },
    },
  };
  const engine: StepEngine<ToolResult, ToolInput, RunOutput> = {
    tokenFor(runId) {
      log.push(`tokenFor:${runId}`);
      throwOnce("tokenFor");
      return `token-${runId}`;
    },
    async resume(runId, posted) {
      const key = `${runId}/${posted.callId}`;
      log.push(`resume:${key}`);
      resumes.push(key);
      busy.set(runId, (busy.get(runId) ?? 0) + 1);
      enteredAt(key).open();
      try {
        throwOnce("resume");
        await holdAt(key).opened;
        settle(runId, posted);
      } finally {
        busy.set(runId, (busy.get(runId) ?? 1) - 1);
      }
    },
    nextStep(runId) {
      reading(runId, "nextStep");
      throwOnce("nextStep");
      return stepOf(runId);
    },
    terminalOutput(runId) {
      reading(runId, "terminalOutput");
      throwOnce("terminalOutput");
      return runOf(runId).collected.join("|");
    },
    beforeResume(runId) {
      log.push(`beforeResume:${runId}`);
      hookActive += 1;
      if (hookActive > 1) hookOverlap += 1;
      throwOnce("beforeResume");
      return Promise.resolve(hook?.(runId) ?? null).finally(() => {
        hookActive -= 1;
      });
    },
  };
  const deferEngine: StepEngine<ToolResult, ToolInput, RunOutput> = {
    ...engine,
    resume() {
      throw new Error("inline resume must not run on the defer path");
    },
  };
  const deferResume: DeferResumeHook<ToolResult> = {
    settled(runId, callId) {
      log.push(`settled:${runId}/${callId}`);
      return landed.has(`${runId}/${callId}`);
    },
    async enqueue(runId, posted) {
      const key = `${runId}/${posted.callId}`;
      log.push(`enqueue:start:${key}`);
      enteredAt(`enqueue:${key}`).open();
      await holdAt(`enqueue:${key}`).opened;
      inbox.set(key, posted);
      log.push(`enqueue:end:${key}`);
    },
  };
  const host = deferred
    ? stepHost<ToolResult, ToolInput, RunOutput>(ctx, deferEngine, {
        deferResume,
      })
    : stepHost<ToolResult, ToolInput, RunOutput>(ctx, engine);

  return {
    host,
    runOf,
    /** Mark a settled callId of a run as landed, as the out-of-band worker would. */
    land: (key: string) => landed.add(key),
    log,
    alarms,
    resumes,
    midFlight,
    inbox,
    /** A gate that keeps `key` (`run/callId`, or `enqueue:run/callId`) held. */
    hold: holdAt,
    entered: (key: string) => enteredAt(key).opened,
    failOnce: (stage: string, error: Error) =>
      faults.set(stage, [...(faults.get(stage) ?? []), error]),
    answerWith(next: Hook | undefined) {
      hook = next;
    },
    hookOverlap: () => hookOverlap,
    /** The out-of-band worker: land everything enqueued. */
    drain() {
      for (const [key, posted] of inbox) {
        settle(key.slice(0, key.indexOf("/")), posted);
        inbox.delete(key);
      }
    },
    request: (
      runId: string,
      posted: StepResult<ToolResult> | null,
    ): StepRequest<ToolResult> => ({
      token: `token-${runId}`,
      runId,
      posted,
    }),
  };
}

const post = (callId: string, result: string): StepResult<ToolResult> => ({
  callId,
  result,
});

/** The step a pull handed out, or the reason it handed out none. */
function answerOf(
  outcome: Awaited<ReturnType<ReturnType<typeof runsRig>["host"]["handle"]>>,
): string {
  if (outcome.status !== 200) return `status ${outcome.status}`;
  const body = outcome.body;
  if (body.done) return `done:${body.output}`;
  return "working" in body ? "working" : body.step.callId;
}

describe(
  "stepHost — one run's requests take turns (inline host)",
  { timeout: TURN_TIMEOUT_MS },
  () => {
    it("makes three simultaneous requests wait for the held resume, then answers each from the settled State", async () => {
      const rig = runsRig(false);
      const first = rig.hold("r/c0");
      const second = rig.hold("r/c1");
      const answered: string[] = [];
      const track = (
        name: string,
        outcome: ReturnType<typeof rig.host.handle>,
      ) =>
        outcome.then((value) => {
          answered.push(name);
          return value;
        });

      const posted = track(
        "posted",
        rig.host.handle(rig.request("r", post("c0", "A")), 1),
      );
      await rig.entered("r/c0");
      const duplicate = track(
        "duplicate",
        rig.host.handle(rig.request("r", post("c0", "A")), 2),
      );
      const poll = track("poll", rig.host.handle(rig.request("r", null), 3));
      const next = track(
        "next",
        rig.host.handle(rig.request("r", post("c1", "B")), 4),
      );
      await quiesce();

      expect(answered).toEqual([]);
      expect(rig.midFlight).toEqual([]);
      expect(rig.resumes).toEqual(["r/c0"]);

      first.open();
      await rig.entered("r/c1");
      expect(answered).toEqual(["posted", "duplicate", "poll"]);
      second.open();

      expect(
        (await Promise.all([posted, duplicate, poll, next])).map(answerOf),
      ).toEqual(["c1", "c1", "c1", "c2"]);
      expect(rig.resumes).toEqual(["r/c0", "r/c1"]);
      expect(rig.midFlight).toEqual([]);
    });

    it("never answers done from a State that is still being resumed", async () => {
      const rig = runsRig(false);
      rig.runOf("r").cursor = SCRIPT.length - 1;
      const release = rig.hold("r/c2");

      const resuming = rig.host.handle(rig.request("r", post("c2", "Z")), 1);
      await rig.entered("r/c2");
      const duplicate = rig.host.handle(rig.request("r", post("c2", "Z")), 2);
      await quiesce();
      expect(rig.midFlight).toEqual([]);

      release.open();

      expect((await Promise.all([resuming, duplicate])).map(answerOf)).toEqual([
        "done:Z",
        "done:Z",
      ]);
      expect(rig.resumes).toEqual(["r/c2"]);
      expect(rig.midFlight).toEqual([]);
    });

    it("lets two runs progress independently, and settles a callId two runs share in each", async () => {
      const rig = runsRig(false);
      const slow = rig.hold("a/c0");
      rig.hold("b/c0").open();

      const a = rig.host.handle(rig.request("a", post("c0", "A")), 1);
      await rig.entered("a/c0");
      const b = await rig.host.handle(rig.request("b", post("c0", "B")), 2);

      expect(answerOf(b)).toBe("c1");
      expect(rig.runOf("a").cursor).toBe(0);
      slow.open();
      expect(answerOf(await a)).toBe("c1");
      expect(rig.resumes).toEqual(["a/c0", "b/c0"]);
      expect(rig.runOf("a").collected).toEqual(["A"]);
      expect(rig.runOf("b").collected).toEqual(["B"]);
    });

    it("refuses a bad token at once: no queue slot, no alarm, no hook, however long the run's turn takes", async () => {
      const rig = runsRig(false);
      const slow = rig.hold("r/c0");
      const turn = rig.host.handle(rig.request("r", post("c0", "A")), 1);
      await rig.entered("r/c0");
      const alarmsBefore = rig.alarms.length;
      const hooksBefore = rig.log.filter((l) =>
        l.startsWith("beforeResume"),
      ).length;

      const wrong = await rig.host.handle(
        { ...rig.request("r", post("c0", "A")), token: "wrong" },
        2,
      );
      expect(wrong.status).toBe(401);
      expect(rig.alarms).toHaveLength(alarmsBefore);
      expect(rig.log.filter((l) => l.startsWith("beforeResume"))).toHaveLength(
        hooksBefore,
      );

      slow.open();
      expect(answerOf(await turn)).toBe("c1");
    });

    it("runs the admission hook once per request and never two at a time", async () => {
      const rig = runsRig(false);
      rig.answerWith(() => STOPPED);

      const answers = await Promise.all(
        [1, 2, 3].map((now) =>
          rig.host.handle(rig.request("r", post("c0", "A")), now),
        ),
      );

      expect(answers).toEqual([
        { status: 200, body: STOPPED },
        { status: 200, body: STOPPED },
        { status: 200, body: STOPPED },
      ]);
      expect(rig.log.filter((l) => l.startsWith("beforeResume"))).toHaveLength(
        3,
      );
      expect(rig.hookOverlap()).toBe(0);
      expect(rig.resumes).toEqual([]);
    });

    it("returns the resume's own error to its caller, leaves the callId retryable, and still runs the request queued behind it", async () => {
      const rig = runsRig(false);
      const failure = new Error("resume refused");
      rig.failOnce("resume", failure);
      rig.hold("r/c0").open();

      const [failed, retried] = await Promise.allSettled([
        rig.host.handle(rig.request("r", post("c0", "A")), 1),
        rig.host.handle(rig.request("r", post("c0", "A")), 2),
      ]);

      expect(failed).toEqual({ status: "rejected", reason: failure });
      expect(retried.status).toBe("fulfilled");
      expect(retried.status === "fulfilled" && answerOf(retried.value)).toBe(
        "c1",
      );
      expect(rig.resumes).toEqual(["r/c0", "r/c0"]);
      expect(rig.runOf("r").collected).toEqual(["A"]);

      const settled = await rig.host.handle(
        rig.request("r", post("c0", "A")),
        3,
      );
      expect(answerOf(settled)).toBe("c1");
      expect(rig.resumes).toEqual(["r/c0", "r/c0"]);
    });

    it.each([
      "tokenFor",
      "setAlarm",
      "beforeResume",
      "resume",
      "nextStep",
      "terminalOutput",
    ])("keeps serving the run after %s throws once", async (stage) => {
      const rig = runsRig(false);
      rig.hold("r/c0").open();
      const terminal = stage === "terminalOutput";
      if (terminal) rig.runOf("r").cursor = SCRIPT.length;
      const failure = new Error(`${stage} failed`);
      rig.failOnce(stage, failure);
      const request = () =>
        rig.request("r", stage === "resume" ? post("c0", "A") : null);

      await expect(rig.host.handle(request(), 1)).rejects.toBe(failure);
      const later = await rig.host.handle(request(), 2);

      expect(later.status).toBe(200);
      expect(answerOf(later)).toBe(
        terminal ? "done:" : stage === "resume" ? "c1" : "c0",
      );
    });
  },
);

describe(
  "stepHost — one run's requests take turns (deferred host)",
  { timeout: TURN_TIMEOUT_MS },
  () => {
    it("holds a duplicate and a poll behind the enqueue in progress, and answers working without waiting for the worker", async () => {
      const rig = runsRig(true);
      rig.runOf("r").cursor = 1;
      rig.runOf("r").collected = ["A"];
      rig.land("r/c0");
      const enqueueing = rig.hold("enqueue:r/c1");
      const answered: string[] = [];
      const track = (
        name: string,
        outcome: ReturnType<typeof rig.host.handle>,
      ) =>
        outcome.then((value) => {
          answered.push(name);
          return value;
        });

      const next = track(
        "next",
        rig.host.handle(rig.request("r", post("c1", "B")), 1),
      );
      await rig.entered("enqueue:r/c1");
      rig.log.length = 0;
      const duplicate = track(
        "duplicate",
        rig.host.handle(rig.request("r", post("c0", "A")), 2),
      );
      const poll = track("poll", rig.host.handle(rig.request("r", null), 3));
      await quiesce();

      expect(answered).toEqual([]);
      expect(rig.log.filter((l) => !l.startsWith("tokenFor"))).toEqual([]);

      enqueueing.open();
      const answers = (await Promise.all([next, duplicate, poll])).map(
        answerOf,
      );

      expect(answers).toEqual(["working", "c1", "c1"]);
      expect(rig.inbox.size).toBe(1);
      expect(rig.runOf("r").cursor).toBe(1);

      rig.drain();
      expect(
        answerOf(await rig.host.handle(rig.request("r", post("c1", "B")), 4)),
      ).toBe("c2");
    });

    it("runs settled and enqueue for a repeated post one turn at a time", async () => {
      const rig = runsRig(true);
      const enqueueing = rig.hold("enqueue:r/c0");

      const first = rig.host.handle(rig.request("r", post("c0", "A")), 1);
      await rig.entered("enqueue:r/c0");
      const second = rig.host.handle(rig.request("r", post("c0", "A")), 2);
      const third = rig.host.handle(rig.request("r", post("c0", "A")), 3);
      await quiesce();
      enqueueing.open();

      expect((await Promise.all([first, second, third])).map(answerOf)).toEqual(
        ["working", "working", "working"],
      );
      expect(rig.log.filter((l) => /^(settled|enqueue)/.test(l))).toEqual([
        "settled:r/c0",
        "enqueue:start:r/c0",
        "enqueue:end:r/c0",
        "settled:r/c0",
        "enqueue:start:r/c0",
        "enqueue:end:r/c0",
        "settled:r/c0",
        "enqueue:start:r/c0",
        "enqueue:end:r/c0",
      ]);
    });

    it("lets two runs sharing a callId each enqueue their own", async () => {
      const rig = runsRig(true);
      const slow = rig.hold("enqueue:a/c0");
      rig.hold("enqueue:b/c0").open();

      const a = rig.host.handle(rig.request("a", post("c0", "A")), 1);
      await rig.entered("enqueue:a/c0");
      const b = await rig.host.handle(rig.request("b", post("c0", "B")), 2);

      expect(answerOf(b)).toBe("working");
      slow.open();
      expect(answerOf(await a)).toBe("working");
      expect([...rig.inbox.keys()].sort()).toEqual(["a/c0", "b/c0"]);
    });

    it.each([
      "tokenFor",
      "setAlarm",
      "beforeResume",
      "nextStep",
    ])("keeps serving the run after %s throws once", async (stage) => {
      const rig = runsRig(true);
      const failure = new Error(`${stage} failed`);
      rig.failOnce(stage, failure);

      await expect(rig.host.handle(rig.request("r", null), 1)).rejects.toBe(
        failure,
      );

      expect(answerOf(await rig.host.handle(rig.request("r", null), 2))).toBe(
        "c0",
      );
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// One owner of the Durable Object's single alarm — host composition, not tea API
//
// A Durable Object has one native alarm. `stepHost` re-arms an idle give-up on
// every authenticated pull and `durableTimer` arms whatever deadline the host
// persisted at run creation. The host puts both behind one `AlarmStorage` that
// records what each asked for and arms the earliest active deadline, so a pull
// never postpones an absolute deadline and neither writer overwrites the other.
// ─────────────────────────────────────────────────────────────────────────────

interface Deadlines {
  startupBy: number | null;
  absoluteBy: number;
  idleBy: number | null;
  expired: boolean;
}

const earliest = (deadlines: Deadlines): number | null => {
  if (deadlines.expired) return null;
  const active = [
    deadlines.startupBy,
    deadlines.absoluteBy,
    deadlines.idleBy,
  ].filter((at): at is number => at !== null);
  return Math.min(...active);
};

// The platform: what survives an eviction is `persisted`, and every `setAlarm`
// on the native alarm is recorded.
function alarmOwner(initial: Deadlines) {
  let persisted: Deadlines = JSON.parse(JSON.stringify(initial));
  const native: number[] = [];
  const alarm: AlarmStorage = {
    async setAlarm(requestedAt) {
      persisted.startupBy = null;
      persisted.idleBy = requestedAt;
      const at = earliest(persisted);
      await Promise.resolve();
      if (at !== null) native.push(at);
    },
  };
  const timer = () =>
    durableTimer({
      alarm: {
        async setAlarm(at) {
          await Promise.resolve();
          native.push(at);
        },
      },
      nextDeadline: () => earliest(persisted),
      onFire() {
        persisted.expired = true;
      },
    });
  return {
    alarm,
    native,
    timer,
    deadlines: () => persisted,
    evict() {
      persisted = JSON.parse(JSON.stringify(persisted));
    },
  };
}

describe("stepHost + durableTimer — one owner of the single alarm", () => {
  it.each([
    1, 2, 3,
  ])("a run no step request ever reached still expires at its startup deadline (repeat %i)", async () => {
    const platform = alarmOwner({
      startupBy: 300_000,
      absoluteBy: 3_600_000,
      idleBy: null,
      expired: false,
    });
    // Run creation answers only after the alarm is armed.
    const launch = async () => {
      await platform.timer().rearm();
      return { runId: "run-owned", armedWhenAnswered: [...platform.native] };
    };
    expect((await launch()).armedWhenAnswered).toEqual([300_000]);

    // No `/step` request ever arrives. A cold wake rebuilds the timer from the
    // persisted deadline and the alarm fires.
    platform.evict();
    await platform.timer().onAlarm();
    expect(platform.deadlines().expired).toBe(true);
    expect(platform.native).toEqual([300_000]);
  });

  it("a step request cannot postpone an absolute deadline, and an earlier idle deadline still wins", async () => {
    const platform = alarmOwner({
      startupBy: 105_000,
      absoluteBy: 120_000,
      idleBy: null,
      expired: false,
    });
    const engine: StepEngine<ToolResult, ToolInput, RunOutput> = {
      tokenFor: () => "token",
      resume() {},
      nextStep: () => null,
      terminalOutput: () => "done",
    };
    const request = (posted: StepResult<ToolResult> | null) => ({
      token: "token",
      runId: "run-owned",
      posted,
    });

    // The first pull ends the startup window, and the default give-up (five
    // minutes out) is later than the absolute deadline.
    const lazy = stepHost<ToolResult, ToolInput, RunOutput>(
      { storage: platform.alarm },
      engine,
    );
    await lazy.handle(request(null), 100_000);
    await lazy.handle(request(null), 110_000);
    expect(platform.native).toEqual([120_000, 120_000]);

    // A shorter give-up is earlier, so it is the one armed.
    const eager = stepHost<ToolResult, ToolInput, RunOutput>(
      { storage: platform.alarm },
      engine,
      { giveUpAfterMs: 5_000 },
    );
    await eager.handle(request(null), 100_000);
    expect(platform.native.at(-1)).toBe(105_000);
  });
});
