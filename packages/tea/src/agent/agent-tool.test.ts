import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Store } from "../index";
import {
  type AgentMessage,
  type AgentTurn,
  type AnyToolDef,
  agentTool,
  type DefinedAgentState,
  defineAgent,
  status,
  tool,
} from "./index";

// ---------------------------------------------------------------------------
// #333 — `agentTool`: a child `defineAgent` as a tool the parent awaits, keyed
// by the parent call's `callId` so a resumed parent resumes the child instead of
// restarting it.
//
// A "kill" here is the durable bytes and nothing else: every Store is a cell in
// one `Map<string, string>` that JSON-round-trips on save, and a killed process
// is a copy of that map taken at the moment under test. The process that wrote
// it is abandoned (its model call is left pending forever), and the resume runs
// fresh agents over the copy — exactly what a host booting after an eviction
// has to work with.
// ---------------------------------------------------------------------------

type Storage = Map<string, string>;

/** A durable cell at `key` in `storage`; `onSave` sees each committed Model. */
function cell<S>(
  storage: Storage,
  key: string,
  onSave: (state: S) => void = () => {},
): Store<S> {
  return {
    load: async () => {
      const raw = storage.get(key);
      return raw === undefined ? null : JSON.parse(raw);
    },
    save: async (state) => {
      storage.set(key, JSON.stringify(state));
      onSave(state);
    },
    migrate: (raw) => raw as S | null,
  };
}

/** One call site per process, so every count below is per process. */
type Counter = { readonly calls: string[] };

const Verdict = z.object({
  outcome: z.enum(["cleared", "not_cleared", "unclearable"]),
  summary: z.string(),
});

const CHILD_INSTRUCTIONS = "Clear the barrier you are given.";
const PARENT_INSTRUCTIONS = "Test the page; ask for help at a barrier.";

/** The child's one tool; `handled` counts real handler entries across processes. */
function pokeTool(handled: string[]) {
  return tool(
    "poke",
    {
      description: "Poke the barrier.",
      input: z.object({ at: z.string() }),
      ok: z.object({ moved: z.boolean() }),
      err: [],
    },
    async ({ at }, _ctx, { ok }) => {
      handled.push(at);
      return ok({ moved: true });
    },
  );
}

const POKE: AgentTurn = {
  content: "poking",
  toolCalls: [{ callId: "k1", name: "poke", args: { at: "modal" } }],
};
const CLEARED: AgentTurn = {
  content: JSON.stringify({ outcome: "cleared", summary: "closed the modal" }),
  toolCalls: [],
};

/**
 * The child's brain: poke once, then report. The decision is read off the
 * transcript, never a counter, so a resumed child asks for what it still owes.
 * `hold` parks the report call forever — the process that makes it is killed.
 */
function childModel(counter: Counter, hold = false) {
  return async (messages: readonly AgentMessage[]): Promise<AgentTurn> => {
    counter.calls.push(JSON.stringify(messages));
    const poked = messages.some((m) => m.role === "tool");
    if (!poked) return POKE;
    return hold ? new Promise<AgentTurn>(() => {}) : CLEARED;
  };
}

function unblocker(
  model: (messages: readonly AgentMessage[]) => Promise<AgentTurn>,
  handled: string[],
) {
  return defineAgent({
    model,
    tools: [pokeTool(handled)],
    instructions: CHILD_INSTRUCTIONS,
    maxTurns: 12,
  });
}

type ParentCtx = { readonly session: string };

function requestUnblock(
  child: ReturnType<typeof unblocker>,
  storage: Storage,
  onChildSave: (key: string, state: unknown) => void = () => {},
) {
  return agentTool("request_unblock", {
    description: "Hand a barrier to the unblocker and wait for its verdict.",
    input: z.object({ description: z.string() }),
    ok: Verdict,
    agent: child,
    prompt: ({ description }) => `Barrier: ${description}`,
    result: (output) => Verdict.parse(JSON.parse(output.content)),
    namespace: (ctx: ParentCtx) => ctx.session,
    store: (key) =>
      cell(storage, `child:${key}`, (state) => onChildSave(key, state)),
  });
}

