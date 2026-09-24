/**
 * The child program behind `../tool-fanout-kill.test.ts` (#179).
 *
 * A two-tool `defineAgent` at `toolConcurrency: 2` over a `fileStore`, asked for
 * both tools in one turn so they overlap inside their Cmd handlers (ADR 0018
 * option (c)). `quick` settles at once; `slow` parks until the parent drops a
 * release file, which run 1 never gets — so the parent's SIGKILL lands with one
 * call SETTLED and its sibling still RUNNING, which is the mid-fan-out window
 * the test is about.
 *
 * Every handler entry is appended to `TEA_CALLS_LOG` before it does anything, so
 * the count of real invocations survives the kill and is readable from outside.
 * That is the only honest way to ask what the resume re-ran.
 *
 * It is bundled and spawned by that test; it is not part of the published
 * surface and nothing imports it.
 */

import { appendFileSync, existsSync } from "node:fs";
import { z } from "zod";
import { fileStore } from "../../node";
import { type AgentMessage, type AgentTurn, defineAgent, tool } from "../index";

const log = process.env.TEA_CALLS_LOG ?? "";
const statePath = process.env.TEA_STATE ?? "";
const releasePath = process.env.TEA_RELEASE ?? "";

const slow = tool(
  "slow",
  {
    description: "Parks until the parent releases it.",
    input: z.object({}),
    ok: z.object({}),
    err: [],
  },
  async (_args, _ctx, { ok }) => {
    appendFileSync(log, "slow\n");
    while (!existsSync(releasePath)) {
      await new Promise((r) => setTimeout(r, 10));
    }
    return ok({});
  },
);

const quick = tool(
  "quick",
  {
    description: "Settles at once.",
    input: z.object({}),
    ok: z.object({}),
    err: [],
  },
  async (_args, _ctx, { ok }) => {
    appendFileSync(log, "quick\n");
    return ok({});
  },
);

const ASK: AgentTurn = {
  content: "both, please",
  // `q` FIRST, because settles fold in Cmd-emission order: a `q` behind a
  // parked `s` would wait for it, and there would be no window to kill in.
  toolCalls: [
    { callId: "q", name: "quick", args: {} },
    { callId: "s", name: "slow", args: {} },
  ],
};
const ANSWER: AgentTurn = { content: "both back", toolCalls: [] };

const agent = defineAgent({
  model: async (messages: readonly AgentMessage[]) => {
    // Read off the TRANSCRIPT, never a counter: a counter lives in the process,
    // so the resumed run would restart at zero and ask for both tools again —
    // which would be the fixture repeating work, not the library.
    const outcomes = messages.flatMap((m) =>
      m.role === "tool" ? [`${m.callId}:${m.outcome.kind}`] : [],
    );
    if (outcomes.length > 0) {
      process.stdout.write(`outcomes: ${outcomes.join(",")}\n`);
    }
    return outcomes.length === 0 ? ASK : ANSWER;
  },
  tools: [slow, quick],
  instructions: "Use both tools.",
  toolConcurrency: 2,
});

await agent.run("go", { store: fileStore(statePath, (raw) => raw as never) });
process.stdout.write("done\n");
