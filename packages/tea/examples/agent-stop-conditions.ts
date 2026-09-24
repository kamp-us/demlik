/**
 * The four stop conditions `defineAgent` offers, worked end to end — the source
 * the how-to guide `docs/how-to/bound-a-run.md` quotes.
 *
 * Story: one scripted model that never stops asking for tools, run five times
 * under five different bounds. No keys, no network.
 *
 *   1. `maxTurns: 3`   — the run fails at the third completed round-trip.
 *   2. `deadlineMs: 150` over a run that KEEPS MOVING — it does not fire. The
 *      run outlives the budget many times over, because the budget is a
 *      no-progress watchdog and every advance restarts it.
 *   3. `deadlineMs: 150` over a run that STOPS moving — a tool that sleeps
 *      400ms is 400ms of no progress, so the watchdog fires.
 *   4. `maxElapsedMs: 150` over that SAME progressing run — it does fire. This
 *      budget never restarts, so progress buys the run nothing.
 *   5. `stopWhen` over the same run — the caller's own condition, read at the
 *      turn boundary, ends it `cancelled` rather than failed.
 *
 * (2) beside (4) is the whole reason this file exists. `deadlineMs` is not a
 * wall-clock cap on a run and setting it is not a spend cap; `maxElapsedMs` is.
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

// ===========================================================================
// 4 — `maxElapsedMs` over the SAME 20ms-tick agent that sailed past case 2's
// deadline. Same budget, same ticks, and this one ends the run: the wall-clock
// cap counts from the start and never restarts, so progress does not buy time.
// ===========================================================================

const capped = defineAgent({
  model: modelAsking(20),
  tools: [tick],
  instructions: "You tick.",
  maxElapsedMs: 150,
});

calls = 0;
console.log("maxElapsedMs: 150, progressing →", await ended(() => capped.run("go")));
console.log("  model calls:", calls);

// ===========================================================================
// 5 — `stopWhen`: the caller's own condition, read at the turn boundary over
// the durable Model. Here it is "five turns is enough", which `maxTurns` would
// also do — the point is that the predicate can read anything the Model holds,
// and that answering `true` ends the run CANCELLED, so `run` resolves.
// ===========================================================================

const untilFive = defineAgent({
  model: modelAsking(1),
  tools: [tick],
  instructions: "You tick.",
  stopWhen: (state) => (state.conversation?.turnCount ?? 0) >= 5,
});

calls = 0;
console.log("stopWhen: turnCount >= 5 →", await ended(() => untilFive.run("go")));
console.log("  model calls:", calls);

/*
 * What it prints. The millisecond figures move a little run to run — the shape
 * is what matters:
 *
 *   maxTurns: 3 → failed with turn_limit after 8ms (guard fired at +8ms)
 *     model calls: 3
 *   deadlineMs: 150, progressing → failed with turn_limit after 531ms (guard fired at +531ms)
 *     model calls: 25
 *   deadlineMs: 150, stalling → failed with deadline after 402ms (guard fired at +150ms)
 *     model calls: 1
 *   maxElapsedMs: 150, progressing → failed with elapsed_limit after 171ms (guard fired at +171ms)
 *     model calls: 8
 *   stopWhen: turnCount >= 5 → resolved after 7ms
 *     model calls: 5
 *
 * Read the second line beside the fourth. Same agent, same 20ms ticks, two 150ms
 * budgets. `deadlineMs` let it take 531ms and 25 model calls — every tick was an
 * advance, and every advance re-armed the watchdog, so it never came due; what
 * ended that run was `maxTurns`, and without it the run never ends at all.
 * `maxElapsedMs` ended the same agent at 171ms and 8 calls, because that budget
 * counts from the start and nothing restarts it.
 *
 * The third line shows the other half of the watchdog: it fired at +150ms, on
 * schedule, but the promise settled at 402ms — the guard fails the run, it does
 * not cancel the 400ms handler already in flight. So even a guard that DOES fire
 * is not an upper bound on how long `run` takes to settle, and that is as true of
 * `maxElapsedMs` as it is of `deadlineMs`.
 *
 * The last line is the one that does not say "failed". `stopWhen` is the caller
 * asking, not a budget being spent, so the run ends `cancelled` and `run`
 * resolves with the Model rather than rejecting.
 */
