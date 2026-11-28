/**
 * `AgentDomain.retain` — the slice owns a fact, so the transcript keeps the
 * projection instead of a second copy.
 *
 * The order is the whole contract: `step` folds the event as it SETTLED, and
 * only then does the row shape what the conversation, the fan-out, the run's
 * output and the brain call's settled result keep. A settle that folds
 * nothing — a late model success, an unknown or already-settled tool call —
 * projects nothing and leaves the conversation as it was.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { memoryStore } from "../mem";
import type { RetryPolicy } from "../retry-backoff";
import {
  type AgentDomain,
  type AgentDomainEvent,
  type AgentLlmErrMsg,
  type AgentLlmOkMsg,
  type AgentMessage,
  type AgentTurn,
  createAgent,
  defineAgent,
  type LlmRunCmd,
  type Schema,
  type ToolCall,
  tool,
} from "./index";

type Stage = "act";
type Purpose = "act_turn";
interface Outputs extends Record<Purpose, AgentTurn> {
  readonly act_turn: AgentTurn;
}
type ToolCmd = { readonly _tag: "run_tool" } & ToolCall;

/** A tool result whose `screen` the slice takes over. */
interface Read {
  readonly screen: string | null;
  readonly note: string;
}

/** What the slice keeps: the latest screen, and every event `step` saw. */
interface Screen {
  readonly screen: string | null;
  readonly seen: readonly AgentDomainEvent<Read>[];
}

const SCREEN: Screen = { screen: null, seen: [] };

const turnSchema: Schema<AgentTurn> = { parse: (v) => v as AgentTurn };

const call = (callId: string): ToolCall => ({
  callId,
  name: "read",
  args: {},
});

const turnWith = (provider: unknown, ...calls: ToolCall[]): AgentTurn => ({
  content: "thinking",
  toolCalls: calls,
  provider,
});

const brainRunCmd: LlmRunCmd<Purpose> = {
  _tag: "resilient_run",
  key: "act_turn",
  input: { purpose: "act_turn", model: null, payload: null },
};

const brainOk = (
  output: AgentTurn,
  at: number,
): AgentLlmOkMsg<Purpose, Outputs> => ({
  _tag: "resilient_run_ok",
  cmd: brainRunCmd,
  value: { key: "act_turn", purpose: "act_turn", output },
  at,
});

const brainErr = (at: number): AgentLlmErrMsg<Purpose> => ({
  _tag: "resilient_run_err",
  cmd: brainRunCmd,
  error: { _tag: "port_rejected", cause: "flaky" },
  at,
});

const RETRY: RetryPolicy = {
  baseMs: 1,
  factor: 1,
  capMs: 1,
  jitter: "none",
  maxAttempts: 3,
};

/**
 * An agent whose slice takes `screen` off each read and whose `retain` rows
 * drop it from the transcript. Every row call is counted so a settle that
 * projects nothing is visible as a call that never happened.
 */
function makeAgent(opts: { readonly retry?: RetryPolicy } = {}) {
  const projected = { turns: [] as AgentTurn[], tools: [] as string[] };
  const domain: AgentDomain<Screen, Read> = {
    init: () => SCREEN,
    step: (slice, event) => ({
      screen:
        event._tag === "tool" && event.outcome.kind === "ok"
          ? event.outcome.result.screen
          : slice.screen,
      seen: [...slice.seen, event],
    }),
    retain: {
      turnProvider: ({ turn }) => {
        projected.turns.push(turn);
        return { kept: "small" };
      },
      toolResult: ({ call, outcome }) => {
        projected.tools.push(call.callId);
        return { ...outcome.result, screen: null };
      },
    },
  };
  const agent = createAgent<
    Stage,
    Purpose,
    Outputs,
    Read,
    ToolCmd,
    unknown,
    Screen
  >({
    stages: ["act"],
    model: () => ({
      withStructuredOutput<T>(_s: Schema<T>) {
        return { invoke: (async () => turnWith(null)) as () => Promise<T> };
      },
    }),
    schemas: { act_turn: turnSchema },
    turnOf: () => "act_turn",
    toolOf: (c) => ({ _tag: "run_tool", ...c }),
    toolConcurrency: 2,
    domain,
    rng: () => 0,
    ...(opts.retry !== undefined ? { retry: opts.retry } : {}),
  });
  return { agent, projected };
}

const BIG = { kept: "small", raw: "x".repeat(64) };
const read = (screen: string): Read => ({ screen, note: `read ${screen}` });

