/**
 * Cold wake over the agent host: a run restored while its model call or its
 * compaction was in flight finishes, and does not read again what it already
 * read.
 *
 * The user's job is four documents, each read through a tool and each result
 * 57,344 characters long. The activation is lost while the model is deciding
 * about the fourth read, or while the history of the first three is being
 * compacted. The persisted checkpoint is larger than 100 KB. A new activation
 * over a clone of that checkpoint, with three `host.runtime()` callers at once,
 * must reach the final answer, with the three finished reads still folded
 * and the outstanding operation reissued once. A stop persisted before the
 * fourth read is posted ends the run with no further model call, whether the
 * step host resumes inline or defers. Every case runs three times.
 *
 * Globals are NOT enabled in vitest.config.ts — describe/it/expect are imported.
 */
import { describe, expect, it } from "vitest";
import {
  type AgentCompactOkMsg,
  type AgentCompactRunCmd,
  type AgentMachineMsg,
  type AgentState,
  type AgentTurn,
  agentCancelMsg,
  COMPACTION_PURPOSE,
  createAgent,
  type Schema,
  status,
  type ToolCall,
} from "../agent/index";
import type { Cmd, Interpret, Store, Wired } from "../index";
import type { DeadlinesSub } from "../internal/resilience/deadline";
import { run } from "../promise";
import { createAgentHost } from "./agent-host";
import { type StepEngine, stepHost } from "./step-host";

type Stage = "work";
type Purpose = "turn";

interface Outputs extends Record<Purpose, AgentTurn> {
  readonly turn: AgentTurn;
}

type ReadCmd = { readonly _tag: "read" } & ToolCall;
type S = AgentState<Stage, Purpose, Outputs, string>;
type M = AgentMachineMsg<Purpose, Outputs, string>;
type AgentWired<C extends Cmd> = Wired<S, M, C, DeadlinesSub, object>;

const DOCUMENTS = 4;
const VALUE = "document text ".repeat(4096);
const ANSWER: AgentTurn = { content: "four documents checked", toolCalls: [] };
const REPEATS = [1, 2, 3] as const;
const INTENTIONAL_TEARDOWN = ["RuntimeDiscardedError", "DrainTimeoutNotice"];

const turnSchema: Schema<AgentTurn> = { parse: (v) => v as AgentTurn };
const retry = {
  baseMs: 100,
  factor: 2,
  capMs: 10_000,
  maxAttempts: 3,
  jitter: "full" as const,
};

const hangs = <T>() => new Promise<T>(() => {});

const turn = (n: number): AgentTurn =>
  n <= DOCUMENTS
    ? {
        content: `read ${n}`,
        toolCalls: [{ callId: `document-${n}`, name: "read", args: { n } }],
      }
    : ANSWER;

const gate = () => {
  let release: () => void = () => {};
  const reached = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, release };
};

const model = (invoke: () => Promise<AgentTurn>) => () => ({
  withStructuredOutput<T>(_schema: Schema<T>) {
    return { invoke: invoke as () => Promise<T> };
  },
});

const base = (invoke: () => Promise<AgentTurn>) => ({
  stages: ["work"] as readonly Stage[],
  model: model(invoke),
  schemas: { turn: turnSchema },
  turnOf: (): Purpose => "turn",
  toolOf: (call: ToolCall): ReadCmd => ({ _tag: "read", ...call }),
  retry,
});

const plainAgent = (invoke: () => Promise<AgentTurn>) =>
  createAgent<Stage, Purpose, Outputs, string, ReadCmd, string>(base(invoke));

const compactingAgent = (invoke: () => Promise<AgentTurn>) =>
  createAgent<Stage, Purpose, Outputs, string, ReadCmd, string>({
    ...base(invoke),
    compaction: {
      planCompaction: (conversation) =>
        conversation.turns.length === DOCUMENTS - 1 ? DOCUMENTS - 1 : 0,
    },
  });

const settled = (cmd: ReadCmd): M => ({
  _tag: "agent_tool_ok",
  callId: cmd.callId,
  result: VALUE,
  at: 1,
});

const compacted = (): AgentCompactOkMsg => ({
  _tag: "compact_ok",
  key: COMPACTION_PURPOSE,
  result: {
    key: COMPACTION_PURPOSE,
    purpose: COMPACTION_PURPOSE,
    output: { summary: "first three documents checked" },
  },
  at: 1,
});

type Read = Interpret<M, ReadCmd, object>["read"];
type Compact = Interpret<M, AgentCompactRunCmd, object>["compact_run"];

const wirePlain = (agent: ReturnType<typeof plainAgent>, read: Read) =>
  agent.toMachine<object>({ toolInterpret: { read } });

const wireCompacting = (
  agent: ReturnType<typeof compactingAgent>,
  read: Read,
  compact: Compact,
) => agent.toMachine<object>({ toolInterpret: { read, compact_run: compact } });

