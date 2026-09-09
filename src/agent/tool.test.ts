import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Cmd, type PortEmitter, run } from "../index";
import { MsgType } from "../protocol";
import { bindMachine } from "../testing";
import {
  type AgentEvent,
  type AgentLlmOkMsg,
  type AgentTurn,
  agentEvents,
  createAgent,
  isReservedToolName,
  type Schema,
  type ToolCall,
  type ToolConstructors,
  type ToolRecord,
  tool,
  toolErrorReason,
  toolRouter,
} from "./index";

// ---------------------------------------------------------------------------
// #56 — `tool()` + `toolRouter()`: one declaration yields the `toolOf` entry
// and the interpret cell; the cells settle through the minted `<name>_ok` /
// `<name>_err`, and `toMachine({ tools })` folds those into the conversation.
// ---------------------------------------------------------------------------

type Kb = { readonly lookup: (q: string) => string | undefined };
type KbCtx = { readonly kb: Kb };

const search = tool(
  "search",
  {
    description: "Look a phrase up in the knowledge base.",
    input: z.object({ q: z.string() }),
    ok: z.object({ snippet: z.string() }),
    err: ["not_found"],
    needs: Cmd.needs<KbCtx>(),
  },
  async ({ q }, ctx, { ok, fail }) => {
    if (q === "boom") throw new Error("kb offline");
    if (q === "boom-tagged") throw { _tag: "not_found", via: "throw" };
    const snippet = ctx.kb.lookup(q);
    if (snippet === undefined) return fail({ _tag: "not_found", q });
    // Widened first: `ok` refuses an excess property in a literal, and the
    // strip the runtime does is the thing this exercises.
    const found = { snippet, extra: "stripped by the ok schema" };
    return ok(found);
  },
);

const count = tool(
  "count",
  {
    description: "Count the items handed in.",
    input: z.object({ items: z.array(z.string()) }),
    ok: z.number(),
    err: [],
  },
  async ({ items }, _ctx, { ok }) => ok(items.length),
);

const tools = toolRouter([search, count]);

const kb: Kb = {
  lookup: (q) => ({ tea: "TEA folds the loop in one reducer." })[q],
};
const ctx = { kb, emit: () => {} } as KbCtx & PortEmitter;

const call = (
  callId: string,
  name: string,
  args: Record<string, unknown>,
): ToolCall => ({ callId, name, args });

describe("tool() — the interpret cell settles through the minted Msgs", () => {
  it("ok: the handler's value is parsed against `ok` (stripped) and rides `<name>_ok`", async () => {
    const cmd = search({ callId: "c1", args: { q: "tea" } });
    const settled = await search.interpret(cmd, ctx);
    expect(settled).toEqual({
      type: "search_ok",
      cmd,
      value: { snippet: "TEA folds the loop in one reducer." },
    });
  });

  it("err: a declared `fail` rides `<name>_err` with its `_tag` and detail", async () => {
    const cmd = search({ callId: "c2", args: { q: "nope" } });
    const settled = await search.interpret(cmd, ctx);
    expect(settled).toEqual({
      type: "search_err",
      cmd,
      error: { _tag: "not_found", q: "nope" },
    });
  });

  it("a thrown handler settles `<name>_err` as `{ _tag: 'thrown', message }` — never a rejection", async () => {
    const cmd = search({ callId: "c3", args: { q: "boom" } });
    const settled = await search.interpret(cmd, ctx);
    expect(settled).toEqual({
      type: "search_err",
      cmd,
      error: { _tag: "thrown", message: "kb offline" },
    });
  });

  it("a thrown value carrying a DECLARED `_tag` settles as that tag", async () => {
    const cmd = search({ callId: "c4", args: { q: "boom-tagged" } });
    const settled = await search.interpret(cmd, ctx);
    expect(settled).toEqual({
      type: "search_err",
      cmd,
      error: { _tag: "not_found", via: "throw" },
    });
  });

  it("an `_ok` value the schema rejects becomes the kernel's `malformed_result`", async () => {
    const lying = tool(
      "lying",
      {
        description: "Claims a number and hands back a string.",
        input: z.object({}),
        ok: z.object({ n: z.number() }),
        err: [],
      },
      // The handler's type says `{ n: number }`; the runtime value lies.
      async (_args, _ctx, { ok }) =>
        ok({ n: "one" } as unknown as { n: number }),
    );
    const cmd = lying({ callId: "c5", args: {} });
    const settled = await lying.interpret(cmd, {} as PortEmitter);
    expect(settled.type).toBe("lying_err");
    if (settled.type === "lying_err") {
      expect(settled.error._tag).toBe("malformed_result");
    }
  });

  it("the def reads like any Cmd.define — `errTags` carries the declared tags plus `thrown`", () => {
    expect(search.cmdType).toBe("search");
    expect(search.description).toBe("Look a phrase up in the knowledge base.");
    expect(search.okType).toBe("search_ok");
    expect(search.errType).toBe("search_err");
    expect(search.errTags).toEqual(["not_found", "thrown"]);
    expect(count.errTags).toEqual(["thrown"]);
  });
});

