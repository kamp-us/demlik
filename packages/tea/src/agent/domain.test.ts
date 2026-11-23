import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Store } from "../index";
import { memoryStore } from "../mem";
import { recorder, replayTrace } from "../persistence";
import { driveToDone, run } from "../promise";
import { MsgType } from "../protocol";
import {
  type AgentDomain,
  type AgentDomainEvent,
  type AgentMessage,
  type AgentTurn,
  createAgent,
  type DefinedAgentState,
  defineAgent,
  MissingAgentDomainError,
  type Schema,
  type ToolCall,
  type ToolResult,
  tool,
  transcript,
} from "./index";

const tick = tool(
  "tick",
  {
    description: "Settle one tick, or refuse",
    input: z.object({ fail: z.boolean().optional() }),
    ok: z.object({ ticked: z.literal(true) }),
    err: ["refused"],
  },
  async (input, _ctx, { ok, fail }) =>
    input.fail === true ? fail({ _tag: "refused" }) : ok({ ticked: true }),
);

const slow = tool(
  "slow",
  {
    description: "Resolves long after its budget",
    input: z.object({}),
    ok: z.object({ late: z.literal(true) }),
    err: [],
    timeoutMs: 10,
  },
  async (_input, _ctx, { ok }) => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    return ok({ late: true });
  },
);

const hold = tool(
  "hold",
  {
    description: "Holds the run open past a late settle",
    input: z.object({}),
    ok: z.object({ held: z.literal(true) }),
    err: [],
  },
  async (_input, _ctx, { ok }) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return ok({ held: true });
  },
);

const TOOLS = [tick, slow, hold];
type Tools = (typeof TOOLS)[number];
type R = ToolResult<Tools>;
type Event = AgentDomainEvent<R>;

interface Tally {
  readonly stage: "working" | "nudged" | "compacted";
  readonly turns: number;
  readonly toolOk: number;
  readonly toolErr: readonly string[];
  readonly seen: readonly string[];
  readonly nudges: readonly string[];
  readonly folded: readonly number[];
}

const TALLY: Tally = {
  stage: "working",
  turns: 0,
  toolOk: 0,
  toolErr: [],
  seen: [],
  nudges: [],
  folded: [],
};

type Shape =
  | { readonly _tag: "turn"; readonly content: string }
  | {
      readonly _tag: "tool";
      readonly callId: string;
      readonly kind: string;
      readonly tag?: string;
    }
  | { readonly _tag: "nudge"; readonly turn: number; readonly text: string }
  | {
      readonly _tag: "compaction";
      readonly folded: number;
      readonly summary: string;
    };

function stepTally(slice: Tally, event: Shape): Tally {
  switch (event._tag) {
    case "turn":
      return { ...slice, turns: slice.turns + 1 };
    case "tool":
      return event.kind === "ok"
        ? {
            ...slice,
            toolOk: slice.toolOk + 1,
            seen: [...slice.seen, event.callId],
          }
        : {
            ...slice,
            toolErr: [...slice.toolErr, `${event.callId}:${event.tag}`],
            seen: [...slice.seen, event.callId],
          };
    case "nudge":
      return {
        ...slice,
        stage: "nudged",
        nudges: [...slice.nudges, event.text],
      };
    case "compaction":
      return {
        ...slice,
        stage: "compacted",
        folded: [...slice.folded, event.folded],
      };
  }
}

function shapeOf(event: Event): Shape {
  switch (event._tag) {
    case "turn":
      return { _tag: "turn", content: event.turn.content };
    case "tool":
      return event.outcome.kind === "ok"
        ? { _tag: "tool", callId: event.call.callId, kind: "ok" }
        : {
            _tag: "tool",
            callId: event.call.callId,
            kind: "error",
            tag: event.outcome._tag ?? "untagged",
          };
    case "nudge":
      return { _tag: "nudge", turn: event.nudge.turn, text: event.nudge.text };
    case "compaction":
      return {
        _tag: "compaction",
        folded: event.folded,
        summary: event.summary.content,
      };
  }
}

const tally: AgentDomain<Tally, R> = {
  init: () => TALLY,
  step: (slice, event) => stepTally(slice, shapeOf(event)),
};

