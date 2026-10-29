import assert from "node:assert/strict";
import { mock } from "node:test";
import { setImmediate } from "node:timers/promises";
import { z } from "zod";
import {
  type AgentMessage,
  type DefinedAgentState,
  defineAgent,
  tool,
} from "../../packages/tea/src/agent/index.ts";
import { memoryStore } from "../../packages/tea/src/mem/index.ts";

interface Args {
  index: number;
  nested: { owner: string };
}
const retry = {
  baseMs: 5,
  factor: 2,
  capMs: 20,
  jitter: "none" as const,
  maxAttempts: 2,
};
const cases = [
  "free-serial",
  "free-concurrent",
  "retry-recover",
  "retry-exhaust",
  "malformed-retry",
  "bare-failure",
  "timeout-late",
  "timeout-serial",
  "timeout-retries",
  "mixed",
  "resume",
  "resume-exhaust",
];
async function execute(id: string, seed?: unknown) {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: seed ? 100 : 50 });
  const args = Array.from({ length: id === "mixed" ? 5 : 2 }, (_, index) => ({
    index,
    nested: { owner: `arg-${index}` },
  }));
  const results = args.map((a) => ({
    index: a.index,
    attempt: 2,
    nested: { owner: `result-${a.index}` },
  }));
  const log: unknown[] = [],
    hooks: unknown[] = [],
    events: unknown[] = [],
    prompts: unknown[] = [],
    saveWires: string[] = [],
    snapshots: unknown[] = [];
  const attempts = Array.from({ length: args.length }, () => (seed ? 1 : 0));
  let active = 0,
    maxActive = 0,
    calls = 0,
    done = false,
    hookPending = 0;
  const policy =
    id.startsWith("free") || id === "bare-failure"
      ? {}
      : id === "timeout-late" || id === "timeout-serial"
        ? { timeoutMs: 10 }
        : id === "timeout-retries"
          ? { timeoutMs: 18, retry }
          : { retry };
  const make = (name: string, configured: boolean) =>
    tool(
      name,
      {
        description: name,
        input: z.custom<Args>(() => id !== "malformed-retry", "invalid"),
        ok: z.custom<(typeof results)[number]>(),
        err: ["busy"],
        ...(configured ? policy : {}),
      },
      async (a, _ctx, { ok, fail }) => {
        const i = a.index;
        assert.equal(a.nested.owner, `arg-${i}`);
        if (!seed) assert.equal(a, args[i]);
        const attempt = ++attempts[i];
        active++;
        maxActive = Math.max(maxActive, active);
        log.push({ kind: "start", index: i, attempt, at: Date.now() });
        const delay =
          id === "timeout-late" || id === "timeout-serial"
            ? 25
            : id === "timeout-retries"
              ? attempt === 1
                ? 3
                : 7
              : 2;
        await new Promise<void>((r) => setTimeout(r, delay));
        active--;
        log.push({ kind: "end", index: i, attempt, at: Date.now() });
        if (
          configured &&
          !id.startsWith("free") &&
          (id === "retry-exhaust" || id === "timeout-retries" || attempt === 1)
        )
          return fail({ _tag: "busy" });
        const result = results[i];
        assert(result);
        return ok(result);
      },
    );
  const configured = make("policy", true),
    plain = make("plain", false);
  type T = typeof configured;
  type S = DefinedAgentState<T>;
  const memory = memoryStore<S>(seed as S | undefined);
  const turns = [
    {
      content: "tools",
      toolCalls: args.map((a) => ({
        callId: `c${a.index}`,
        name: id === "mixed" && a.index % 2 === 1 ? "plain" : "policy",
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
    const final = seed || calls === 2;
    if (final) {
      const ids = messages.flatMap((m) =>
        m.role === "tool" ? [m.callId] : [],
      );
      assert.equal(ids.length, args.length);
      for (const m of messages)
        if (m.role === "tool" && m.outcome.kind === "ok") {
          const result = m.outcome.result;
          assert(results.some((r) => r === result));
        }
    }
    const turn = turns[final ? 1 : 0];
    assert(turn);
    return turn;
  };
  const agent = defineAgent({
    model,
    tools: [configured, plain],
    instructions: "Apply each tool policy.",
    ...(id === "free-serial" || id === "timeout-serial"
      ? {}
      : { toolConcurrency: id === "mixed" ? 3 : 2 }),
    onToolError: async (outcome, context) => {
      hookPending++;
      hooks.push({
        context,
        outcome,
        at: Date.now(),
        records: snapshots.length
          ? (JSON.parse(saveWires.at(-1) ?? "null")?.conversation?.toolRecords
              .length ?? 0)
          : 0,
      });
      await new Promise<void>((r) => setTimeout(r, 2));
      hookPending--;
      log.push({ kind: "hook-end", callId: context.callId, at: Date.now() });
    },
  });
  let final: S | undefined;
  const drive = agent
    .run("Complete.", {
      runId: "tool-policy-run",
      clock: () => Date.now(),
      store: {
        ...memory,
        async save(s) {
          snapshots.push(s);
          saveWires.push(JSON.stringify(s));
          await memory.save(s);
        },
      },
      onEvent: (e) => events.push(e),
    })
    .then((s) => {
      final = s;
    })
    .finally(() => {
      done = true;
    });
  for (let ticks = 0; !done && ticks < 200; ticks++) {
    await setImmediate();
    if (!done) mock.timers.tick(1);
  }
  await drive;
  assert(final);
  assert.equal(active, 0);
  assert.equal(calls, seed ? 1 : 2);
  assert(maxActive <= (id === "mixed" ? 3 : id === "free-serial" ? 1 : 2));
  const phase = {
    log,
    hookPending,
    maxActive,
    attempts,
    calls,
    hooks,
    prompts,
    events,
    saves: saveWires.map((w) => JSON.parse(w)),
    saveWires,
    final,
    finalWire: JSON.stringify(final),
    settledAt: Date.now(),
  };
  if (id === "bare-failure") assert.equal(hookPending, 0);
  if (id === "retry-exhaust") assert.equal(hookPending, seed ? 1 : 2);
  if (id === "retry-recover") assert.equal(hooks.length, 0);
  if (id === "retry-exhaust") {
    assert.equal(hooks.length, seed ? 1 : 2);
    for (const h of hooks) {
      assert.equal(
        (h as { outcome: { attempts: number } }).outcome.attempts,
        2,
      );
    }
  }
  if (id.startsWith("timeout")) {
    assert.equal(hooks.length, 2);
    for (const h of hooks)
      assert.equal(
        (h as { outcome: { _tag: string } }).outcome._tag,
        "timeout",
      );
  }
  mock.timers.reset();
  return { phase, snapshots };
}
for (const id of cases) {
  if (id === "resume" || id === "resume-exhaust") {
    const kind = id === "resume" ? "retry-recover" : "retry-exhaust";
    const first = await execute(kind);
    const seed = first.snapshots.find((s) => {
      const v = s as {
        toolResilience?: Record<
          string,
          { calls: Record<string, { phase: string }> }
        >;
      };
      if (id === "resume-exhaust")
        return Boolean(
          (
            s as {
              conversation?: { toolRecords: { outcome: { kind: string } }[] };
            }
          ).conversation?.toolRecords.some((r) => r.outcome.kind === "error"),
        );
      return Object.values(v.toolResilience?.policy?.calls ?? {}).some(
        (c) => c.phase === "waiting_retry",
      );
    });
    assert(seed);
    const second = await execute(kind, seed);
    console.log(JSON.stringify({ id, phases: [first.phase, second.phase] }));
  } else {
    const { phase } = await execute(id);
    console.log(JSON.stringify({ id, phases: [phase] }));
  }
}
