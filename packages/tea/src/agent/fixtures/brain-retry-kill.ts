/**
 * The child program behind `../brain-retry-kill.test.ts` (#146).
 *
 * A no-tool `defineAgent` over a `fileStore` whose MODEL always throws, under a
 * 3-attempt lid `retry` with a backoff long enough that the parent can kill the
 * process while an attempt is owed rather than in flight. Every brain call is
 * appended to `TEA_ATTEMPTS_LOG` before it throws, so the count of real model
 * invocations survives the kill and is readable from outside — the only honest
 * way to assert that the resumed process did not buy an attempt the budget
 * never granted.
 *
 * It is bundled and spawned by that test; it is not part of the published
 * surface and nothing imports it.
 */

import { appendFileSync } from "node:fs";
import { DriveFailedError } from "../../index";
import { fileStore } from "../../node";
import { type AgentMessage, defineAgent } from "../index";

const log = process.env.TEA_ATTEMPTS_LOG ?? "";
const statePath = process.env.TEA_STATE ?? "";

const agent = defineAgent({
  model: async (_messages: readonly AgentMessage[]) => {
    appendFileSync(log, "attempt\n");
    throw new Error("429 from the provider");
  },
  tools: [],
  instructions: "Answer.",
  // No jitter, so the parent's kill window is deterministic; 600ms is long
  // enough that the process is provably parked between attempts.
  retry: {
    baseMs: 600,
    factor: 1,
    capMs: 600,
    jitter: "none",
    maxAttempts: 3,
  },
});

try {
  await agent.run("go", { store: fileStore(statePath, (raw) => raw as never) });
  process.stdout.write("resolved\n");
} catch (error) {
  const reason =
    error instanceof DriveFailedError
      ? ((error.state as { failure?: { reason?: string } }).failure?.reason ??
        "none")
      : "not-a-drive-failure";
  process.stdout.write(`failure: ${reason}\n`);
}
process.stdout.write("done\n");