// ---------------------------------------------------------------------------
// #72 — a reserved name is refused at construction. The type excludes the
// literal; a name that erased to `string` meets the runtime check instead.
// ---------------------------------------------------------------------------

describe("tool() — a reserved name is a declaration bug, refused at construction", () => {
  const spec = {
    description: "Do nothing; exists only to test the reserved-name refusal.",
    input: z.object({}),
    ok: z.void(),
    err: [],
  };
  const noop = async (
    _args: object,
    _ctx: PortEmitter,
    { ok }: ToolConstructors<void, never>,
  ) => ok(undefined);
  const declare = (name: string) => () => tool(name, spec, noop);

  it.each([
    "agent_tool",
    "resilient",
    "compact",
    "tool_rejected",
  ])("%s, passed as a widened string, throws an error naming it", (name) => {
    expect(declare(name)).toThrow(
      `tool: "${name}" is reserved — it is an agent-owned Msg prefix`,
    );
  });

  it("the interpret keys `toMachine` merges under are reserved too", () => {
    expect(declare("compact_run")).toThrow(/is reserved/);
    expect(declare("resilient_run")).toThrow(/is reserved/);
    expect(declare("snapshot_write")).toThrow(/is reserved/);
  });

  it("a name beside the reserved ones still constructs", () => {
    expect(declare("compactor")().cmdType).toBe("compactor");
    expect(declare("agent_tools")().cmdType).toBe("agent_tools");
  });

  it("the set is read off `MsgType`: every discriminant and every settle prefix", () => {
    for (const type of Object.values(MsgType)) {
      expect(isReservedToolName(type)).toBe(true);
      const prefix = /^(.*)_(?:ok|err|run)$/.exec(type)?.[1];
      if (prefix !== undefined) expect(isReservedToolName(prefix)).toBe(true);
    }
    expect(isReservedToolName("tool_rejected")).toBe(true);
    expect(isReservedToolName("snapshot_write")).toBe(true);
    expect(isReservedToolName("search")).toBe(false);
  });
});

describe("toolRouter() — toolOf is total and parses args at the edge", () => {
  it("maps a call to the tool's Cmd with PARSED args", () => {
    expect(tools.toolOf(call("c1", "search", { q: "tea", junk: 1 }))).toEqual({
      type: "search",
      callId: "c1",
      args: { q: "tea" },
    });
  });

  it("an unknown tool name becomes a `tool_rejected` Cmd — no throw inside the reducer", () => {
    expect(tools.toolOf(call("c9", "teleport", {}))).toEqual({
      type: "tool_rejected",
      callId: "c9",
      error: { _tag: "unknown_tool", name: "teleport" },
    });
  });

  it("args that fail the tool's `input` schema become a `tool_rejected` Cmd carrying the issues", () => {
    const cmd = tools.toolOf(call("c8", "search", { q: 42 }));
    expect(cmd.type).toBe("tool_rejected");
    if (cmd.type === "tool_rejected") {
      expect(cmd.error._tag).toBe("malformed_args");
      if (cmd.error._tag === "malformed_args") {
        expect(cmd.error.name).toBe("search");
        expect(cmd.error.issues[0]?.path).toBe("q");
      }
    }
  });

  it("the `tool_rejected` cell settles the carried refusal as `tool_rejected_err`", async () => {
    const cmd = tools.toolOf(call("c9", "teleport", {}));
    if (cmd.type !== "tool_rejected") throw new Error("expected a rejection");
    const settled = await tools.interpret.tool_rejected(cmd, ctx);
    expect(settled).toEqual({
      type: "tool_rejected_err",
      cmd,
      error: { _tag: "unknown_tool", name: "teleport" },
    });
  });

  it("interpret carries one cell per tool plus the rejection cell", () => {
    expect(Object.keys(tools.interpret).sort()).toEqual([
      "count",
      "search",
      "tool_rejected",
    ]);
    expect(tools.defs.map((d) => d.cmdType)).toEqual([
      "search",
      "count",
      "tool_rejected",
    ]);
  });

  it("two tools with one name is a declaration bug, refused at construction", () => {
    expect(() => toolRouter([search, search])).toThrow(/declared twice/);
  });

  it("outcomeOf reads a settled tool off its Msg, tag and payload beside the reason", () => {
    const cmd = search({ callId: "c1", args: { q: "tea" } });
    expect(tools.outcomeOf(search.ok(cmd, { snippet: "s" }, 1))).toEqual({
      callId: "c1",
      outcome: { kind: "ok", result: { snippet: "s" } },
    });
    expect(
      tools.outcomeOf(search.err(cmd, { _tag: "not_found", q: "x" }, 1)),
    ).toEqual({
      callId: "c1",
      outcome: {
        kind: "error",
        _tag: "not_found",
        q: "x",
        reason: 'not_found {"q":"x"}',
      },
    });
    expect(tools.outcomeOf({ type: "agent_start" })).toBeNull();
  });

  // The payload is the tool's, the discriminant and the model's channel are the
  // router's — so a tool failing with a payload field called `kind` or `reason`
  // widens nothing and lies about nothing (#115).
  it("a payload field never shadows `kind` or `reason`", () => {
    const cmd = search({ callId: "c1", args: { q: "tea" } });
    const settled = tools.outcomeOf(
      search.err(cmd, { _tag: "not_found", kind: "ok", reason: "mine" }, 1),
    );
    expect(settled?.outcome.kind).toBe("error");
    expect(settled?.outcome).toMatchObject({
      _tag: "not_found",
      reason: 'not_found {"kind":"ok","reason":"mine"}',
    });
  });

  it("toolErrorReason: the bare tag when there is no detail", () => {
    expect(toolErrorReason({ _tag: "thrown" })).toBe("thrown");
  });
});

