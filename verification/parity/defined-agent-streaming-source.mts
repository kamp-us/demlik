import assert from "node:assert/strict";
import { z } from "zod";
import {
  AGENT_EVENT_TYPES,
  type AgentMessage,
  agentEvents,
  type DefinedAgentState,
  defineAgent,
  type ModelStream,
  type TurnChunk,
  tool,
  toolRouter,
} from "../../packages/tea/src/agent/index.ts";
import { memoryStore } from "../../packages/tea/src/mem/index.ts";
import { driveToDone, run } from "../../packages/tea/src/promise/index.ts";
import { DriveFailedError } from "../../packages/tea/src/runtime-types.ts";

interface Args {
  input: string;
  nested: { owner: string };
}
interface Capture {
  chunks: TurnChunk[];
  warnings: unknown[];
  prompts: unknown[];
  events: unknown[];
  trace: string[];
  saves: unknown[];
  saveWires: string[];
  calls: number;
  streamCalls: number;
  final?: unknown;
  outcome: string;
}
const capture = (): Capture => ({
  chunks: [],
  warnings: [],
  prompts: [],
  events: [],
  trace: [],
  saves: [],
  saveWires: [],
  calls: 0,
  streamCalls: 0,
  outcome: "resolved",
});
const modes = [
  "watched",
  "omitted",
  "plain-sink",
  "raw",
  "throwing",
  "late",
  "isolation",
  "resume",
  "provider-failure",
];
const oldNow = Date.now;
Date.now = () => 50;
async function execute(mode: string, baseline = false) {
  const inputs = mode === "isolation" ? ["A", "B"] : ["A"],
    records = new Map<string, Capture>(),
    streams = new Map<string, ModelStream[]>();
  const turns = new Map(
    inputs.map((input) => [
      input,
      [
        {
          content: `tools-${input}`,
          toolCalls: [
            {
              callId: `${input}-call`,
              name: "lookup",
              args: { input, nested: { owner: `arg-${input}` } },
            },
          ],
          provider: { opaque: 17 },
          extra: { kept: true },
        },
        { content: `done-${input}`, toolCalls: [], provider: { opaque: 17 } },
      ],
    ]),
  );
  const results = new Map(
    inputs.map((input) => [
      input,
      { input, nested: { owner: `result-${input}` } },
    ]),
  );
  const provider = Object.assign(new Error("stream unavailable"), {
    code: "offline",
    nested: { owner: "provider" },
  });
  const lookup = tool(
    "lookup",
    {
      description: "look up",
      input: z.custom<Args>(),
      ok: z.custom<{ input: string; nested: { owner: string } }>(),
      err: ["never"],
    },
    async (args, _ctx, { ok }) => {
      assert.equal(args, turns.get(args.input)?.[0]?.toolCalls[0]?.args);
      const result = results.get(args.input);
      assert(result);
      return ok(result);
    },
  );
  type T = typeof lookup;
  type S = DefinedAgentState<T>;
  const body = async (
    messages: readonly AgentMessage[],
    stream?: ModelStream,
  ) => {
    const user = messages.find((m) => m.role === "user");
    assert(user?.role === "user" && typeof user.content === "string");
    const input = user.content,
      r = records.get(input);
    assert(r);
    r.calls++;
    r.prompts.push(messages);
    const second = messages.some((m) => m.role === "assistant");
    r.trace.push(`model:${second ? 1 : 0}`);
    if (stream) {
      r.streamCalls++;
      const previous = streams.get(input) ?? [];
      if (previous.length) assert.equal(stream, previous[0]);
      previous.push(stream);
      streams.set(input, previous);
      if (mode === "late" && second)
        previous[0]?.onChunk({ text: `after-turn-${input}` });
      for (const word of ["head", "middle", "tail"]) {
        const chunk = { text: `${second ? 1 : 0}:${word}-${input}` };
        stream.onChunk(chunk);
        assert(
          r.chunks.includes(chunk) ||
            mode === "omitted" ||
            mode === "raw" ||
            mode === "throwing",
        );
        await Promise.resolve();
      }
    }
    if (mode === "provider-failure") throw provider;
    if (second)
      for (const m of messages)
        if (m.role === "tool" && m.outcome.kind === "ok")
          assert.equal(m.outcome.result, results.get(input));
    const turn = turns.get(input)?.[second ? 1 : 0];
    assert(turn);
    return turn;
  };
  const streaming = async (
    messages: readonly AgentMessage[],
    stream: ModelStream,
  ) => body(messages, stream);
  const plain = async (
    messages: readonly AgentMessage[],
    ...rest: unknown[]
  ) => {
    assert.equal(rest.length, 0);
    return body(messages);
  };
  const agent = defineAgent({
    model: baseline || mode === "plain-sink" ? plain : streaming,
    tools: [lookup],
    instructions: "Stream progress, settle complete turns.",
  });
  const warn = console.warn;
  console.warn = (message, error: unknown) => {
    assert(error instanceof Error);
    const input = (error as Error & { owner: string }).owner;
    records.get(input)?.warnings.push({
      message,
      error: { name: error.name, message: error.message },
    });
  };
  async function drive(input: string, seed?: S) {
    const r = capture();
    records.set(input, r);
    const memory = memoryStore<S>(seed);
    const store = {
      ...memory,
      async save(s: S) {
        r.saves.push(s);
        r.saveWires.push(JSON.stringify(s));
        await memory.save(s);
      },
    };
    const onChunk = (chunk: TurnChunk) => {
      r.trace.push(`chunk:${chunk.text}`);
      r.chunks.push(chunk);
      if (mode === "throwing") {
        const error = Object.defineProperty(
          new Error("progress defect"),
          "owner",
          { value: input },
        );
        throw error;
      }
    };
    const onEvent = (e: unknown) => {
      r.events.push(e);
      assert(e && typeof e === "object" && "type" in e);
      r.trace.push(String(e.type));
    };
    try {
      if (mode === "raw" && !baseline) {
        const w = agent.machine(input);
        const h = run(w.machine, {
          ctx: {},
          store,
          clock: () => 50,
          interpret: w.interpret,
          subscribe: w.subscribe,
          terminal: (s) => s.run.phase === "done",
          events: agentEvents({ tools: toolRouter([lookup]) }),
        });
        for (const type of AGENT_EVENT_TYPES) h.on(type, onEvent);
        r.final = await driveToDone(
          h,
          { type: "agent_start", runId: "stream-run", at: 50 },
          (s) => s.run.phase === "done",
        );
      } else
        r.final = await agent.run(input, {
          store,
          clock: () => 50,
          runId: "stream-run",
          onEvent,
          ...(!baseline && mode !== "omitted" ? { onChunk } : {}),
        });
    } catch (error) {
      assert(error instanceof DriveFailedError);
      r.final = error.state;
      r.outcome = "failed";
      assert.equal(error.state?.failure?.reason, "llm");
      assert.equal(error.state?.failure?.error?.error, provider);
    }
    assert(r.saves.includes(r.final));
    if (seed) assert.equal(r.saves[0], seed);
    return r;
  }
  let phaseRecords: Capture[];
  if (mode === "isolation") {
    phaseRecords = await Promise.all(inputs.map((input) => drive(input)));
    if (!baseline) {
      streams.get("A")?.[0]?.onChunk({ text: "after-other-run-A" });
      assert.equal(phaseRecords[0]?.chunks.at(-1)?.text, "after-other-run-A");
      assert(
        !phaseRecords[1]?.chunks.some((c) => c.text === "after-other-run-A"),
      );
    }
  } else {
    const first = await drive("A");
    phaseRecords = [first];
    if (mode === "resume") {
      const seed = first.saves.find((s) => {
        const v = s as S;
        return (
          v.conversation?.awaiting.kind === "llm" &&
          v.conversation.toolRecords.length === 1
        );
      }) as S | undefined;
      assert(seed);
      streams.delete("A");
      phaseRecords.push(await drive("A", seed));
    }
    if (mode === "late" && !baseline) {
      streams.get("A")?.[0]?.onChunk({ text: "after-run-A" });
      assert.equal(first.chunks.at(-1)?.text, "after-run-A");
    }
  }
  console.warn = warn;
  return phaseRecords.map((r) => ({
    chunks: r.chunks,
    warnings: r.warnings,
    prompts: r.prompts,
    events: r.events,
    trace: r.trace,
    saves: r.saveWires.map((w) => JSON.parse(w)),
    saveWires: r.saveWires,
    calls: r.calls,
    streamCalls: r.streamCalls,
    outcome: r.outcome,
    final: r.final,
    finalWire: JSON.stringify(r.final),
  }));
}
for (const id of modes) {
  const phases = await execute(id),
    baseline = await execute(id, true);
  assert.equal(phases.length, baseline.length);
  phases.forEach((p, i) => {
    assert.deepEqual(p.saveWires, baseline[i]?.saveWires);
    assert.equal(p.finalWire, baseline[i]?.finalWire);
    if (id === "watched") assert.equal(p.chunks.length, 6);
    if (id === "omitted" || id === "raw" || id === "plain-sink")
      assert.equal(p.chunks.length, 0);
    if (id === "throwing") assert.equal(p.warnings.length, 6);
    if (id === "resume" && i === 1) {
      assert.equal(p.chunks.length, 3);
      assert(p.chunks.every((c) => c.text.startsWith("1:")));
    }
  });
  console.log(JSON.stringify({ id, phases, baseline }));
}
Date.now = oldNow;