// A store that holds a clone of what was saved, the way a durable object does.
function storage(seed: S | null = null) {
  let value = structuredClone(seed);
  const store: Store<S> = {
    load: async () => structuredClone(value),
    save: async (state) => {
      value = structuredClone(state);
    },
    migrate: (raw) => raw as S | null,
  };
  return { store, snapshot: () => structuredClone(value) };
}

// A host over one activation. A handler that never returns is reported at
// teardown as intentional; any other report fails the test.
function hostOver<C extends Cmd>(wired: AgentWired<C>, store: Store<S>) {
  const teardown: string[] = [];
  const host = createAgentHost<
    Stage,
    Purpose,
    Outputs,
    string,
    null,
    C,
    DeadlinesSub,
    object
  >({
    run: (machine, options) =>
      run(machine, { ...options, disposeTimeoutMs: 0 }),
    onError: (error, context) => {
      if (context.phase !== "discard") throw error;
      teardown.push(error instanceof Error ? error.name : String(error));
    },
    buildMachine: () => wired,
    store,
    ctx: {},
    toSseFrame: () => null,
    now: () => 2,
  });
  return { host, teardown };
}

const start = (mode: string) =>
  ({ _tag: "agent_start", runId: `documents-${mode}`, at: 0 }) as const;

async function lostDuring(mode: "model" | "compaction") {
  const reached = gate();
  const completed: string[] = [];
  let attempt = 0;
  const invoke = async () => {
    attempt++;
    if (mode === "model" && attempt === DOCUMENTS) {
      reached.release();
      return hangs<AgentTurn>();
    }
    return turn(attempt);
  };
  const read: Read = async (cmd) => {
    completed.push(cmd.callId);
    return settled(cmd);
  };
  const saved = storage();
  const { host, teardown } =
    mode === "compaction"
      ? hostOver(
          wireCompacting(compactingAgent(invoke), read, async () => {
            reached.release();
            return hangs<AgentCompactOkMsg>();
          }),
          saved.store,
        )
      : hostOver(wirePlain(plainAgent(invoke), read), saved.store);
  const old = await host.runtime();
  void old.dispatch(start(mode));
  await reached.reached;
  const checkpoint = saved.snapshot();
  await host.reset();
  return { checkpoint, completed, teardown };
}

async function wakeOver(
  mode: "model" | "compaction",
  checkpoint: S | null,
  completed: string[],
) {
  let attempts = 3;
  let compactions = 0;
  const invoke = async () => turn(++attempts);
  const read: Read = async (cmd) => {
    completed.push(cmd.callId);
    return settled(cmd);
  };
  const persisted = storage(checkpoint);
  const { host } =
    mode === "compaction"
      ? hostOver(
          wireCompacting(compactingAgent(invoke), read, async () => {
            compactions++;
            return compacted();
          }),
          persisted.store,
        )
      : hostOver(wirePlain(plainAgent(invoke), read), persisted.store);
  return {
    host,
    persisted,
    attempts: () => attempts,
    compactions: () => compactions,
  };
}

describe.each([
  "model",
  "compaction",
] as const)("cold wake over a run lost during its %s call", (mode) => {
  it.each(
    REPEATS,
  )("finishes four 57,344-character documents without repeating a finished read (repeat %i)", async () => {
    const { checkpoint, completed, teardown } = await lostDuring(mode);
    expect(checkpoint?.conversation?.toolRecords).toHaveLength(DOCUMENTS - 1);
    expect(JSON.stringify(checkpoint).length).toBeGreaterThan(100_000);
    expect(status(checkpoint as S).kind).toBe("running");

    const wake = await wakeOver(mode, checkpoint, completed);
    const [first, second, third] = await Promise.all([
      wake.host.runtime(),
      wake.host.runtime(),
      wake.host.runtime(),
    ]);
    try {
      expect(second).toBe(first);
      expect(third).toBe(first);
      expect(status(first.getState())).toMatchObject({
        kind: "done",
        output: ANSWER,
      });
      expect(wake.attempts()).toBe(DOCUMENTS + 1);
      expect(wake.compactions()).toBe(mode === "compaction" ? 1 : 0);
      expect(completed).toEqual([
        "document-1",
        "document-2",
        "document-3",
        "document-4",
      ]);
      expect(status(wake.persisted.snapshot() as S).kind).toBe("done");
      expect(
        teardown.every((name) => INTENTIONAL_TEARDOWN.includes(name)),
      ).toBe(true);
    } finally {
      await wake.host.reset();
    }
  });
});