function recording(log: Shape[], ats: number[] = []): AgentDomain<Tally, R> {
  return {
    init: () => TALLY,
    step: (slice, event) => {
      log.push(shapeOf(event));
      ats.push(event.at);
      return stepTally(slice, shapeOf(event));
    },
  };
}

const call = (
  callId: string,
  name: string,
  args: Readonly<Record<string, unknown>> = {},
): ToolCall => ({
  callId,
  name,
  args,
});

const SCRIPT: Readonly<Record<number, readonly ToolCall[]>> = {
  1: [call("a", "tick"), call("b", "tick")],
  2: [call("c", "tick", { fail: true }), call("d", "slow")],
  3: [call("e", "hold")],
  4: [],
  5: [call("f", "tick"), call("g", "tick")],
  6: [],
};
const SUMMARIZING = "Summarize the conversation so far.";

function stepper() {
  const calls: string[] = [];
  const model = async (
    messages: readonly AgentMessage[],
  ): Promise<AgentTurn> => {
    const last = [...messages]
      .reverse()
      .find((m) => m.role === "assistant")?.content;
    const k = Number(/(\d+)$/.exec(last ?? "")?.[1] ?? 0);
    const system = messages[0]?.role === "system" ? messages[0].content : "";
    if (system.startsWith(SUMMARIZING)) {
      calls.push(`summary ${k}`);
      return { content: `summary through step ${k}`, toolCalls: [] };
    }
    const toolCalls = SCRIPT[k + 1];
    if (toolCalls === undefined) throw new Error(`no step ${k + 1}`);
    calls.push(`step ${k + 1}`);
    return { content: `step ${k + 1}`, toolCalls };
  };
  return { model, calls };
}

type S = DefinedAgentState<Tools, Tally>;

function scriptedAgent(model: ReturnType<typeof stepper>["model"]) {
  return defineAgent({
    model,
    tools: TOOLS,
    instructions: "Work the script.",
    domain: tally,
    compaction: { afterTurns: 4, keepTurns: 0 },
    continueWhen: (state) =>
      state.domain.nudges.length === 0
        ? `nudged after ${state.domain.turns} turns`
        : null,
  });
}

function parking<T>(pick: (state: T) => boolean, from?: T) {
  const live = memoryStore<T>(from);
  const parked: T[] = [];
  const store: Store<T> = {
    ...live,
    save: async (state) => {
      await live.save(state);
      if (parked.length === 0 && pick(state)) {
        parked.push(JSON.parse(JSON.stringify(state)) as T);
      }
    },
  };
  return { store, parked };
}

const EXPECTED: readonly Shape[] = [
  { _tag: "turn", content: "step 1" },
  { _tag: "tool", callId: "a", kind: "ok" },
  { _tag: "tool", callId: "b", kind: "ok" },
  { _tag: "turn", content: "step 2" },
  { _tag: "tool", callId: "c", kind: "error", tag: "refused" },
  { _tag: "tool", callId: "d", kind: "error", tag: "timeout" },
  { _tag: "turn", content: "step 3" },
  { _tag: "tool", callId: "e", kind: "ok" },
  { _tag: "turn", content: "step 4" },
  { _tag: "nudge", turn: 3, text: "nudged after 4 turns" },
  { _tag: "compaction", folded: 4, summary: "summary through step 4" },
  { _tag: "turn", content: "step 5" },
  { _tag: "tool", callId: "f", kind: "ok" },
  { _tag: "tool", callId: "g", kind: "ok" },
  { _tag: "turn", content: "step 6" },
];