// ---------------------------------------------------------------------------
// The wired loop: `toMachine({ tools })` folds the router's settles into the
// conversation exactly as `agent_tool_ok` / `agent_tool_err` would.
// ---------------------------------------------------------------------------

type Stage = "plan";
type Purpose = "plan_turn";
interface Outputs extends Record<Purpose, AgentTurn> {
  readonly plan_turn: AgentTurn;
}
type Turns = readonly AgentTurn[];

const turnSchema: Schema<AgentTurn> = {
  parse: (v) => v as AgentTurn,
};

function fakeModel(turns: Turns) {
  let i = 0;
  return () => ({
    withStructuredOutput<T>(_s: Schema<T>) {
      return {
        invoke: async () => {
          const t = turns[i] ?? { content: "", toolCalls: [] };
          i += 1;
          return t as T;
        },
      };
    },
  });
}

async function drive(turns: Turns) {
  const agent = createAgent<
    Stage,
    Purpose,
    Outputs,
    { snippet: string } | number,
    ReturnType<typeof tools.toolOf>,
    unknown
  >({
    stages: ["plan"],
    model: fakeModel(turns),
    schemas: { plan_turn: turnSchema },
    turnOf: () => "plan_turn",
    toolOf: tools.toolOf,
    toolConcurrency: 8,
    rng: () => 0,
  });
  const machine = agent.toMachine({ tools });
  const events: AgentEvent<{ snippet: string } | number>[] = [];
  let clock = 100;
  const runtime = await run(machine, {
    ctx: { kb },
    clock: () => {
      clock += 1;
      return clock;
    },
    terminal: (s) => s.run.phase === "done" || s.run.phase === "failed",
    events: agentEvents<
      Stage,
      Purpose,
      Outputs,
      { snippet: string } | number,
      typeof search | typeof count
    >({ tools }),
  }).ready;
  runtime.on("ToolSettled", (e) => {
    events.push(e);
  });
  // The stage retire clears the conversation, so keep the fullest record set
  // seen on the way — that is the fold this test reads.
  let records: readonly ToolRecord<{ snippet: string } | number>[] = [];
  runtime.observe((_msg, state) => {
    const conv = state.conversation;
    if (conv !== null && conv.toolRecords.length > records.length) {
      records = conv.toolRecords;
    }
  });
  await runtime.dispatch({ type: "agent_start", runId: "r", at: 0 });
  await runtime.done();
  const final = runtime.getState();
  await runtime.stop();
  return { final, events, records };
}

