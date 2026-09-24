/**
 * The child program behind `../tool-retry-kill.test.ts` (#117).
 *
 * A one-tool `defineAgent` over a `fileStore`, whose tool ALWAYS fails and
 * declares a 3-attempt ladder with a long enough backoff that the parent can
 * kill the process while an attempt is owed rather than in flight. Every handler
 * entry is appended to `TEA_ATTEMPTS_LOG` before it decides, so the count of
 * real invocations survives the kill and is readable from outside — which is the
 * only honest way to assert that the resumed process did not buy an attempt the
 * budget never granted.
 *
 * It is bundled and spawned by that test; it is not part of the published
 * surface and nothing imports it.
 */

import { appendFileSync } from "node:fs";
import { z } from "zod";
import { fileStore } from "../../node";
import { type AgentMessage, type AgentTurn, defineAgent, tool } from "../index";

const log = process.env.TEA_ATTEMPTS_LOG ?? "";
const statePath = process.env.TEA_STATE ?? "";

const flaky = tool(
  "flaky",
  {
    description: "An upstream that is down for the whole run.",
    input: z.object({}),
    ok: z.object({}),
    err: ["upstream"],
    // No jitter, so the parent's kill window is deterministic; 600ms is long
    // enough that the process is provably parked between attempts.
    retry: {
      baseMs: 600,
      factor: 1,
      capMs: 600,
      jitter: "none",
      maxAttempts: 3,
    },
  },
  async (_args, _ctx, { fail }) => {
    appendFileSync(log, "attempt\n");
    return fail({ _tag: "upstream" });
  },
);

const ASK: AgentTurn = {
  content: "checking upstream",
  toolCalls: [{ callId: "c1", name: "flaky", args: {} }],
};
const GIVE_UP: AgentTurn = { content: "gave up", toolCalls: [] };

const agent = defineAgent({
  model: async (messages: readonly AgentMessage[]) => {
    // The decision is read off the TRANSCRIPT, never off a counter: a counter
    // lives in the process, so the resumed run would restart at zero and ask for
    // the tool a second time — which would be this fixture lying about how many
    // ladders ran, not the library repeating work.
    const outcomes = messages.flatMap((m) =>
      m.role === "tool" ? [m.outcome] : [],
    );
    for (const outcome of outcomes) {
      if (outcome.kind === "error") {
        process.stdout.write(`outcome: ${outcome.reason}\n`);
      }
    }
    return outcomes.length === 0 ? ASK : GIVE_UP;
  },
  tools: [flaky],
  instructions: "Use the tool.",
});

await agent.run("go", { store: fileStore(statePath, (raw) => raw as never) });
process.stdout.write("done\n");