describe("an agent's domain slice", () => {
  it("survives two interrupted resumes through JSON and ends equal to the uninterrupted run and to a fold of the expected events", async () => {
    const whole = stepper();
    const first = parking<S>(
      (s) =>
        s.conversation?.turnCount === 1 &&
        s.conversation.awaiting.kind === "llm",
    );
    const uninterrupted = await scriptedAgent(whole.model).run("go", {
      store: first.store,
      runId: "durable",
    });
    expect(uninterrupted.run.phase).toBe("done");
    expect(whole.calls).toEqual([
      "step 1",
      "step 2",
      "step 3",
      "step 4",
      "summary 4",
      "step 5",
      "step 6",
    ]);

    const parkedOne = first.parked[0];
    expect(parkedOne?.domain).toEqual(
      EXPECTED.slice(0, 3).reduce(stepTally, TALLY),
    );
    const second = parking<S>(
      (s) => s.conversation?.awaiting.kind === "compacting",
      parkedOne,
    );
    const resumedOnce = stepper();
    await scriptedAgent(resumedOnce.model).run("go", { store: second.store });
    expect(resumedOnce.calls[0]).toBe("step 2");

    const parkedTwo = second.parked[0];
    expect(parkedTwo?.domain).toEqual(
      EXPECTED.slice(0, 10).reduce(stepTally, TALLY),
    );
    const resumedTwice = stepper();
    const final = await scriptedAgent(resumedTwice.model).run("go", {
      store: memoryStore(parkedTwo),
    });
    expect(resumedTwice.calls).toEqual(["summary 4", "step 5", "step 6"]);

    expect(final.run.phase).toBe("done");
    expect(final.domain).toEqual(uninterrupted.domain);
    expect(final.domain).toEqual(EXPECTED.reduce(stepTally, TALLY));
    expect(final.domain).toEqual({
      stage: "compacted",
      turns: 6,
      toolOk: 5,
      toolErr: ["c:refused", "d:timeout"],
      seen: ["a", "b", "c", "d", "e", "f", "g"],
      nudges: ["nudged after 4 turns"],
      folded: [4],
    });
  });

  it("replays the recording of that run to the same states, domain slice included", async () => {
    const wired = scriptedAgent(stepper().model).machine("go");
    const handle = run(wired.machine, {
      interpret: wired.interpret,
      subscribe: wired.subscribe,
      ctx: {},
    });
    const rec = recorder(handle, { captureSteps: true });
    const final = await driveToDone(
      handle,
      { _tag: MsgType.AgentStart, runId: "recorded", at: Date.now() },
      (s) => s.run.phase === "done",
      { failed: (s) => s.failure !== null },
    );
    await (await handle.ready).stop();
    expect(final.domain).toEqual(EXPECTED.reduce(stepTally, TALLY));

    const trace = rec.dump();
    const replayed = replayTrace(
      scriptedAgent(stepper().model).machine("go").machine,
      trace,
    );
    expect(replayed.divergence).toBeUndefined();
    expect(replayed.matches).toBe(true);
    expect(replayed.actual.domain).toEqual(final.domain);
  });

  it("folds turn, tool, nudge and compaction events in transcript order", async () => {
    const log: Shape[] = [];
    const ats: number[] = [];
    const issued: number[] = [];
    let t = 0;
    const wall = Date.now();
    const { model } = stepper();
    const final = await defineAgent({
      model,
      tools: TOOLS,
      instructions: "Work the script.",
      domain: recording(log, ats),
      compaction: { afterTurns: 4, keepTurns: 0 },
      continueWhen: (state) =>
        state.domain.nudges.length === 0
          ? `nudged after ${state.domain.turns} turns`
          : null,
    }).run("go", {
      clock: () => {
        t += 1;
        issued.push(t);
        return t;
      },
    });
    expect(final.run.phase).toBe("done");
    expect(log).toEqual(EXPECTED);
    expect(ats).toHaveLength(EXPECTED.length);
    for (const [i, event] of log.entries()) {
      const at = ats[i] ?? 0;
      if (event._tag === "compaction") {
        expect(at).toBeGreaterThanOrEqual(wall);
      } else if (event._tag === "tool" && event.tag === "timeout") {
        expect(issued).toContain(at - 10);
      } else if (event._tag === "nudge") {
        expect(at).toBe(ats[i - 1]);
      } else {
        expect(issued).toContain(at);
      }
    }
  });

  it("hands continueWhen the slice the just-settled turn produced", async () => {
    const seen: (readonly AgentMessage[])[] = [];
    const collected = transcript();
    const final = await defineAgent({
      model: async (messages: readonly AgentMessage[]) => {
        seen.push(messages);
        return { content: `turn ${seen.length}`, toolCalls: [] };
      },
      tools: TOOLS,
      instructions: "Answer.",
      domain: tally,
      maxTurns: 5,
      continueWhen: (state) =>
        state.domain.turns < 3 ? `turns seen: ${state.domain.turns}` : null,
    }).run("go", { onEvent: collected.onEvent });
    expect(final.run.phase).toBe("done");
    expect(seen).toHaveLength(3);
    expect(collected.read().nudges).toEqual([
      { turn: 0, text: "turns seen: 1" },
      { turn: 1, text: "turns seen: 2" },
    ]);
    expect(final.domain.nudges).toEqual(["turns seen: 1", "turns seen: 2"]);
  });

  it("hands stopWhen the slice after the drained batch, and stops before another model call", async () => {
    let calls = 0;
    const stops: number[] = [];
    const final = await defineAgent({
      model: async () => {
        calls += 1;
        return {
          content: "work",
          toolCalls: [call("x", "tick"), call("y", "tick", { fail: true })],
        };
      },
      tools: TOOLS,
      instructions: "Tick.",
      domain: tally,
      maxTurns: 3,
      stopWhen: (state) => {
        stops.push(state.domain.seen.length);
        return state.domain.toolErr.includes("y:refused");
      },
    }).run("go");
    expect(final.run.phase).toBe("cancelled");
    expect(calls).toBe(1);
    expect(stops).toEqual([2]);
    expect(final.domain.toolOk).toBe(1);
  });

  it("folds one tool event per failed or timed-out call and none for the late success", async () => {
    const log: Shape[] = [];
    let calls = 0;
    const turns: readonly AgentTurn[] = [
      { content: "fail", toolCalls: [call("c", "tick", { fail: true })] },
      { content: "slow", toolCalls: [call("d", "slow")] },
      { content: "hold", toolCalls: [call("e", "hold")] },
    ];
    const final = await defineAgent({
      model: async () => turns[calls++] ?? { content: "done", toolCalls: [] },
      tools: TOOLS,
      instructions: "Work.",
      domain: recording(log),
    }).run("go");
    expect(final.run.phase).toBe("done");
    expect(log.filter((e) => e._tag === "tool")).toEqual([
      { _tag: "tool", callId: "c", kind: "error", tag: "refused" },
      { _tag: "tool", callId: "d", kind: "error", tag: "timeout" },
      { _tag: "tool", callId: "e", kind: "ok" },
    ]);
    expect(final.domain.seen).toEqual(["c", "d", "e"]);
  });

  it("folds one turn event for a brain call that failed once and then answered", async () => {
    const log: Shape[] = [];
    let attempts = 0;
    const final = await defineAgent({
      model: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("429 from the provider");
        return { content: "answered", toolCalls: [] };
      },
      tools: TOOLS,
      instructions: "Answer.",
      domain: recording(log),
      retry: { baseMs: 1, factor: 1, capMs: 1, jitter: "none", maxAttempts: 2 },
    }).run("go");
    expect(attempts).toBe(2);
    expect(final.run.phase).toBe("done");
    expect(log).toEqual([{ _tag: "turn", content: "answered" }]);
  });
});