const ASK_UNBLOCK: AgentTurn = {
  content: "stuck on a modal",
  toolCalls: [
    {
      callId: "u1",
      name: "request_unblock",
      args: { description: "a modal with no close button" },
    },
  ],
};
const PARENT_DONE: AgentTurn = { content: "journey resumed", toolCalls: [] };

/** The tester: ask for help once, then finish. Reads the transcript, not a counter. */
function parentModel(counter: Counter) {
  return async (messages: readonly AgentMessage[]): Promise<AgentTurn> => {
    counter.calls.push(JSON.stringify(messages));
    return messages.some((m) => m.role === "tool") ? PARENT_DONE : ASK_UNBLOCK;
  };
}

type ParentState = DefinedAgentState<ReturnType<typeof requestUnblock>>;

const RUN = { ctx: { session: "s1" }, runId: "tester", clock: () => 0 };

function tester(
  model: (messages: readonly AgentMessage[]) => Promise<AgentTurn>,
  unblock: ReturnType<typeof requestUnblock>,
) {
  return defineAgent({
    model,
    tools: [unblock],
    instructions: PARENT_INSTRUCTIONS,
  });
}

/** The uninterrupted run every resumed run is compared against. */
async function uninterrupted() {
  const storage: Storage = new Map();
  const handled: string[] = [];
  const child = unblocker(childModel({ calls: [] }), handled);
  const final = await tester(
    parentModel({ calls: [] }),
    requestUnblock(child, storage),
  ).run("test the checkout", {
    ...RUN,
    store: cell<ParentState>(storage, "parent"),
  });
  return { final, handled, storage };
}

/**
 * An uninterrupted run's final Model as a resumed run reaches it. The one field
 * a boot moves is the watchdog's `progressSeq`: monitored-run's `boot` bumps it
 * so the safety alarm re-arms under a fresh id. Everything else — transcript,
 * outcome, runId, timestamps — is the uninterrupted run's, and `toEqual` says so.
 */
function booted(baseline: ParentState): ParentState {
  if (baseline.run.phase === "idle") throw new Error("baseline never started");
  return {
    ...baseline,
    run: { ...baseline.run, progressSeq: baseline.run.progressSeq + 1 },
  };
}

