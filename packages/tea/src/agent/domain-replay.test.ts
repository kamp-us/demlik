import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { parseJSONL, recorder, replayTrace } from "../persistence";
import { driveToDone, run } from "../promise";
import { MsgType } from "../protocol";
import {
  type AgentDomain,
  type AgentMessage,
  type AgentTurn,
  type DefinedAgentMsg,
  type DefinedAgentState,
  type DefinedAgentWired,
  defineAgent,
  type ToolResult,
  tool,
} from "./index";

const PRE_CHANGE_KEYS = [
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
];

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

function scripted() {
  let calls = 0;
  return async (_messages: readonly AgentMessage[]) => {
    const turn = SCRIPT[calls];
    calls += 1;
    if (turn === undefined) throw new Error("the script ran out");
    return turn;
  };
}

function inertAgent() {
  return defineAgent({
    model: scripted(),
    tools: [tick],
    instructions: "Tick, then finish.",
    compaction: { afterTurns: 3, keepTurns: 0 },
    continueWhen: (state) =>
      state.conversation?.turnCount === 1 ? "keep going" : null,
  });
}

interface Seen {
  readonly turns: number;
  readonly tools: readonly string[];
  readonly nudges: number;
  readonly folded: number;
  readonly ats: readonly number[];
}

const SEEN: Seen = { turns: 0, tools: [], nudges: 0, folded: 0, ats: [] };

type Step = AgentDomain<Seen, ToolResult<typeof tick>>["step"];

const seen: Step = (slice, event) => {
  const stamped = { ...slice, ats: [...slice.ats, event.at] };
  return counted(stamped, event);
};

const counted: Step = (slice, event) => {
  switch (event._tag) {
    case "turn":
      return { ...slice, turns: slice.turns + 1 };
    case "tool":
      return {
        ...slice,
        tools: [...slice.tools, `${event.call.callId}:${event.outcome.kind}`],
      };
    case "nudge":
      return { ...slice, nudges: slice.nudges + 1 };
    case "compaction":
      return { ...slice, folded: slice.folded + event.folded };
  }
};

function domainAgent(step: Step) {
  return defineAgent({
    model: scripted(),
    tools: [tick],
    instructions: "Tick, then finish.",
    compaction: { afterTurns: 3, keepTurns: 0 },
    domain: { init: () => SEEN, step },
    continueWhen: (state) => (state.domain.nudges === 0 ? "keep going" : null),
  });
}

async function recordInert() {
  const wall = vi.spyOn(Date, "now").mockReturnValue(1_000);
  try {
    return await recordWith(inertAgent().machine("go"));
  } finally {
    wall.mockRestore();
  }
}

async function recordWith<D>(wired: DefinedAgentWired<typeof tick, D>) {
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
    expect(Object.keys(trace.loaded ?? {}).sort()).toEqual(PRE_CHANGE_KEYS);
  });

  it("records the same run live as the committed fixture holds", async () => {
    const { final, jsonl } = await recordInert();
    expect(final.run.phase).toBe("done");
    expect(parseJSONL<S, M>(jsonl)).toEqual(
      parseJSONL<S, M>(readFileSync(INERT, "utf8")),
    );
  });
});

type SD = DefinedAgentState<typeof tick, Seen>;

describe("an agent with a domain", () => {
  it("replays its recording with every step's domain slice matching", async () => {
    const { final, jsonl } = await recordWith(domainAgent(seen).machine("go"));
    expect(final.domain).toEqual({
      turns: 4,
      tools: ["a:ok", "b:error", "c:ok"],
      nudges: 1,
      folded: 3,
      ats: expect.any(Array),
    });
    expect(final.domain.ats).toHaveLength(9);
    const trace = parseJSONL<SD, M>(jsonl);

    const replayed = replayTrace(
      domainAgent(seen).machine("go").machine,
      trace,
    );

    expect(replayed.divergence).toBeUndefined();
    expect(replayed.matches).toBe(true);
    expect(replayed.states.map((s) => s.domain)).toEqual(
      trace.steps?.map((step) => step.state.domain),
    );
    expect(trace.loaded?.domain).toEqual(SEEN);

    let before = 0;
    for (const [i, step] of (trace.steps ?? []).entries()) {
      const msg: { readonly at?: number; readonly atMs?: number } = step.msg;
      const added = step.state.domain.ats.slice(before);
      for (const at of added) expect(at).toBe(msg.at ?? msg.atMs);
      expect(replayed.states[i]?.domain.ats).toEqual(step.state.domain.ats);
      before = step.state.domain.ats.length;
    }
    expect(before).toBe(9);
  });

  it("names state.domain at the first msg a changed step folds differently", async () => {
    const { jsonl } = await recordWith(domainAgent(seen).machine("go"));
    const trace = parseJSONL<SD, M>(jsonl);
    const drifted: Step = (slice, event) =>
      event._tag === "tool" && event.outcome.kind === "error"
        ? { ...slice, tools: [...slice.tools, "dropped"] }
        : seen(slice, event);

    const replayed = replayTrace(
      domainAgent(drifted).machine("go").machine,
      trace,
    );

    const firstErr = trace.msgs.findIndex((m) => m._tag === "tick_err");
    expect(firstErr).toBeGreaterThan(0);
    expect(replayed.matches).toBe(false);
    expect(replayed.divergence?.path).toMatch(/^state\.domain\b/);
    expect(replayed.divergence?.at?.index).toBe(firstErr);
    expect(replayed.divergence?.at?.msg._tag).toBe("tick_err");
  });

  it("adds only the domain key to the slice a no-domain agent starts from", () => {
    const [plain] = inertAgent().machine("go").machine.init(null, {});
    const [kept] = domainAgent(seen).machine("go").machine.init(null, {});
    expect(Object.keys(kept).sort()).toEqual(
      [...Object.keys(plain), "domain"].sort(),
    );
    expect(Object.keys(plain).sort()).toEqual(PRE_CHANGE_KEYS);
  });
});