type Stage = "act";
type Purpose = "act_turn";
interface Outputs extends Record<Purpose, AgentTurn> {
  readonly act_turn: AgentTurn;
}
type KnobCmd = { readonly _tag: "run_tool" } & ToolCall;

const turnSchema: Schema<AgentTurn> = { parse: (v) => v as AgentTurn };

function knob(domain: AgentDomain<Tally, string>) {
  return createAgent<Stage, Purpose, Outputs, string, KnobCmd, string, Tally>({
    stages: ["act"],
    model: () => ({
      withStructuredOutput<T>(_s: Schema<T>) {
        return {
          invoke: (async () => ({
            content: "unused",
            toolCalls: [],
          })) as () => Promise<T>,
        };
      },
    }),
    schemas: { act_turn: turnSchema },
    turnOf: () => "act_turn",
    toolOf: (c) => ({ _tag: "run_tool", ...c }),
    domain,
    rng: () => 0,
  });
}

function withoutDomain<T extends object>(s: T): T {
  const copy = JSON.parse(JSON.stringify(s)) as T;
  Reflect.deleteProperty(copy, "domain");
  return copy;
}

const knobTally: AgentDomain<Tally, string> = {
  init: () => TALLY,
  step: (slice, event) =>
    event._tag === "turn" ? { ...slice, turns: slice.turns + 1 } : slice,
};

