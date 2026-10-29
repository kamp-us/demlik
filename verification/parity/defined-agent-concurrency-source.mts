import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { z } from "zod";
import {
  AGENT_EVENT_TYPES,
  type AgentMessage,
  agentEvents,
  type DefinedAgentState,
  defineAgent,
  tool,
  toolRouter,
} from "../../packages/tea/src/agent/index.ts";
import { memoryStore } from "../../packages/tea/src/mem/index.ts";
import { driveToDone, run } from "../../packages/tea/src/promise/index.ts";

interface Args {
  index: number;
  nested: { owner: string };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function until(predicate: () => boolean, label: string) {
  for (let n = 0; n < 200; n++) {
    if (predicate()) return;
    await setImmediate();
  }
  assert.fail(label);
}
const cases = [
  { id: "unset" },
  { id: "one", limit: 1 },
  { id: "two", limit: 2 },
  { id: "waves", limit: 2, count: 5 },
  { id: "failure", limit: 2, failure: true },
  { id: "raw", limit: 2, raw: true },
];
for (const c of cases) {
  const count = c.count ?? 2,
    width = c.limit ?? 1;
  const args = Array.from({ length: count }, (_, index) => ({
    index,
    nested: { owner: `arg-${index}` },
  }));
  const results = args.map((a) => ({
    index: a.index,
    nested: { owner: `result-${a.index}` },
  }));
  const gates = args.map(deferred),
    hookGate = deferred();
  const log: string[] = [],
    prompts: unknown[] = [],
    events: unknown[] = [],
    saveWires: string[] = [],
    settlements: string[] = [];
  let active = 0,
    maxActive = 0,
    calls = 0;
  const make = (name: string) =>
    tool(
      name,
      {
        description: name,
        input: z.custom<Args>(),
        ok: z.custom<Args>(),
        err: ["broken"],
      },
      async (a, _ctx, { ok, fail }) => {
        assert.equal(a, args[a.index]);
        assert.equal(a.nested, args[a.index]?.nested);
        log.push(`start:${a.index}`);
        active++;
        maxActive = Math.max(maxActive, active);
        await gates[a.index]?.promise;
        active--;
        log.push(`end:${a.index}`);
        if (c.failure && a.index === 0) return fail({ _tag: "broken" });
        return ok(results[a.index]);
      },
    );
  const first = make("first"),
    second = make("second");
  type T = typeof first;
  type S = DefinedAgentState<T>;
  const memory = memoryStore<S>();
  const turns = [
    {
      content: "tools",
      toolCalls: args.map((a, index) => ({
        callId: `c${index}`,
        name: index % 2 === 0 ? "first" : "second",
        args: a,
      })),
      provider: { opaque: 17 },
      extra: { kept: true },
    },
    { content: "done", toolCalls: [], provider: { opaque: 17 } },
  ];
  const model = async (messages: readonly AgentMessage[]) => {
    prompts.push(messages);
    calls++;
    if (calls === 2) {
      assert.equal(active, 0);
      assert.deepEqual(
        messages.flatMap((m) => (m.role === "tool" ? [m.callId] : [])),
        args.map((a) => `c${a.index}`),
      );
      for (const m of messages)
        if (m.role === "tool" && m.outcome.kind === "ok") {
          const value = m.outcome.result;
          assert(results.some((r) => r === value));
        }
    }
    const turn = turns[calls - 1];
    assert(turn);
    return turn;
  };
  const agent = defineAgent({
    model,
    tools: [first, second],
    instructions: "Run the tools.",
    ...(c.limit === undefined ? {} : { toolConcurrency: c.limit }),
    onToolError: async (outcome, context) => {
      assert.equal(outcome._tag, "broken");
      log.push(`hook:${context.callId}`);
      await hookGate.promise;
      log.push(`hook-end:${context.callId}`);
    },
  });
  const store = {
    ...memory,
    async save(s: S) {
      saveWires.push(JSON.stringify(s));
      const records = s.conversation?.toolRecords ?? [];
      for (const record of records) {
        assert.equal(
          record.call,
          turns[0]?.toolCalls[Number(record.call.callId.slice(1))],
        );
        if (!settlements.includes(record.call.callId))
          settlements.push(record.call.callId);
      }
      await memory.save(s);
    },
  };
  const oldNow = Date.now;
  Date.now = () => 50;
  let final: S | undefined;
  const drive = c.raw
    ? (async () => {
        const w = agent.machine("Complete.");
        const h = run(w.machine, {
          ctx: {},
          store,
          clock: () => 50,
          interpret: w.interpret,
          subscribe: w.subscribe,
          terminal: (s) => s.run.phase === "done",
          events: agentEvents({ tools: toolRouter([first, second]) }),
        });
        for (const type of AGENT_EVENT_TYPES) h.on(type, (e) => events.push(e));
        return driveToDone(
          h,
          { type: "agent_start", runId: "concurrency-run", at: 50 },
          (s) => s.run.phase === "done",
        );
      })()
    : agent.run("Complete.", {
        store,
        clock: () => 50,
        runId: "concurrency-run",
        onEvent: (e) => events.push(e),
      });
  const waiting = drive.then((s) => {
    final = s;
  });
  for (let base = 0; base < count; base += width) {
    const end = Math.min(base + width, count);
    await until(
      () => log.includes(`start:${end - 1}`),
      "all admitted handlers start before release",
    );
    assert.equal(calls, 1);
    assert.deepEqual(
      settlements,
      args.slice(0, base).map((a) => `c${a.index}`),
    );
    for (let index = end - 1; index >= base; index--) {
      gates[index]?.resolve();
      await until(() => log.includes(`end:${index}`), "handler completes");
      if (index > base) {
        assert.equal(calls, 1);
        assert.deepEqual(
          settlements,
          args.slice(0, base).map((a) => `c${a.index}`),
        );
      }
    }
    if (c.failure && base === 0) {
      await until(() => log.includes("hook:c0"), "failure reaches hook");
      assert.equal(calls, 1);
      assert.deepEqual(settlements, []);
      hookGate.resolve();
    }
    await until(() => settlements.length >= end, "emission ordered folds");
  }
  await waiting;
  Date.now = oldNow;
  assert(final);
  assert.equal(calls, 2);
  assert.equal(maxActive, Math.min(width, count));
  assert.deepEqual(
    settlements,
    args.map((a) => `c${a.index}`),
  );
  console.log(
    JSON.stringify({
      id: c.id,
      phase: {
        log,
        maxActive,
        calls,
        settlements,
        prompts,
        events,
        saves: saveWires.map((w) => JSON.parse(w)),
        saveWires,
        final,
        finalWire: JSON.stringify(final),
      },
    }),
  );
}
