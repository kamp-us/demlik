/**
 * #117 — the per-tool `timeoutMs` / `retry` knob on the `tool()` spec.
 *
 * The wall the issue names is that a `defineAgent` user with one flaky tool has
 * no durable way to bound or retry it: the lid exposes only run-wide guards, and
 * the only reachable recourse — a `Promise.race` or a loop inside the handler —
 * puts the ladder INSIDE the effect boundary, where a crash loses it. So these
 * assertions are about the Model, not only the outcome: a retry that is waiting
 * is a `waiting_retry` phase on the durable slice with a timer Sub armed for it,
 * and a tool that declares neither field leaves no trace on the Model at all.
 *
 * The kill-and-resume half of the same promise runs as a real child process in
 * `./fixtures/tool-retry-kill.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { memoryStore } from "../mem";
import type { RetryPolicy } from "../retry-backoff";
import {
  type AgentMessage,
  type AgentTurn,
  defineAgent,
  type ToolOutcome,
  tool,
} from "./index";

/** No jitter and a 1ms base: the ladder's shape is the assertion, not its pace. */
const FAST: RetryPolicy = {
  baseMs: 1,
  factor: 1,
  capMs: 1,
  jitter: "none",
  maxAttempts: 3,
};

const ANSWER: AgentTurn = { content: "done", toolCalls: [] };

/** A turn that calls `name` once, under `callId`. */
function asks(name: string, callId = "c1"): AgentTurn {
  return { content: "working", toolCalls: [{ callId, name, args: {} }] };
}

/**
 * A model that plays `turns` in order, then answers — and keeps every message
 * list it was handed. The transcript is where the assertions live: a run that
 * reaches `done` has cleared its conversation, and what actually matters is what
 * the MODEL was shown, which is the whole point of settling a failure as data.
 */
function scripted(turns: readonly AgentTurn[]) {
  const seen: (readonly AgentMessage[])[] = [];
  let i = 0;
  const model = async (messages: readonly AgentMessage[]) => {
    seen.push(messages);
    return turns[i++] ?? ANSWER;
  };
  return { model, seen };
}

/** Every tool outcome the model was shown, across every call it was handed. */
function shown(seen: (readonly AgentMessage[])[]): ToolOutcome<unknown>[] {
  const last = seen.at(-1) ?? [];
  return last.flatMap((m) => (m.role === "tool" ? [m.outcome] : []));
}

/** The `reason` of every FAILED tool outcome the model was shown, in order. */
function reasons(seen: (readonly AgentMessage[])[]): string[] {
  return shown(seen).flatMap((o) => (o.kind === "error" ? [o.reason] : []));
}

describe("tool() — timeoutMs", () => {
  it("settles a slow call as a timeout, and the late result never overwrites it", async () => {
    // The handler takes far longer than the budget and then SUCCEEDS. Without
    // the knob the batch drains only when it finally resolves; with it the call
    // is over at the budget, and the run goes on around the attempt still in
    // flight — which is what "the ladder is on the Model" buys.
    const slow = tool(
      "slow",
      {
        description: "resolves long after its budget",
        input: z.object({}),
        ok: z.object({ late: z.boolean() }),
        err: [],
        timeoutMs: 10,
      },
      async (_args, _ctx, { ok }) => {
        await new Promise((r) => setTimeout(r, 300));
        return ok({ late: true });
      },
    );
    const { model, seen } = scripted([asks("slow")]);
    const agent = defineAgent({ model, tools: [slow], instructions: "i" });
    const final = await agent.run("go", { store: memoryStore() });
    expect(final.run.phase).toBe("done");
    // The model is shown exactly one outcome for the call, and it is the
    // timeout: the handler's late success arrives for a callId nothing is
    // waiting on any more, so it settles nothing.
    expect(shown(seen)).toEqual([{ kind: "error", reason: "timeout" }]);
  });

  it("leaves no ladder entry behind once the call is over", async () => {
    const slow = tool(
      "slow",
      {
        description: "resolves long after its budget",
        input: z.object({}),
        ok: z.object({}),
        err: [],
        timeoutMs: 5,
      },
      async (_args, _ctx, { ok }) => {
        await new Promise((r) => setTimeout(r, 200));
        return ok({});
      },
    );
    const { model } = scripted([asks("slow")]);
    const agent = defineAgent({ model, tools: [slow], instructions: "i" });
    const final = await agent.run("go", { store: memoryStore() });
    // A per-call entry that outlived its call would grow the durable slice once
    // per tool call for the whole run — and would keep a timeout Sub armed
    // against a call already folded into the conversation.
    expect(final.toolResilience.slow?.calls).toEqual({});
  });

  it("does not fire against a call that settled inside the budget", async () => {
    let calls = 0;
    const quick = tool(
      "quick",
      {
        description: "settles at once",
        input: z.object({}),
        ok: z.object({ n: z.number() }),
        err: [],
        timeoutMs: 5_000,
      },
      async (_args, _ctx, { ok }) => ok({ n: ++calls }),
    );
    const { model, seen } = scripted([asks("quick")]);
    const agent = defineAgent({ model, tools: [quick], instructions: "i" });
    const final = await agent.run("go", { store: memoryStore() });
    expect(calls).toBe(1);
    expect(reasons(seen)).toEqual([]);
    expect(final.toolResilience.quick?.calls).toEqual({});
  });
});