describe("the domain slice across the run's lifecycle", () => {
  it("leaves a re-fired boot's slice untouched", () => {
    const agent = knob(knobTally);
    const [started] = agent.start(agent.init(), "r1", 0);
    const [booted] = agent.boot(started, 1);
    const [rebooted] = agent.boot(booted, 2);
    expect(rebooted.domain).toBe(started.domain);
  });

  it("resets the slice for a new runId and keeps it for a repeated one", () => {
    const agent = knob(knobTally);
    const [started] = agent.start(agent.init(), "r1", 0);
    const [answered] = agent.turn(
      started,
      { content: "working", toolCalls: [call("t", "tick")] },
      1,
    );
    expect(answered.domain.turns).toBe(1);

    const [repeated, repeatCmds] = agent.start(answered, "r1", 2);
    expect(repeated).toBe(answered);
    expect(repeatCmds).toEqual([]);

    const [restarted] = agent.start(answered, "r2", 3);
    expect(restarted.domain).toEqual(TALLY);
  });

  it("seeds a finished Model saved without the slice when a new runId starts", () => {
    const agent = knob(knobTally);
    const [started] = agent.start(agent.init(), "r1", 0);
    const [finished] = agent.turn(
      started,
      { content: "done", toolCalls: [] },
      1,
    );
    expect(finished.run.phase).toBe("done");
    const saved = withoutDomain(finished);
    expect(Object.keys(saved)).not.toContain("domain");

    const [restarted] = agent.start(saved, "r2", 2);

    expect(restarted.run).toMatchObject({ phase: "running", runId: "r2" });
    expect(restarted.domain).toEqual(TALLY);
  });

  it("folds nothing for a second settle of a callId the batch already settled", () => {
    const agent = knob({
      init: () => TALLY,
      step: (slice, event) =>
        event._tag === "tool"
          ? { ...slice, seen: [...slice.seen, event.call.callId] }
          : slice,
    });
    const [started] = agent.start(agent.init(), "r1", 0);
    const [batched] = agent.turn(
      started,
      { content: "two", toolCalls: [call("p", "tick"), call("q", "tick")] },
      1,
    );
    const [first] = agent.toolOk(batched, "p", "ok", 2);
    expect(first.domain.seen).toEqual(["p"]);
    expect(first.conversation?.awaiting.kind).toBe("tools");

    const [again] = agent.toolOk(first, "p", "late", 3);

    expect(again.domain).toBe(first.domain);
    expect(again.conversation?.toolRecords).toHaveLength(1);
  });

  it("throws when step mutates the frozen slice it is handed", async () => {
    const errors: unknown[] = [];
    await expect(
      defineAgent({
        model: async () => ({ content: "done", toolCalls: [] }),
        tools: TOOLS,
        instructions: "Answer.",
        domain: {
          init: () => ({ turns: 0 }),
          step: (slice) => {
            slice.turns += 1;
            return slice;
          },
        },
      }).run("go", { onError: (error) => errors.push(error) }),
    ).rejects.toThrow();
    expect(errors).toContainEqual(
      expect.objectContaining({
        name: "TypeError",
        message: expect.stringMatching(/read only property 'turns'/),
      }),
    );
  });

  it("refuses a mid-run Model without the slice and seeds an idle one", async () => {
    const agent = knob(knobTally);
    const [started] = agent.start(agent.init(), "r1", 0);
    expect(() => agent.boot(withoutDomain(started), 1)).toThrow(
      MissingAgentDomainError,
    );

    const idle = withoutDomain(agent.init());
    expect(Object.keys(idle)).not.toContain("domain");
    const [seeded] = agent.boot(idle, 1);
    expect(seeded.domain).toEqual(TALLY);

    const plainRun = parking<DefinedAgentState<Tools>>(
      (s) => s.conversation?.turnCount === 1,
    );
    const { model } = stepper();
    await defineAgent({ model, tools: TOOLS, instructions: "Work." }).run(
      "go",
      { store: plainRun.store },
    );
    const legacy = plainRun.parked[0];
    expect(legacy?.run.phase).toBe("running");
    expect(Object.keys(legacy ?? {})).not.toContain("domain");
    const errors: unknown[] = [];
    await expect(
      scriptedAgent(stepper().model).run("go", {
        store: memoryStore(JSON.parse(JSON.stringify(legacy)) as S),
        onError: (error) => errors.push(error),
      }),
    ).rejects.toBeInstanceOf(MissingAgentDomainError);
    expect(errors).toEqual([expect.any(MissingAgentDomainError)]);
  });
});
