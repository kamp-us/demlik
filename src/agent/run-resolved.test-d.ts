// Type-level test for what `defineAgent(...).run` RESOLVES with (#155). Compiled
// by `pnpm typecheck` (tsc over `src/**` INCLUDES `*.test-d.ts`). Every
// `@ts-expect-error` MUST sit on a line that genuinely fails to type-check;
// every undirected line is a positive case that must compile.
//
// The contract: `run` resolves only on an ENDED run, so its resolved `run` slice
// is the `done` / `cancelled` subset and `final.run.runId` reads with no cast and
// no `phase` guard. The narrow is on the promise; the `idle` arm of the durable
// Model is untouched and still carries no `runId`.

import { z } from "zod";
import type { EndedRun } from "../internal/flow/monitored-run";
import { memoryStore } from "../mem";
import {
  type AgentTurn,
  type DefinedAgentState,
  defineAgent,
  tool,
} from "./index";

const clock = tool(
  "clock",
  {
    description: "Read the wall clock.",
    input: z.object({}),
    ok: z.object({ now: z.number() }),
    err: [],
  },
  async (_input, _ctx, { ok }) => ok({ now: 0 }),
);

declare const turn: AgentTurn;

const agent = defineAgent({
  model: async () => turn,
  tools: [clock],
  instructions: "tell the time",
});

// ── 1. the resolved run identity reads bare ─────────────────────────────────

async function identity() {
  const final = await agent.run("what time is it");
  // The whole point: no cast, no `if (final.run.phase !== "idle")` first.
  const id: string | null = final.run.runId;
  return id;
}

// A run resumed from an already-`done` stored Model resolves at the SAME type —
// the boot path and the start path share one promise, so neither reads wider.
async function resumed() {
  const store = memoryStore<DefinedAgentState<typeof clock>>();
  const final = await agent.run("what time is it", { store });
  const id: string | null = final.run.runId;
  return id;
}

// `cancelled` keeps its `string | null` identity, so the resolved id is not
// `string`: a run stopped before it ever started minted none.
async function notAlwaysMinted() {
  const final = await agent.run("what time is it");
  // @ts-expect-error `string | null` is not assignable to `string` — a run
  // cancelled before `start` has no `runId` to read.
  const id: string = final.run.runId;
  return id;
}

// ── 2. the ended subset, not the whole union ────────────────────────────────

declare const endedRun: EndedRun<string>;

// `done` and `cancelled` are the members …
const endedPhase: "done" | "cancelled" = endedRun.phase;

// … and `idle` is not one of them.
// @ts-expect-error `"idle"` is not a phase an ended run can hold.
const idlePhase: "idle" = endedRun.phase;

// ── 3. the durable Model is untouched ───────────────────────────────────────

declare const durable: DefinedAgentState<typeof clock>;

// `idle` is still an arm of the Model a Store holds …
const durablePhase: DefinedAgentState<typeof clock>["run"]["phase"] =
  "idle" as const;

// … and it still carries no `runId`: reading one off the wide Model is the
// error #155 started from, and it stays an error.
// @ts-expect-error `runId` does not exist on the `idle` arm.
const durableId = durable.run.runId;

export {
  durableId,
  durablePhase,
  endedPhase,
  identity,
  idlePhase,
  notAlwaysMinted,
  resumed,
};