describe("tool() — retry", () => {
  it("re-runs a failing handler up to maxAttempts, then settles retry_exhausted", async () => {
    let calls = 0;
    const flaky = tool(
      "flaky",
      {
        description: "always fails",
        input: z.object({}),
        ok: z.object({}),
        err: ["upstream"],
        retry: FAST,
      },
      async (_args, _ctx, { fail }) => {
        calls += 1;
        return fail({ _tag: "upstream" });
      },
    );
    const { model, seen } = scripted([asks("flaky")]);
    const agent = defineAgent({ model, tools: [flaky], instructions: "i" });
    await agent.run("go", { store: memoryStore() });
    expect(calls).toBe(FAST.maxAttempts);
    // The model reads the real failure, not only the bookkeeping: the tag it
    // recovers from carries the attempt count AND the last attempt's own reason.
    expect(reasons(seen)).toEqual([
      `retry_exhausted ${JSON.stringify({ attempts: 3, last: "upstream" })}`,
    ]);
  });

  it("hides every absorbed attempt from the model — one record, not one per try", async () => {
    let calls = 0;
    const flaky = tool(
      "flaky",
      {
        description: "fails once",
        input: z.object({}),
        ok: z.object({ n: z.number() }),
        err: ["upstream"],
        retry: FAST,
      },
      async (_args, _ctx, { ok, fail }) => {
        calls += 1;
        return calls === 1 ? fail({ _tag: "upstream" }) : ok({ n: calls });
      },
    );
    const { model, seen } = scripted([asks("flaky")]);
    const agent = defineAgent({ model, tools: [flaky], instructions: "i" });
    await agent.run("go", { store: memoryStore() });
    expect(calls).toBe(2);
    // One call, one outcome. An absorbed attempt that reached the conversation
    // would show the model a failure the ladder had already dealt with.
    expect(shown(seen)).toEqual([{ kind: "ok", result: { n: 2 } }]);
  });

  it("runs two concurrent calls of one tool on independent ladders", async () => {
    const ran: string[] = [];
    const flaky = tool(
      "flaky",
      {
        description: "fails the first attempt of each call",
        input: z.object({ id: z.string() }),
        ok: z.object({ id: z.string() }),
        err: ["upstream"],
        retry: FAST,
      },
      async ({ id }, _ctx, { ok, fail }) => {
        ran.push(id);
        return ran.filter((s) => s === id).length === 1
          ? fail({ _tag: "upstream" })
          : ok({ id });
      },
    );
    const { model, seen } = scripted([
      {
        content: "two at once",
        toolCalls: [
          { callId: "c1", name: "flaky", args: { id: "a" } },
          { callId: "c2", name: "flaky", args: { id: "b" } },
        ],
      },
    ]);
    const agent = defineAgent({ model, tools: [flaky], instructions: "i" });
    await agent.run("go", { store: memoryStore() });
    // Each call spends its own attempt: a shared counter would have let the
    // second call inherit the first's spent budget and settle exhausted.
    expect(ran.filter((s) => s === "a")).toHaveLength(2);
    expect(ran.filter((s) => s === "b")).toHaveLength(2);
    expect(reasons(seen)).toEqual([]);
  });
});

describe("a tool that declares neither field", () => {
  it("keeps the plain fan-out path and leaves the ladder slice empty", async () => {
    let calls = 0;
    const bare = tool(
      "bare",
      {
        description: "fails, with nothing declared",
        input: z.object({}),
        ok: z.object({}),
        err: ["upstream"],
      },
      async (_args, _ctx, { fail }) => {
        calls += 1;
        return fail({ _tag: "upstream" });
      },
    );
    expect(bare.resilience).toBeNull();
    const { model, seen } = scripted([asks("bare")]);
    const agent = defineAgent({ model, tools: [bare], instructions: "i" });
    const final = await agent.run("go", { store: memoryStore() });
    // The first failure IS the outcome, reported with the tool's own tag —
    // byte for byte the behaviour that predates the knob.
    expect(calls).toBe(1);
    expect(reasons(seen)).toEqual(["upstream"]);
    expect(final.toolResilience).toEqual({});
  });
});

describe("the ladder slice is durable", () => {
  it("round-trips through JSON unchanged", async () => {
    const flaky = tool(
      "flaky",
      {
        description: "fails once",
        input: z.object({}),
        ok: z.object({ n: z.number() }),
        err: ["upstream"],
        retry: FAST,
        timeoutMs: 5_000,
      },
      async (_args, _ctx, { ok }) => ok({ n: 1 }),
    );
    const { model } = scripted([asks("flaky")]);
    const agent = defineAgent({ model, tools: [flaky], instructions: "i" });
    const final = await agent.run("go", { store: memoryStore() });
    expect(JSON.parse(JSON.stringify(final))).toEqual(final);
  });
});