/** Resolve on the first time `probe` answers non-null, polled per macrotask. */
async function until<T>(probe: () => T | null): Promise<T> {
  for (let i = 0; i < 1000; i++) {
    const got = probe();
    if (got !== null) return got;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error("never reached");
}

describe("agentTool — the parent awaits a child run's typed result (#333)", () => {
  it("settles the parent call with the value mapped from the child's final turn", async () => {
    const { final, handled, storage } = await uninterrupted();
    expect(final.run.phase).toBe("done");
    expect(final.output).toEqual(PARENT_DONE);
    expect(handled).toEqual(["modal"]);
    // The child ran under its own key, beside the parent, in one storage.
    expect([...storage.keys()].sort()).toEqual(["child:s1/u1", "parent"]);
  });

  it("the parent model reads the child's verdict as the call's result", async () => {
    const parent: Counter = { calls: [] };
    const storage: Storage = new Map();
    const child = unblocker(childModel({ calls: [] }), []);
    await tester(parentModel(parent), requestUnblock(child, storage)).run(
      "test the checkout",
      { ...RUN, store: cell(storage, "parent") },
    );
    const second = JSON.parse(parent.calls[1] ?? "[]") as AgentMessage[];
    expect(second.at(-1)).toEqual({
      role: "tool",
      callId: "u1",
      name: "request_unblock",
      outcome: {
        kind: "ok",
        result: { outcome: "cleared", summary: "closed the modal" },
      },
    });
  });
});

describe("agentTool — the child run is keyed by the parent call (#333)", () => {
  it("the same call reaches the same child run; a different call reaches another", async () => {
    const storage: Storage = new Map();
    const child: Counter = { calls: [] };
    const handled: string[] = [];
    const unblock = requestUnblock(
      unblocker(childModel(child), handled),
      storage,
    );
    const ctx = { session: "s1", emit: () => {} };
    const call = (callId: string) =>
      unblock.interpret(
        unblock({ callId, args: { description: "a modal" } }),
        ctx,
      );

    const first = await call("u1");
    const again = await call("u1");
    expect(again).toEqual(first);
    // The second firing resolved the ended child off its Store: no model call,
    // no tool call.
    expect(child.calls).toHaveLength(2);
    expect(handled).toEqual(["modal"]);

    await call("u2");
    expect(child.calls).toHaveLength(4);
    expect([...storage.keys()].sort()).toEqual(["child:s1/u1", "child:s1/u2"]);
    const runIdOf = (key: string) =>
      (JSON.parse(storage.get(key) ?? "{}") as { run: { runId: string } }).run
        .runId;
    expect(runIdOf("child:s1/u1")).toBe("s1/u1");
    expect(runIdOf("child:s1/u2")).toBe("s1/u2");
  });

  it("the namespace read off the parent ctx keeps two parents' calls apart", async () => {
    const storage: Storage = new Map();
    const unblock = requestUnblock(
      unblocker(childModel({ calls: [] }), []),
      storage,
    );
    for (const session of ["s1", "s2"]) {
      await unblock.interpret(
        unblock({ callId: "u1", args: { description: "a modal" } }),
        { session, emit: () => {} },
      );
    }
    expect([...storage.keys()].sort()).toEqual(["child:s1/u1", "child:s2/u1"]);
  });

  it("the child is told only the prompt derived from the call's args", async () => {
    const child: Counter = { calls: [] };
    const storage: Storage = new Map();
    await tester(
      parentModel({ calls: [] }),
      requestUnblock(unblocker(childModel(child), []), storage),
    ).run("test the checkout", { ...RUN, store: cell(storage, "parent") });
    expect(JSON.parse(child.calls[0] ?? "[]")).toEqual([
      { role: "system", content: CHILD_INSTRUCTIONS },
      { role: "user", content: "Barrier: a modal with no close button" },
    ]);
    for (const seen of child.calls) {
      expect(seen).not.toContain(PARENT_INSTRUCTIONS);
      expect(seen).not.toContain("test the checkout");
    }
  });
});

describe("agentTool — a killed parent resumes its child (#333)", () => {
  it("killed mid-child: the child resumes from its Store, and the parent ends where an uninterrupted run does", async () => {
    // Process 1: the child pokes (turn 1 and its tool settle), then its report
    // call parks forever. The bytes at that moment are the kill.
    const storage: Storage = new Map();
    const handled: string[] = [];
    const child1: Counter = { calls: [] };
    void tester(
      parentModel({ calls: [] }),
      requestUnblock(unblocker(childModel(child1, true), handled), storage),
    ).run("test the checkout", {
      ...RUN,
      store: cell<ParentState>(storage, "parent"),
    });
    await until(() => (child1.calls.length === 2 ? true : null));
    const killed: Storage = new Map(storage);

    const parentAtKill = JSON.parse(killed.get("parent") ?? "") as ParentState;
    expect(status(parentAtKill).kind).toBe("suspended");
    const childAtKill = JSON.parse(killed.get("child:s1/u1") ?? "") as {
      conversation: { turnCount: number; toolRecords: unknown[] };
    };
    expect(childAtKill.conversation.turnCount).toBe(1);
    expect(childAtKill.conversation.toolRecords).toHaveLength(1);
    expect(handled).toEqual(["modal"]);

    // Process 2: fresh agents over the killed bytes.
    const child2: Counter = { calls: [] };
    const parent2: Counter = { calls: [] };
    const final = await tester(
      parentModel(parent2),
      requestUnblock(unblocker(childModel(child2), handled), killed),
    ).run("test the checkout", {
      ...RUN,
      store: cell<ParentState>(killed, "parent"),
    });

    // The child model is called for the one turn that had not settled, and it
    // reads the transcript process 1 built; the settled poke is not re-run.
    expect(child2.calls).toHaveLength(1);
    expect(
      (JSON.parse(child2.calls[0] ?? "[]") as AgentMessage[]).map(
        (m) => m.role,
      ),
    ).toEqual(["system", "user", "assistant", "tool"]);
    expect(handled).toEqual(["modal"]);
    // The parent did not re-ask its settled turn either.
    expect(parent2.calls).toHaveLength(1);

    expect(final).toEqual(booted((await uninterrupted()).final));
  });

  it("killed after the child ended, before the parent folded it: the child is not restarted", async () => {
    // Process 1: copy the bytes the instant the child's ended Model is saved —
    // the parent is still waiting on the call it has not folded yet.
    const storage: Storage = new Map();
    let killed: Storage | null = null;
    const child1: Counter = { calls: [] };
    await tester(
      parentModel({ calls: [] }),
      requestUnblock(
        unblocker(childModel(child1), []),
        storage,
        (_key, state) => {
          const phase = (state as { run: { phase: string } }).run.phase;
          if (killed === null && phase === "done") killed = new Map(storage);
        },
      ),
    ).run("test the checkout", {
      ...RUN,
      store: cell<ParentState>(storage, "parent"),
    });
    const bytes = await until(() => killed);
    const parentAtKill = JSON.parse(bytes.get("parent") ?? "") as ParentState;
    expect(status(parentAtKill).kind).toBe("suspended");

    // Process 2: the re-fired call reaches the ended child and reads its
    // recorded outcome, with no child model call at all.
    const child2: Counter = { calls: [] };
    const handled2: string[] = [];
    const final = await tester(
      parentModel({ calls: [] }),
      requestUnblock(unblocker(childModel(child2), handled2), bytes),
    ).run("test the checkout", {
      ...RUN,
      store: cell<ParentState>(bytes, "parent"),
    });
    expect(child2.calls).toEqual([]);
    expect(handled2).toEqual([]);
    expect(final).toEqual(booted((await uninterrupted()).final));
  });
});

describe("agentTool — a child that does not finish settles an error the parent reads (#333)", () => {
  async function runWith(child: ReturnType<typeof unblocker>) {
    const parent: Counter = { calls: [] };
    const storage: Storage = new Map();
    const final = await tester(
      parentModel(parent),
      requestUnblock(child, storage),
    ).run("test the checkout", { ...RUN, store: cell(storage, "parent") });
    const second = JSON.parse(parent.calls[1] ?? "[]") as AgentMessage[];
    return { final, parent, last: second.at(-1) };
  }

  it("a child that hits its own maxTurns settles child_failed, and the parent loop goes on", async () => {
    const stubborn = defineAgent({
      model: async () => POKE,
      tools: [pokeTool([])],
      instructions: CHILD_INSTRUCTIONS,
      maxTurns: 1,
    });
    const { final, parent, last } = await runWith(stubborn);
    expect(last).toEqual({
      role: "tool",
      callId: "u1",
      name: "request_unblock",
      outcome: {
        kind: "error",
        _tag: "child_failed",
        childRunId: "s1/u1",
        failure: "turn_limit",
        reason: 'child_failed {"childRunId":"s1/u1","failure":"turn_limit"}',
      },
    });
    // The parent took its next turn and finished: nothing rejected or threw.
    expect(parent.calls).toHaveLength(2);
    expect(final.run.phase).toBe("done");
    expect(final.output).toEqual(PARENT_DONE);
  });

  it("a cancelled child settles child_cancelled", async () => {
    const stopped = defineAgent({
      model: async () => POKE,
      tools: [pokeTool([])],
      instructions: CHILD_INSTRUCTIONS,
      stopWhen: () => true,
    });
    const { final, last } = await runWith(stopped);
    expect(last).toMatchObject({
      role: "tool",
      outcome: {
        kind: "error",
        _tag: "child_cancelled",
        childRunId: "s1/u1",
      },
    });
    expect(final.run.phase).toBe("done");
  });
});

describe("agentTool — what the parent's tool carries (#355)", () => {
  it("an agent tool declares no content: the parent model reads the child's answer as data", () => {
    const unblock = requestUnblock(
      unblocker(childModel({ calls: [] }), []),
      new Map(),
    );
    expect(unblock.content).toBeNull();
  });

  it("a content function set on the spec at runtime is not handed on", () => {
    const spec = {
      description: "Hand a barrier over.",
      input: z.object({ description: z.string() }),
      ok: Verdict,
      agent: unblocker(childModel({ calls: [] }), []),
      prompt: ({ description }: { description: string }) => description,
      result: (output: AgentTurn) => Verdict.parse(JSON.parse(output.content)),
      namespace: (ctx: ParentCtx) => ctx.session,
      store: (key: string) => cell(new Map(), key),
      content: () => [{ type: "text", text: "leaked" }],
    };
    // The spec type has no `content`, so only a caller past the types can set
    // one; `as never` stands in for that caller.
    expect(agentTool("request_unblock", spec as never).content).toBeNull();
  });
});

describe("agentTool — the child's ctx (#355)", () => {
  const PEEK = {
    description: "Peek at the barrier.",
    input: z.object({}),
    ok: z.object({ peeked: z.boolean() }),
    err: [],
  } as const;

  /** A child whose one tool is `peek`: one call to it, then the verdict. */
  function childWith<T extends AnyToolDef>(peek: T) {
    return defineAgent({
      model: async (messages: readonly AgentMessage[]) =>
        messages.some((m) => m.role === "tool")
          ? CLEARED
          : {
              content: "peeking",
              toolCalls: [{ callId: "p1", name: "peek", args: {} }],
            },
      tools: [peek],
      instructions: CHILD_INSTRUCTIONS,
    });
  }

  const common = {
    description: "Hand a barrier to the unblocker and wait for its verdict.",
    input: z.object({ description: z.string() }),
    ok: Verdict,
    prompt: ({ description }: { description: string }) =>
      `Barrier: ${description}`,
    result: (output: AgentTurn) => Verdict.parse(JSON.parse(output.content)),
    namespace: (ctx: ParentCtx) => ctx.session,
    store: (key: string) => cell<never>(new Map(), `child:${key}`),
  };
  const PARENT = { session: "s1", emit: () => {} };

  it("a supplied childCtx is the ctx the child's tools are handed, derived from the parent's", async () => {
    const seen: unknown[] = [];
    const unblock = agentTool("request_unblock", {
      ...common,
      agent: childWith(
        tool(
          "peek",
          PEEK,
          async (_args, ctx: { readonly credential: string }, { ok }) => {
            seen.push(ctx);
            return ok({ peeked: true });
          },
        ),
      ),
      childCtx: (ctx) => ({ credential: `child-of:${ctx.session}` }),
    });
    const outcome = await unblock.interpret(
      unblock({ callId: "u1", args: { description: "a modal" } }),
      PARENT,
    );
    expect(outcome).toMatchObject({ _tag: "Ok" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ credential: "child-of:s1" });
    // The derived ctx is the child's whole ctx: the parent's is not merged in.
    expect(seen[0]).not.toHaveProperty("session");
  });

  it("an omitted childCtx hands the child none of the parent's ctx", async () => {
    const seen: unknown[] = [];
    const unblock = agentTool("request_unblock", {
      ...common,
      // `peek` names no ctx type, so the child reads none and `childCtx` is
      // optional; the handler still records what it was handed.
      agent: childWith(
        tool("peek", PEEK, async (_args, ctx, { ok }) => {
          seen.push(ctx);
          return ok({ peeked: true });
        }),
      ),
    });
    const outcome = await unblock.interpret(
      unblock({ callId: "u1", args: { description: "a modal" } }),
      PARENT,
    );
    expect(outcome).toMatchObject({ _tag: "Ok" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty("session");
  });
});