describe("retain.turnProvider", () => {
  it("step folds the turn as it settled; the transcript, the output and the settled call keep the projection", () => {
    const { agent, projected } = makeAgent();
    const [started] = agent.start(agent.init(), "r", 0);
    const original = turnWith(BIG);
    const [done] = agent.succeed(started, brainOk(original, 5), 5);

    // `step` read the whole turn.
    expect(done.domain.seen).toEqual([{ _tag: "turn", at: 5, turn: original }]);
    // The row ran once, on the original.
    expect(projected.turns).toEqual([original]);
    // An empty turn ends the only stage: the run's output is the kept turn.
    const kept = { ...original, provider: { kept: "small" } };
    expect(done.run.phase).toBe("done");
    expect(done.output).toEqual(kept);
    // The brain call settled with the kept turn as its result.
    expect(done.resilience.calls.act_turn).toEqual({
      phase: "succeeded",
      result: { key: "act_turn", purpose: "act_turn", output: kept },
    });
  });

  it("a turn with tool calls keeps the projected provider in conversation.turns", () => {
    const { agent } = makeAgent();
    const [started] = agent.start(agent.init(), "r", 0);
    const original = turnWith(BIG, call("a"));
    const [s] = agent.succeed(started, brainOk(original, 1), 1);
    expect(s.conversation?.turns).toEqual([
      { ...original, provider: { kept: "small" } },
    ]);
    expect(s.domain.seen).toEqual([{ _tag: "turn", at: 1, turn: original }]);
  });

  it("a turn with no provider is kept as it is and the row does not run", () => {
    const { agent, projected } = makeAgent();
    const [started] = agent.start(agent.init(), "r", 0);
    const original: AgentTurn = { content: "c", toolCalls: [call("a")] };
    const [s] = agent.succeed(started, brainOk(original, 1), 1);
    expect(projected.turns).toEqual([]);
    expect(s.conversation?.turns).toEqual([original]);
  });

  it("a brain retry projects once, on the success that folds", () => {
    const { agent, projected } = makeAgent({ retry: RETRY });
    let [s] = agent.start(agent.init(), "r", 0);
    [s] = agent.fail(s, brainErr(1), 1);
    expect(projected.turns).toEqual([]);
    expect(s.domain.seen).toEqual([]);
    [s] = agent.onTimer(s, {
      _tag: "deadline_exceeded",
      id: "resilient:retry:act_turn",
      atMs: 2,
    });
    const original = turnWith(BIG, call("a"));
    [s] = agent.succeed(s, brainOk(original, 3), 3);
    expect(projected.turns).toEqual([original]);
    expect(s.conversation?.turns).toEqual([
      { ...original, provider: { kept: "small" } },
    ]);
  });
});

describe("retain — a settle that folds nothing projects nothing", () => {
  it("a model success after cancel never calls turnProvider and leaves the conversation alone", () => {
    const { agent, projected } = makeAgent();
    const [started] = agent.start(agent.init(), "r", 0);
    const [cancelled] = agent
      .toMachine<object>()
      .machine.update.agent_cancel(started, { _tag: "agent_cancel", at: 2 });
    const original = turnWith(BIG);
    const [late] = agent.succeed(cancelled, brainOk(original, 3), 3);

    expect(projected.turns).toEqual([]);
    expect(late.conversation).toEqual(cancelled.conversation);
    expect(late.domain).toEqual(cancelled.domain);
    expect(late.run).toEqual(cancelled.run);
    // The resilient call settles with the message exactly as it arrived.
    expect(late.resilience.calls.act_turn).toEqual({
      phase: "succeeded",
      result: { key: "act_turn", purpose: "act_turn", output: original },
    });
  });

  it("a second success for a turn that already settled never calls turnProvider", () => {
    const { agent, projected } = makeAgent();
    const [started] = agent.start(agent.init(), "r", 0);
    const [first] = agent.succeed(
      started,
      brainOk(turnWith(BIG, call("a")), 1),
      1,
    );
    expect(first.conversation?.awaiting.kind).toBe("tools");
    projected.turns.length = 0;

    const replayed = turnWith({ other: true }, call("b"));
    const [late] = agent.succeed(first, brainOk(replayed, 2), 2);
    expect(projected.turns).toEqual([]);
    expect(late.conversation).toEqual(first.conversation);
    expect(late.domain).toEqual(first.domain);
    expect(late.tools).toEqual(first.tools);
    expect(late.resilience.calls.act_turn).toEqual({
      phase: "succeeded",
      result: { key: "act_turn", purpose: "act_turn", output: replayed },
    });
  });

  it("an unknown or already-settled tool call never calls toolResult and changes nothing", () => {
    const { agent, projected } = makeAgent();
    const [started] = agent.start(agent.init(), "r", 0);
    const [asked] = agent.succeed(
      started,
      brainOk(turnWith(null, call("a"), call("b")), 1),
      1,
    );
    // The verb drains the lifecycle outbox on every call; the rest is the fold.
    const folded = ({ lifecycle: _, ...rest }: typeof asked) => rest;
    const [unknown] = agent.toolOk(asked, "zzz", read("u"), 2);
    expect(projected.tools).toEqual([]);
    expect(folded(unknown)).toEqual(folded(asked));

    const [once] = agent.toolOk(asked, "a", read("a"), 3);
    expect(projected.tools).toEqual(["a"]);
    const [twice] = agent.toolOk(once, "a", read("again"), 4);
    expect(projected.tools).toEqual(["a"]);
    expect(folded(twice)).toEqual(folded(once));
  });
});

