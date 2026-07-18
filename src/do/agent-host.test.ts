/**
 * createAgentHost — the build-once cell must be race-safe (#313).
 *
 * The bug: the memo cell held only the SETTLED runtime, assigned after the boot
 * await. Two concurrent activations (an `/sse` open + an inbound dispatch in the
 * same wake) both passed the empty fast-path guard and each built a runtime —
 * a double boot with duplicate SSE wiring against one storage. The fix memoizes
 * the IN-FLIGHT build promise, assigned synchronously before the first await, so
 * concurrent callers share the one build.
 *
 * The load-bearing property here: N concurrent `runtime()` calls invoke
 * `buildMachine` (and thus `run` + SSE wiring + autoBoot) exactly once and all
 * resolve to the SAME runtime handle. `reset()` then lets the next call rebuild.
 *
 * Globals are NOT enabled in vitest.config.ts — describe/it/expect are imported.
 * The agent fixture mirrors `agent-events.test.ts`: a real two-stage agent wired
 * through `toMachine`, driven by a fresh in-memory store.
 */
import { describe, expect, it } from "vitest";
import {
  type AgentMachineMsg,
  type AgentState,
  type AgentTurn,
  createAgent,
  type Schema,
  type ToolCall,
} from "../agent/index";
import type { Interpret, Store } from "../index";
import { createAgentHost } from "./agent-host";

type Stage = "plan" | "act";
type Purpose = "plan_turn" | "act_turn";

interface Outputs extends Record<Purpose, AgentTurn> {
  readonly plan_turn: AgentTurn;
  readonly act_turn: AgentTurn;
}

type ToolCmd = { readonly type: "run_tool" } & ToolCall;
const toolOf = (call: ToolCall): ToolCmd => ({ type: "run_tool", ...call });

const turnSchema = (): Schema<AgentTurn> => ({
  parse: (v) => {
    const o = v as AgentTurn;
    if (typeof o?.content !== "string" || !Array.isArray(o?.toolCalls)) {
      throw new Error("not an AgentTurn");
    }
    return o;
  },
});
const schemas = { plan_turn: turnSchema(), act_turn: turnSchema() } as const;

function fakeModel(invoke: () => Promise<unknown>) {
  return () => ({
    withStructuredOutput<T>(_s: Schema<T>) {
      return { invoke: invoke as () => Promise<T> };
    },
  });
}

const STAGES: readonly Stage[] = ["plan", "act"];
const turnOf = (stage: Stage | undefined): Purpose =>
  stage === "act" ? "act_turn" : "plan_turn";
const retry = {
  baseMs: 100,
  factor: 2,
  capMs: 10_000,
  maxAttempts: 3,
  jitter: "full" as const,
};

type S = AgentState<Stage, Purpose, Outputs, string>;
type M = AgentMachineMsg<Purpose, Outputs, string>;

// A tiny in-memory `Store<S>` — always fresh (`load` → null), so every build is
// an independent cold boot. Mirrors `boot-resume.test.ts`'s `memStore`.
function freshStore(): Store<S> {
  let cell: S | null = null;
  return {
    async load() {
      return cell;
    },
    async save(state) {
      cell = state;
    },
    migrate(raw) {
      return (raw as S | null) ?? null;
    },
  };
}

/**
 * A host over a real (fresh) agent whose `buildMachine` counts its invocations —
 * one call per host build. `builds` is the observable the race turns on.
 */
function makeHost() {
  const model = fakeModel(async () => ({ content: "idle", toolCalls: [] }));
  const agent = createAgent<Stage, Purpose, Outputs, string, ToolCmd, string>({
    stages: STAGES,
    model,
    schemas,
    retry,
    turnOf,
    toolOf,
  });
  const toolInterpret: Interpret<M, ToolCmd, object> = {
    run_tool: async (cmd) => ({
      type: "agent_tool_ok",
      callId: cmd.callId,
      result: `done:${cmd.callId}`,
      at: 0,
    }),
  };

  let builds = 0;
  const host = createAgentHost<Stage, Purpose, Outputs, string, null>({
    buildMachine: () => {
      builds += 1;
      return agent.toMachine<object>({ toolInterpret });
    },
    store: freshStore(),
    ctx: {} as object,
    toSseFrame: () => null,
    now: () => 0,
  });
  return { host, builds: () => builds };
}

describe("createAgentHost — build-once cell is race-safe (#313)", () => {
  it("concurrent runtime() calls share one build and one runtime handle", async () => {
    const { host, builds } = makeHost();

    // Two activations racing BEFORE the first settles — the exact shape #313
    // describes (an `/sse` open + an inbound dispatch in the same wake).
    const [a, b, c] = await Promise.all([
      host.runtime(),
      host.runtime(),
      host.runtime(),
    ]);

    expect(builds()).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);

    await host.reset();
  });

  it("caches the settled runtime for a later call", async () => {
    const { host, builds } = makeHost();

    const first = await host.runtime();
    const second = await host.runtime();

    expect(builds()).toBe(1);
    expect(first).toBe(second);

    await host.reset();
  });

  it("rebuilds after reset() drops the cell", async () => {
    const { host, builds } = makeHost();

    const first = await host.runtime();
    await host.reset();
    const second = await host.runtime();

    expect(builds()).toBe(2);
    expect(first).not.toBe(second);

    await host.reset();
  });
});
