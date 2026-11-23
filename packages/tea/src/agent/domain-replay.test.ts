import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { parseJSONL, recorder, replayTrace } from "../persistence";
import { driveToDone, run } from "../promise";
import { MsgType } from "../protocol";
import {
  type AgentMessage,
  type AgentTurn,
  type DefinedAgentMsg,
  type DefinedAgentState,
  defineAgent,
  tool,
} from "./index";

const INERT = new URL("./fixtures/no-domain-run.jsonl", import.meta.url);

const tick = tool(
  "tick",
  {
    description: "Settle one tick",
    input: z.object({ fail: z.boolean() }),
    ok: z.object({ ticked: z.literal(true) }),
    err: ["refused"],
  },
  async (input, _ctx, { ok, fail }) =>
    input.fail ? fail({ _tag: "refused" }) : ok({ ticked: true }),
);

type S = DefinedAgentState<typeof tick>;
type M = DefinedAgentMsg<typeof tick>;

const SCRIPT: readonly AgentTurn[] = [
  {
    content: "two ticks",
    toolCalls: [
      { callId: "a", name: "tick", args: { fail: false } },
      { callId: "b", name: "tick", args: { fail: true } },
    ],
  },
  { content: "early", toolCalls: [] },
  {
    content: "one more",
    toolCalls: [{ callId: "c", name: "tick", args: { fail: false } }],
  },
  { content: "summary of the work", toolCalls: [] },
  { content: "finished", toolCalls: [] },
];

function inertAgent() {
  let calls = 0;
  return defineAgent({
    model: async (_messages: readonly AgentMessage[]) => {
      const turn = SCRIPT[calls];
      calls += 1;
      if (turn === undefined) throw new Error("the script ran out");
      return turn;
    },
    tools: [tick],
    instructions: "Tick, then finish.",
    compaction: { afterTurns: 3, keepTurns: 0 },
    continueWhen: (state) =>
      state.conversation?.turnCount === 1 ? "keep going" : null,
  });
}

async function recordInert() {
  const wall = vi.spyOn(Date, "now").mockReturnValue(1_000);
  try {
    return await recordWith();
  } finally {
    wall.mockRestore();
  }
}

async function recordWith() {
  const wired = inertAgent().machine("go");
  let tickAt = 1_000;
  const handle = run(wired.machine, {
    interpret: wired.interpret,
    subscribe: wired.subscribe,
    ctx: {},
    clock: () => tickAt++,
  });
  const rec = recorder(handle, { captureSteps: true });
  const final = await driveToDone(
    handle,
    { _tag: MsgType.AgentStart, runId: "inert", at: 1_000 },
    (s) => s.run.phase === "done",
    { failed: (s) => s.failure !== null },
  );
  await (await handle.ready).stop();
  return { final, jsonl: rec.toJSONL() };
}

describe("an agent with no domain", () => {
  it("replays a recording made before the domain slice existed, with no domain key in any state", async () => {
    if (process.env.TEA_FIXTURE_WRITE === "1") {
      writeFileSync(INERT, (await recordInert()).jsonl);
    }
    const trace = parseJSONL<S, M>(readFileSync(INERT, "utf8"));
    expect(trace.steps?.length).toBe(trace.msgs.length);
    expect(trace.msgs.length).toBeGreaterThan(8);

    const replayed = replayTrace(inertAgent().machine("go").machine, trace);

    expect(replayed.divergence).toBeUndefined();
    expect(replayed.matches).toBe(true);
    expect(replayed.actual.run.phase).toBe("done");
    for (const state of [trace.loaded, ...replayed.states]) {
      expect(Object.keys(state ?? {})).not.toContain("domain");
    }
    expect(Object.keys(trace.loaded ?? {}).sort()).toEqual([
      "compaction",
      "conversation",
      "failure",
      "instructions",
      "lifecycle",
      "output",
      "refusedCalls",
      "resilience",
      "run",
      "toolResilience",
      "tools",
      "usage",
    ]);
  });

  it("records the same run live as the committed fixture holds", async () => {
    const { final, jsonl } = await recordInert();
    expect(final.run.phase).toBe("done");
    expect(parseJSONL<S, M>(jsonl)).toEqual(
      parseJSONL<S, M>(readFileSync(INERT, "utf8")),
    );
  });
});
