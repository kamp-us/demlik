/**
 * The two stop conditions `defineAgent` offers, worked end to end — the source
 * the how-to guide `docs/how-to/bound-a-run.md` quotes.
 *
 * Story: one scripted model that never stops asking for tools, run three times
 * under three different bounds. No keys, no network.
 *
 *   1. `maxTurns: 3`   — the run fails at the third completed round-trip.
 *   2. `deadlineMs: 150` over a run that KEEPS MOVING — it does not fire. The
 *      run outlives the budget many times over, because the budget is a
 *      no-progress watchdog and every advance restarts it.
 *   3. `deadlineMs: 150` over a run that STOPS moving — a tool that sleeps
 *      400ms is 400ms of no progress, so the watchdog fires.
 *
 * (2) is the whole reason this file exists. `deadlineMs` is not a wall-clock
 * cap on a run and setting it is not a spend cap.
 *
 * Run it:  node --experimental-strip-types examples/agent-stop-conditions.ts
 */

import {
  type AgentMessage,
  type AgentTurn,
  defineAgent,
  tool,
} from "@demlik/tea/agent";
import { DriveFailedError } from "@demlik/tea";
import { z } from "zod";

// ===========================================================================
// One tool. `napMs` is the handler's whole behaviour: it sleeps, then answers.
// A long nap is a stretch of run time in which nothing advances.
// ===========================================================================

const tick = tool(
  "tick",
  {
    description: "Do one unit of busywork",
    input: z.object({ napMs: z.number() }),
    ok: z.object({ napped: z.number() }),
    err: [],
  },
  async ({ napMs }, _ctx, { ok }) => {
    await new Promise((r) => setTimeout(r, napMs));
    return ok({ napped: napMs });
  },
);

// ===========================================================================
// A model that never stops. Every turn asks for one more `tick`, so nothing
// but a stop condition can ever end these runs.
// ===========================================================================

let calls = 0;

const modelAsking = (napMs: number) => {
  let n = 0;
  return async (_messages: readonly AgentMessage[]): Promise<AgentTurn> => {
    calls += 1;
    n += 1;
    return {
      content: `turn ${n}`,
      toolCalls: [{ callId: `c${n}`, name: "tick", args: { napMs } }],
    };
  };
};

/** Run `agent`, and describe how it ended rather than letting it throw. */
async function ended(run: () => Promise<unknown>): Promise<string> {
  const startedAt = Date.now();
  try {
    await run();
    return `resolved after ${Date.now() - startedAt}ms`;
  } catch (error) {
    const elapsed = Date.now() - startedAt;
    if (!(error instanceof DriveFailedError)) throw error;
    // Two failure channels, one rejection: the agent's own annotation carries
    // `turn_limit`, and the monitored-run slice carries `deadline`.
    const state = error.state as {
      failure?: { reason: string; at: number };
      run: { failure?: { reason: string; at: number } };
    };
    const failure = state.failure ?? state.run.failure;
    // `at` is when the guard FIRED; `elapsed` is when the promise settled. They
    // differ whenever an effect was still in flight when the guard tripped.
    const stamped = (failure?.at ?? startedAt) - startedAt;
    return `failed with ${failure?.reason} after ${elapsed}ms (guard fired at +${stamped}ms)`;
  }
}

// ===========================================================================
// 1 — `maxTurns` counts COMPLETED model round-trips and fails at the count.
// ===========================================================================

const bounded = defineAgent({
  model: modelAsking(1),
  tools: [tick],
  instructions: "You tick.",
  maxTurns: 3,
});

calls = 0;
console.log("maxTurns: 3 →", await ended(() => bounded.run("go")));
console.log("  model calls:", calls);

// ===========================================================================
// 2 — `deadlineMs` over a run that keeps moving. Each tick naps 20ms, well
// inside the 150ms budget, so every advance re-arms the watchdog and the run
// sails past 150ms of wall clock without it ever firing. `maxTurns` is what
// ends this run — remove it and it never ends at all.
// ===========================================================================

const progressing = defineAgent({
  model: modelAsking(20),
  tools: [tick],
  instructions: "You tick.",
  deadlineMs: 150,
  maxTurns: 25,
});

calls = 0;
console.log("deadlineMs: 150, progressing →", await ended(() => progressing.run("go")));
console.log("  model calls:", calls);

// ===========================================================================
// 3 — the same 150ms budget over a run that stops moving. One tick naps 400ms,
// and 400ms with no advance is what the watchdog is actually watching for.
// ===========================================================================

const stalling = defineAgent({
  model: modelAsking(400),
  tools: [tick],
  instructions: "You tick.",
  deadlineMs: 150,
});

calls = 0;
console.log("deadlineMs: 150, stalling →", await ended(() => stalling.run("go")));
console.log("  model calls:", calls);

/*
 * What it prints. The millisecond figures move a little run to run — the shape
 * is what matters:
 *
 *   maxTurns: 3 → failed with turn_limit after 73ms (guard fired at +72ms)
 *     model calls: 3
 *   deadlineMs: 150, progressing → failed with turn_limit after 748ms (guard fired at +745ms)
 *     model calls: 25
 *   deadlineMs: 150, stalling → failed with deadline after 407ms (guard fired at +156ms)
 *     model calls: 1
 *
 * Read the middle line twice. A 150ms `deadlineMs` let a run take 748ms and 25
 * model calls, and what ended it was `maxTurns`, not the budget. Every 20ms tick
 * was an advance, and every advance re-armed the watchdog, so it never came due.
 * Remove `maxTurns: 25` from that agent and it runs forever.
 *
 * The last line shows the other half: the watchdog fired at +156ms, on schedule,
 * but the promise settled at 407ms — the guard fails the run, it does not cancel
 * the 400ms handler already in flight. So even a watchdog that DOES fire is not
 * an upper bound on how long `run` takes to settle.
 */
