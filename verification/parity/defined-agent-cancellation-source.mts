import assert from "node:assert/strict";
import { z } from "zod";
import {
  type AgentMessage,
  type DefinedAgentState,
  defineAgent,
  type ModelStream,
  tool,
} from "../../packages/tea/src/agent/index.ts";
import { memoryStore } from "../../packages/tea/src/mem/index.ts";

function gate() {
  let open!: () => void;
  const wait = new Promise<void>((r) => {
    open = r;
  });
  return { wait, open };
}
const clone = (v: unknown) => JSON.parse(JSON.stringify(v));
const oldNow = Date.now;
Date.now = () => 50;
const modes = [
  "preabort",
  "provider",
  "serial-ok",
  "serial-typed",
  "concurrent-ok",
  "concurrent-typed",
  "concurrent-thrown",
  "done",
  "omitted",
];
for (const id of modes) {
  const controller = new AbortController(),
    started = gate(),
    release = gate(),
    finished = gate();
  const releases = Array.from({ length: 3 }, gate),
    ends = Array.from({ length: 3 }, gate),
    hookEnds = Array.from({ length: 3 }, gate);
  const trace: string[] = [],
    prompts: unknown[] = [],
    events: unknown[] = [],
    hooks: unknown[] = [],
    chunks: unknown[] = [],
    wires: string[] = [],
    saves: unknown[] = [];
  const arg = { token: "args", nested: { owner: "arg" } },
    result = { token: "result", nested: { owner: "result" } },
    declared = { _tag: "denied" as const, detail: { owner: "error" } };
  let calls = 0,
    toolCalls = 0,
    completed = 0,
    stream: ModelStream | undefined;
  const concurrent = id.startsWith("concurrent"),
    n = concurrent ? 3 : 1;
  const first = {
    content: "lookup",
    toolCalls: Array.from({ length: n }, (_, i) => ({
      callId: `c${i}`,
      name: "lookup",
      args: arg,
    })),
    provider: { kept: true },
  };
  const answer = { content: "done", toolCalls: [], provider: { kept: true } };
  const lookup = tool(
    "lookup",
    {
      description: "look up",
      input: z.custom<typeof arg>(),
      ok: z.custom<typeof result>(),
      err: ["denied"],
    },
    async (a, _ctx, { ok, fail }) => {
      assert.equal(a, arg);
      const i = toolCalls++;
      trace.push(`tool:start:${i}`);
      if (toolCalls === n) started.open();
      if (id !== "omitted") await releases[i]?.wait;
      trace.push(`tool:end:${i}`);
      ends[i]?.open();
      if (++completed === n) finished.open();
      if (id.endsWith("typed")) return fail(declared);
      if (id.endsWith("thrown"))
        throw Object.assign(new Error("lookup unavailable"), {
          owner: "thrown",
        });
      return ok(result);
    },
  );
  type S = DefinedAgentState<typeof lookup>;
  const model = async (
    messages: readonly AgentMessage[],
    sink: ModelStream,
  ) => {
    calls++;
    prompts.push(clone(messages));
    trace.push(`model:${calls}`);
    stream = sink;
    const chunk = { text: `chunk:${calls}` };
    sink.onChunk(chunk);
    assert.equal(chunks.at(-1), chunk);
    if (id === "provider") {
      started.open();
      await release.wait;
      trace.push("model:end");
      finished.open();
    }
    return id === "done" || calls > 1 ? answer : first;
  };
  const agent = defineAgent({
    model,
    tools: [lookup],
    instructions: "Cancel the lookup.",
    ...(concurrent ? { toolConcurrency: 3 } : {}),
    onToolError: (failure, context) => {
      hooks.push(clone({ failure, context }));
      trace.push(`hook:${context.callId}`);
      if (id.endsWith("typed"))
        assert("detail" in failure && failure.detail === declared.detail);
      hookEnds[Number(context.callId.slice(1))]?.open();
    },
  });
  const live = memoryStore<S>();
  const store = {
    ...live,
    async save(s: S) {
      wires.push(JSON.stringify(s));
      saves.push(s);
      await live.save(s);
    },
  };
  if (id === "preabort") controller.abort();
  const running = agent.run("go", {
    store,
    runId: "run",
    clock: () => 50,
    ...(id === "omitted" ? {} : { signal: controller.signal }),
    onEvent: (e) => events.push(clone(e)),
    onChunk: (c) => chunks.push(c),
  });
  if (!["preabort", "done", "omitted"].includes(id)) {
    await started.wait;
    trace.push("abort");
    controller.abort();

    if (id === "provider") release.open();
    else
      for (let i = 0; i < n; i++) {
        releases[i]?.open();
        await ends[i]?.wait;
        if (id.endsWith("typed") || id.endsWith("thrown"))
          await hookEnds[i]?.wait;
      }
    await finished.wait;
  }
  const final = await running;
  trace.push("resolved");
  if (id === "done") {
    controller.abort();
    trace.push("abort:after-done");
  }
  stream?.onChunk({ text: "after-run" });
  const before = {
    saves: wires.length,
    events: events.length,
    hooks: hooks.length,
  };
  // Every released handler has finished before this snapshot; no timer guesses.
  const resumedWires: string[] = [],
    resumedEvents: unknown[] = [];
  const seed = final;
  const resumed = await agent.run("go", {
    store: {
      ...memoryStore<S>(seed),
      save: async (s) => {
        resumedWires.push(JSON.stringify(s));
      },
    },
    runId: "resumed",
    clock: () => 50,
    signal: new AbortController().signal,
    onEvent: (e) => resumedEvents.push(clone(e)),
  });
  assert.equal(resumed, seed);
  assert.equal(calls, id === "preabort" ? 0 : id === "omitted" ? 2 : 1);
  assert.deepEqual(before, {
    saves: wires.length,
    events: events.length,
    hooks: hooks.length,
  });
  console.log(
    JSON.stringify({
      id,
      trace,
      prompts,
      events,
      hooks,
      chunks,
      toolCalls,
      completed,
      calls,
      saves: wires.map((w) => JSON.parse(w)),
      saveWires: wires,
      final,
      finalWire: JSON.stringify(final),
      resume: {
        saveWires: resumedWires,
        events: resumedEvents,
        final: resumed,
        finalWire: JSON.stringify(resumed),
      },
    }),
  );
}
Date.now = oldNow;