describe("retain.toolResult", () => {
  it("step folds the result as it settled; the record and the fan-out keep the projection, also mid-batch", () => {
    const { agent, projected } = makeAgent();
    const [started] = agent.start(agent.init(), "r", 0);
    const [asked] = agent.succeed(
      started,
      brainOk(turnWith(null, call("a"), call("b")), 1),
      1,
    );

    // One of two settled: the batch is still draining.
    const [partial] = agent.toolOk(asked, "a", read("first"), 2);
    expect(partial.domain.screen).toBe("first");
    expect(partial.domain.seen.at(-1)).toEqual({
      _tag: "tool",
      at: 2,
      call: call("a"),
      outcome: { kind: "ok", result: read("first") },
    });
    expect(partial.conversation?.awaiting.kind).toBe("tools");
    expect(partial.conversation?.toolRecords).toEqual([
      {
        call: call("a"),
        outcome: { kind: "ok", result: { screen: null, note: "read first" } },
        turn: 0,
      },
    ]);
    expect(partial.tools.done).toEqual([
      {
        item: call("a"),
        result: { kind: "ok", result: { screen: null, note: "read first" } },
      },
    ]);

    // The second settles the batch, and the next brain call follows.
    const [drained] = agent.toolOk(partial, "b", read("second"), 3);
    expect(projected.tools).toEqual(["a", "b"]);
    expect(drained.domain.screen).toBe("second");
    expect(drained.conversation?.awaiting.kind).toBe("llm");
    expect(drained.conversation?.toolRecords.map((r) => r.outcome)).toEqual([
      { kind: "ok", result: { screen: null, note: "read first" } },
      { kind: "ok", result: { screen: null, note: "read second" } },
    ]);
  });

  it("a failure is kept as it settled and the row does not run", () => {
    const { agent, projected } = makeAgent();
    const [started] = agent.start(agent.init(), "r", 0);
    const [asked] = agent.succeed(
      started,
      brainOk(turnWith(null, call("a")), 1),
      1,
    );
    const [failed] = agent.toolErr(
      asked,
      "a",
      { _tag: "refused", kind: "error", reason: "no" },
      2,
    );
    expect(projected.tools).toEqual([]);
    expect(failed.conversation?.toolRecords).toEqual([
      {
        call: call("a"),
        outcome: { _tag: "refused", kind: "error", reason: "no" },
        turn: 0,
      },
    ]);
  });
});

describe("retain through defineAgent", () => {
  it("a retried tool is projected once, and the next prompt reads only the projection", async () => {
    let attempts = 0;
    const look = tool(
      "look",
      {
        description: "reads the screen, failing the first time",
        input: z.object({}),
        ok: z.object({ screen: z.string().nullable(), note: z.string() }),
        err: ["busy"],
        retry: RETRY,
      },
      async (_input, _ctx, { ok, fail }) => {
        attempts += 1;
        return attempts === 1
          ? fail({ _tag: "busy" })
          : ok({ screen: "SCREEN", note: "looked" });
      },
    );
    const seen: (readonly AgentMessage[])[] = [];
    const turns: AgentTurn[] = [
      {
        content: "look",
        toolCalls: [{ callId: "c1", name: "look", args: {} }],
      },
    ];
    let i = 0;
    const model = async (messages: readonly AgentMessage[]) => {
      seen.push(messages);
      return turns[i++] ?? { content: "done", toolCalls: [] };
    };
    const steps: AgentDomainEvent<{
      readonly screen: string | null;
      readonly note: string;
    }>[] = [];
    let rows = 0;
    const agent = defineAgent({
      model,
      tools: [look],
      instructions: "i",
      domain: {
        init: () => ({ screen: null as string | null }),
        step: (slice, event) => {
          steps.push(event);
          return event._tag === "tool" && event.outcome.kind === "ok"
            ? { screen: event.outcome.result.screen }
            : slice;
        },
        retain: {
          toolResult: ({ outcome }) => {
            rows += 1;
            return { ...outcome.result, screen: null };
          },
        },
      },
    });
    const final = await agent.run("go", { store: memoryStore() });

    expect(final.run.phase).toBe("done");
    expect(attempts).toBe(2);
    expect(rows).toBe(1);
    expect(final.domain).toEqual({ screen: "SCREEN" });
    expect(steps.filter((e) => e._tag === "tool")).toEqual([
      expect.objectContaining({
        outcome: { kind: "ok", result: { screen: "SCREEN", note: "looked" } },
      }),
    ]);
    const last = seen.at(-1) ?? [];
    expect(last.flatMap((m) => (m.role === "tool" ? [m.outcome] : []))).toEqual(
      [{ kind: "ok", result: { screen: null, note: "looked" } }],
    );
  });
});