describe("cold wake over a run that is not mid-run", () => {
  const settledCheckpoint = async (kind: "idle" | "done" | "cancelled") => {
    if (kind === "idle") return null;
    const saved = storage();
    const { host } = hostOver(
      wirePlain(
        plainAgent(async () => ANSWER),
        async (cmd) => settled(cmd),
      ),
      saved.store,
    );
    const handle = await host.runtime();
    await handle.dispatch(
      kind === "done" ? start("settled") : agentCancelMsg(9),
    );
    await host.reset();
    return saved.snapshot();
  };

  it.each([
    "idle",
    "done",
    "cancelled",
  ] as const)("a %s run is left as it is and never reaches the model or a tool", async (kind) => {
    const checkpoint = await settledCheckpoint(kind);
    const reads: string[] = [];
    const wake = await wakeOver("model", checkpoint, reads);
    const runtime = await wake.host.runtime();
    expect(status(runtime.getState()).kind).toBe(kind);
    expect(wake.attempts()).toBe(3);
    expect(reads).toEqual([]);
    await wake.host.reset();
  });
});

// A run activation that boots nothing: the stop admission reads persisted
// control state first and only then needs a runtime to cancel through.
function passive(wired: ReturnType<typeof wirePlain>, store: Store<S>) {
  return run(wired.machine, {
    ...wired,
    store,
    ctx: {},
    disposeTimeoutMs: 0,
    onError: (error, context) => {
      if (context.phase !== "discard") throw error;
    },
  });
}

async function suspendedOnFourthRead() {
  const reached = gate();
  let attempt = 0;
  const saved = storage();
  const old = await passive(
    wirePlain(
      plainAgent(async () => turn(++attempt)),
      async (cmd) => {
        if (cmd.callId === "document-4") {
          reached.release();
          return hangs<M>();
        }
        return settled(cmd);
      },
    ),
    saved.store,
  ).ready;
  void old.dispatch(start("stopped"));
  await reached.reached;
  const checkpoint = saved.snapshot();
  await old.stop();
  return checkpoint;
}

describe.each([
  ["inline", false],
  ["deferred", true],
] as const)("a stop persisted before the fourth read, %s step host", (_mode, deferred) => {
  const rig = async (stopRequested: boolean) => {
    const checkpoint = await suspendedOnFourthRead();
    let paidCalls = 0;
    const durable = storage(checkpoint);
    const runtime = await passive(
      wirePlain(
        plainAgent(async () => {
          paidCalls++;
          return ANSWER;
        }),
        async () => hangs<M>(),
      ),
      durable.store,
    ).ready;
    const control = { stopRequested };
    const calls = { resumes: 0, enqueues: 0, nextSteps: 0 };
    const order: string[] = [];
    const engine: StepEngine<string, never, string> = {
      tokenFor: () => "synthetic-capability",
      async beforeResume() {
        order.push("check-stop");
        if (!control.stopRequested) return null;
        await runtime.dispatch(agentCancelMsg(5));
        return { done: true, output: status(runtime.getState()).kind };
      },
      async resume(_runId, posted) {
        calls.resumes++;
        order.push("resume");
        await runtime.dispatch({
          _tag: "agent_tool_ok",
          callId: posted.callId,
          result: posted.result,
          at: 4,
        });
      },
      nextStep() {
        calls.nextSteps++;
        return null;
      },
      terminalOutput: () => status(runtime.getState()).kind,
    };
    const ctx = { storage: { setAlarm() {} } };
    const host = deferred
      ? stepHost(ctx, engine, {
          deferResume: {
            settled: () => false,
            enqueue() {
              calls.enqueues++;
            },
          },
        })
      : stepHost(ctx, engine);
    const request = {
      token: "synthetic-capability",
      runId: "stopped-documents",
      posted: { callId: "document-4", result: VALUE },
    };
    return {
      host,
      request,
      runtime,
      durable,
      calls,
      order,
      paid: () => paidCalls,
    };
  };

  it.each(
    REPEATS,
  )("cancels the run and posts no further model call, however often the result is posted (repeat %i)", async () => {
    const r = await rig(true);
    try {
      for (let duplicate = 0; duplicate < 3; duplicate++) {
        expect(await r.host.handle(r.request, 4)).toEqual({
          status: 200,
          body: { done: true, output: "cancelled" },
        });
      }
      expect(r.paid()).toBe(0);
      expect(r.calls).toEqual({ resumes: 0, enqueues: 0, nextSteps: 0 });
      expect(r.order[0]).toBe("check-stop");
      expect(status(r.durable.snapshot() as S).kind).toBe("cancelled");
    } finally {
      await r.runtime.stop();
    }
  });

  it("resumes the run as before when no stop was persisted", async () => {
    const r = await rig(false);
    try {
      const outcome = await r.host.handle(r.request, 4);
      if (deferred) {
        expect(outcome).toEqual({
          status: 200,
          body: { done: false, working: true },
        });
        expect(r.calls).toEqual({ resumes: 0, enqueues: 1, nextSteps: 0 });
        expect(r.paid()).toBe(0);
      } else {
        expect(outcome).toEqual({
          status: 200,
          body: { done: true, output: "done" },
        });
        expect(r.calls).toEqual({ resumes: 1, enqueues: 0, nextSteps: 1 });
        expect(r.paid()).toBe(1);
      }
    } finally {
      await r.runtime.stop();
    }
  });
});