describe("toMachine({ tools }) — the router's settles fold into the loop", () => {
  it("ok / declared err / thrown / unknown tool / malformed args all fold, then the run finishes", async () => {
    const fanned: AgentTurn = {
      content: "look things up",
      toolCalls: [
        call("c1", "search", { q: "tea" }),
        call("c2", "search", { q: "nope" }),
        call("c3", "search", { q: "boom" }),
        call("c4", "count", { items: ["a", "b", "c"] }),
        call("c5", "teleport", {}),
        call("c6", "count", { items: "not-an-array" }),
      ],
    };
    const { final, events } = await drive([
      fanned,
      { content: "done", toolCalls: [] },
    ]);

    expect(final.run.phase).toBe("done");
    expect(final.failure).toBeNull();
    // The conversation was cleared on stage retire; the fold happened — every
    // tool settled once and the run advanced past the fan-out to the final turn.
    expect(final.tools.running).toEqual([]);
    expect(final.output).toEqual({ content: "done", toolCalls: [] });

    // `ToolSettled` projects off the router's `_ok` Msgs (#47 stays whole).
    expect(events).toEqual([
      {
        type: "ToolSettled",
        callId: "c1",
        result: { snippet: "TEA folds the loop in one reducer." },
      },
      { type: "ToolSettled", callId: "c4", result: 3 },
    ]);
  });

  it("the folded records carry the parsed ok value and the structured `{ _tag }` failures", async () => {
    const { records } = await drive([
      {
        content: "look",
        toolCalls: [
          call("c1", "search", { q: "tea" }),
          call("c2", "search", { q: "nope" }),
          call("c3", "search", { q: "boom" }),
          call("c5", "teleport", {}),
          call("c7", "count", { items: [] }),
        ],
      },
      { content: "done", toolCalls: [] },
    ]);
    expect(records.length).toBe(5);
    const byId = new Map(records.map((r) => [r.call.callId, r]));
    expect(byId.get("c1")?.outcome).toEqual({
      kind: "ok",
      result: { snippet: "TEA folds the loop in one reducer." },
    });
    // Each folded failure keeps the tag and payload it failed with beside the
    // rendered reason — the router's, the tool's and the kernel's alike (#115).
    expect(byId.get("c2")?.outcome).toEqual({
      kind: "error",
      _tag: "not_found",
      q: "nope",
      reason: 'not_found {"q":"nope"}',
    });
    expect(byId.get("c3")?.outcome).toEqual({
      kind: "error",
      _tag: "thrown",
      message: "kb offline",
      reason: 'thrown {"message":"kb offline"}',
    });
    expect(byId.get("c5")?.outcome).toEqual({
      kind: "error",
      _tag: "unknown_tool",
      name: "teleport",
      reason: 'unknown_tool {"name":"teleport"}',
    });
    expect(byId.get("c7")?.outcome).toEqual({ kind: "ok", result: 0 });
  });

  // #72 — the regression the last-wins spread would hide: with a router wired,
  // the agent's own `agent_tool_ok` / `resilient_ok` / `compact_ok` cells are
  // still the agent's verbs, not the router's fold (which returns `[s, []]`
  // for any Msg outside its own `<name>_ok` / `<name>_err`).
  it("the agent's own settle cells survive the router merge", () => {
    const agent = createAgent<
      Stage,
      Purpose,
      Outputs,
      { snippet: string } | number,
      ReturnType<typeof tools.toolOf>,
      unknown
    >({
      stages: ["plan"],
      model: fakeModel([]),
      schemas: { plan_turn: turnSchema },
      turnOf: () => "plan_turn",
      toolOf: tools.toolOf,
      rng: () => 0,
    });
    const machine = agent.toMachine({ tools });

    // The router's two cells per def are one fold; the agent's cells are not it.
    const fold = machine.update.search_ok;
    expect(machine.update.search_err).toBe(fold);
    expect(machine.update.agent_tool_ok).not.toBe(fold);
    expect(machine.update.resilient_ok).not.toBe(fold);
    expect(machine.update.compact_ok).not.toBe(fold);

    // And they still fold the loop: the brain settle folds the turn and fans
    // the tool out, the legacy tool settle folds the record and re-fires the
    // brain. Under the router's fold both would have been no-ops.
    const brainOk: AgentLlmOkMsg<Purpose, Outputs> = {
      type: "resilient_ok",
      key: "plan_turn",
      result: {
        key: "plan_turn",
        purpose: "plan_turn",
        output: {
          content: "look",
          toolCalls: [call("c1", "search", { q: "tea" })],
        },
      },
      at: 10,
    };
    const { state, cmds } = bindMachine(machine, ctx).replay({
      msgs: [
        { type: "agent_start", runId: "r", at: 0 },
        brainOk,
        {
          type: "agent_tool_ok",
          callId: "c1",
          result: { snippet: "s" },
          at: 20,
        },
      ],
    });
    expect(state.conversation?.turnCount).toBe(1);
    expect(state.tools.running).toEqual([]);
    expect(cmds.map((c) => c.type)).toEqual([
      "resilient_run",
      "search",
      "resilient_run",
    ]);
  });
});
