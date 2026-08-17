import { ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";
import { run } from "../../../src/index";
import { type Cell, cell, memStore } from "../harness";
import { agentInterpret } from "./handlers";
import {
  agentRunMachine,
  initialState,
  parseState,
  retryDelayMs,
  type State,
} from "./machine";
import { ProviderFake, type ScriptedStep } from "./services";

const GOAL = "summarise the incident and file the postmortem";

/** Three steps; step 2 needs a human, step 3 is flaky before it lands. */
const SCRIPT: readonly ScriptedStep[] = [
  { output: "read the incident channel", costUsd: 0.1 },
  {
    output: "drafted the postmortem",
    costUsd: 0.2,
    needsApproval: "publish the postmortem",
  },
  { output: "published", costUsd: 0.15, failuresBeforeSuccess: 2 },
];

async function boot(
  c: Cell,
  script: readonly ScriptedStep[] = SCRIPT,
  budgetUsd = 1,
) {
  const managed = ManagedRuntime.make(ProviderFake(script));
  const rt = await run(
    agentRunMachine(agentInterpret(managed), { budgetUsd }),
    {
      ctx: {},
      store: memStore<State>(c, parseState),
    },
  ).ready;
  return { rt, managed };
}

type Rt = Awaited<ReturnType<typeof boot>>["rt"];

/** Fire the tick the alarm would have fired, without waiting for it. */
async function fireRetry(rt: Rt) {
  const due = rt.getState().nextRetryAt;
  expect(due).not.toBeNull();
  await rt.dispatch({ type: "tick", at: due as number });
}

describe("durable agent run — the two waits", () => {
  it("pauses on approval with NO timer armed, then continues on the Msg", async () => {
    const c = cell();
    const { rt, managed } = await boot(c);

    await rt.dispatch({ type: "start", runId: "run-1", goal: GOAL, at: 0 });

    // Step 1 landed, step 2 proposed an action a human must bless.
    const paused = rt.getState();
    expect(paused.phase).toBe("awaiting-approval");
    expect(paused.step).toBe(1);
    expect(paused.pendingApproval?.action).toBe("publish the postmortem");
    // The point of the recipe: nothing is scheduled. There is no deadline to
    // miss, and no fiber parked on a promise.
    expect(paused.nextRetryAt).toBeNull();

    // Four days later.
    const FOUR_DAYS = 4 * 24 * 60 * 60 * 1000;
    await rt.dispatch({ type: "approval_granted", by: "umut", at: FOUR_DAYS });

    // Step 3 is flaky: two refusals, so the ladder is visible state.
    expect(rt.getState().phase).toBe("running");
    expect(rt.getState().attempt).toBe(1);
    expect(rt.getState().nextRetryAt).not.toBeNull();

    await fireRetry(rt);
    expect(rt.getState().attempt).toBe(2);
    await fireRetry(rt);

    expect(rt.getState().phase).toBe("done");
    expect(rt.getState().step).toBe(3);
    expect(rt.getState().spentUsd).toBeCloseTo(0.45, 5);

    await rt.stop();
    await managed.dispose();
  });

  it("fails the run when the ledger crosses the budget cap", async () => {
    const c = cell();
    const { rt, managed } = await boot(
      c,
      [
        { output: "cheap", costUsd: 0.2 },
        { output: "ruinous", costUsd: 5 },
        { output: "never reached", costUsd: 1 },
      ],
      1,
    );

    await rt.dispatch({
      type: "start",
      runId: "run-spendy",
      goal: GOAL,
      at: 0,
    });

    const state = rt.getState();
    expect(state.phase).toBe("failed");
    expect(state.spentUsd).toBeCloseTo(5.2, 5);
    expect(state.failure).toContain("budget exceeded");

    await rt.stop();
    await managed.dispose();
  });

  it("gives up after the retry budget and records why", async () => {
    const c = cell();
    const { rt, managed } = await boot(c, [
      { output: "never", costUsd: 0.1, failuresBeforeSuccess: 99 },
    ]);

    await rt.dispatch({
      type: "start",
      runId: "run-doomed",
      goal: GOAL,
      at: 0,
    });
    for (let n = 1; n < 4; n++) await fireRetry(rt);

    expect(rt.getState().phase).toBe("failed");
    expect(rt.getState().failure).toContain("provider gave up after 4");
    expect(rt.getState().nextRetryAt).toBeNull();

    await rt.stop();
    await managed.dispose();
  });

  it("keeps the retry ladder honest across a mid-step restart", async () => {
    const c = cell();
    const first = await boot(c, [
      { output: "eventually", costUsd: 0.1, failuresBeforeSuccess: 2 },
    ]);

    await first.rt.dispatch({
      type: "start",
      runId: "run-2",
      goal: GOAL,
      at: 0,
    });
    expect(first.rt.getState().attempt).toBe(1);
    // The failure Msg carries `at` from the effect boundary, so the deadline is
    // an absolute instant one backoff step from now.
    const owedAt = first.rt.getState().nextRetryAt as number;
    expect(owedAt - Date.now()).toBeGreaterThan(retryDelayMs(1) - 500);
    expect(owedAt - Date.now()).toBeLessThanOrEqual(retryDelayMs(1));

    // The isolate dies mid-backoff.
    await first.rt.stop();
    await first.managed.dispose();

    const second = await boot(c, [
      { output: "eventually", costUsd: 0.1, failuresBeforeSuccess: 2 },
    ]);
    // A FRESH runtime, booted from the bytes: attempt 1 is still spent.
    expect(second.rt.getState().attempt).toBe(1);
    expect(second.rt.getState().nextRetryAt).toBe(owedAt);

    await second.rt.dispatch({ type: "tick", at: owedAt });
    expect(second.rt.getState().attempt).toBe(2);
    await second.rt.dispatch({
      type: "tick",
      at: second.rt.getState().nextRetryAt as number,
    });
    expect(second.rt.getState().phase).toBe("done");

    await second.rt.stop();
    await second.managed.dispose();
  });
});

describe("durable agent run — resume from serialized state", () => {
  it("boots a fresh runtime mid-approval and finishes the run", async () => {
    const c = cell();
    const first = await boot(c);
    await first.rt.dispatch({
      type: "start",
      runId: "run-3",
      goal: GOAL,
      at: 0,
    });
    expect(first.rt.getState().phase).toBe("awaiting-approval");
    await first.rt.stop();
    await first.managed.dispose();

    // The only thing that crossed the boundary is JSON.
    expect(typeof c.raw).toBe("string");
    const parsed = parseState(JSON.parse(c.raw as string));
    expect(parsed?.phase).toBe("awaiting-approval");

    const second = await boot(c);
    const resumed = second.rt.getState();
    expect(resumed.phase).toBe("awaiting-approval");
    expect(resumed.spentUsd).toBeCloseTo(0.3, 5);
    expect(resumed.pendingApproval?.action).toBe("publish the postmortem");

    const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;
    await second.rt.dispatch({
      type: "approval_granted",
      by: "can",
      at: THREE_DAYS,
    });
    await second.rt.dispatch({
      type: "tick",
      at: second.rt.getState().nextRetryAt as number,
    });
    await second.rt.dispatch({
      type: "tick",
      at: second.rt.getState().nextRetryAt as number,
    });

    expect(second.rt.getState().phase).toBe("done");
    expect(second.rt.getState().transcript).toContain("run complete");

    await second.rt.stop();
    await second.managed.dispose();
  });

  it("boots fresh when the stored bytes are not this shape", async () => {
    expect(parseState({ nope: true })).toBeNull();
    expect(parseState(null)).toBeNull();
    expect(parseState(initialState())).not.toBeNull();
  });
});
