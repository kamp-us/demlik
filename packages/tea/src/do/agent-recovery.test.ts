/**
 * Cold wake over the agent host, and over a step host on retained storage.
 *
 * The user's job is four documents, each read through a tool and each result
 * 57,344 characters long. The activation is lost while the model is deciding
 * about the fourth read, or while the history of the first three is being
 * compacted. The persisted checkpoint is larger than 100 KB.
 *
 * First, a new activation over a clone of that checkpoint, with three
 * `host.runtime()` callers at once, must reach the final answer, with the three
 * finished reads still folded and the outstanding operation reissued once.
 *
 * Second, the same job is driven through `stepHost`'s `handle` on one retained
 * storage. The hands pull a step, run it and post its result. The activation is
 * evicted mid call; a fresh host, runtime and step host over the same storage
 * answer the hands' retried post, and the run reaches `done` with every turn
 * once. A stop recorded in that storage before the third result is posted is read
 * by `beforeResume` on a fresh activation and ends the run cancelled, with no
 * further model call, whether the step host resumes inline or defers. The same
 * stop, recorded after a cold wake has handed out a tool step, reaches a warm
 * host whose boot is parked on that unanswered tool, for a run left `running` and
 * one left `suspended`: the next post is answered `cancelled` in one request and
 * `reset()` resolves.
 *
 * Every case runs ten times.
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
  agentBootMsg,
  agentCancelMsg,
  COMPACTION_PURPOSE,
  createAgent,
  type Schema,
  status,
  type ToolCall,
} from "../agent/index";
import type { Cmd, Interpret, Migrated, Store, Wired } from "../index";
import { RuntimeStoppedError } from "../internal/engine/loop";
import type { DeadlinesSub } from "../internal/resilience/deadline";
import { run } from "../promise";
import { DispatchDiscardedError } from "../runtime-types";
import { createAgentHost } from "./agent-host";
import { doStore } from "./index";
import {
  type DeferredStepOutcome,
  type StepEngine,
  type StepRequest,
  stepHost,
} from "./step-host";

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
const REPEATS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
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
      expect(await reaches(first, (now) => now.kind === "done")).toMatchObject({
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

// What outlives every activation of one run: the retained storage. It holds the
// agent's Model, the run capability and the stop a host recorded, as a
// Durable Object's storage does, so a new activation over it starts from the
// bytes the old one left, and from nothing else.
function retained() {
  const cells = new Map<string, unknown>();
  const alarms: number[] = [];
  const backing = {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      return structuredClone(cells.get(key)) as T | undefined;
    },
    async put<T>(key: string, value: T): Promise<void> {
      cells.set(key, structuredClone(value));
    },
    async delete(keys: string | readonly string[]): Promise<void> {
      for (const key of typeof keys === "string" ? [keys] : keys)
        cells.delete(key);
    },
    async setAlarm(at: number): Promise<void> {
      alarms.push(at);
    },
  };
  const storage = backing as unknown as DurableObjectStorage;
  const store = doStore<S>(storage, (raw): Migrated<S> => raw as S | null);
  return {
    storage,
    store,
    alarms,
    state: async () => store.migrate(await store.load()) as S | null,
    saved: async () => {
      const state = store.migrate(await store.load()) as S | null;
      if (state === null) throw new Error("nothing was saved");
      return state;
    },
  };
}
type Retained = ReturnType<typeof retained>;

const RUN = "retained-documents";
const TOKEN = "synthetic-capability";
const NOW = 4;
const noop = () => undefined;

type Hands = Readonly<Record<string, unknown>>;
type Outcome = DeferredStepOutcome<Hands, string>;
type Request = StepRequest<string>;

const pull: Request = { token: TOKEN, runId: RUN, posted: null };
const post = (callId: string): Request => ({
  token: TOKEN,
  runId: RUN,
  posted: { callId, result: VALUE },
});

// Everything paid for or done by the outside world across all activations.
const world = () => ({
  invocations: 0,
  lost: 0,
  returned: [] as number[],
  compactions: { started: 0, folded: 0 },
  executed: [] as string[],
  sent: [] as Request[],
});
type World = ReturnType<typeof world>;

type Mode = "model" | "compaction";

// Resolves with the run's status the first time `settled` accepts it, off the
// transitions the runtime reports.
function reaches(
  runtime: {
    getState(): S;
    subscribe(listener: () => void): () => void;
  },
  settled: (now: ReturnType<typeof status>) => boolean,
): Promise<ReturnType<typeof status>> {
  return new Promise((resolve) => {
    const unsubscribe = runtime.subscribe(() => {
      const now = status(runtime.getState());
      if (!settled(now)) return;
      unsubscribe();
      resolve(now);
    });
    const now = status(runtime.getState());
    if (settled(now)) {
      unsubscribe();
      resolve(now);
    }
  });
}

// The hands' results, handed to the tool cell that waits for them. A result that
// arrives before the cell has been reissued is kept for it.
function mailbox() {
  const kept = new Map<string, string>();
  const waiting = new Map<string, (result: string) => void>();
  return {
    deliver(callId: string, result: string) {
      const wake = waiting.get(callId);
      if (wake === undefined) return void kept.set(callId, result);
      waiting.delete(callId);
      wake(result);
    },
    take(callId: string) {
      const result = kept.get(callId);
      if (result !== undefined) {
        kept.delete(callId);
        return Promise.resolve(result);
      }
      return new Promise<string>((resolve) => waiting.set(callId, resolve));
    },
  };
}

// One activation of the Durable Object: a fresh host, a fresh runtime and a
// fresh step host over `r`. The model and the compaction are the world's. A
// read parks until the hands post its result, as a tool run outside the
// object does.
function activation(
  mode: Mode,
  r: Retained,
  w: World,
  hangOn: Mode | null,
  deferred = false,
) {
  const reached = gate();
  const results = mailbox();
  const invoke = async () => {
    w.invocations++;
    const next = w.returned.length + 1;
    if (hangOn === "model" && next === DOCUMENTS) {
      w.lost++;
      reached.release();
      return hangs<AgentTurn>();
    }
    w.returned.push(next);
    return turn(next);
  };
  const read: Read = async (cmd) => ({
    _tag: "agent_tool_ok",
    callId: cmd.callId,
    result: await results.take(cmd.callId),
    at: 1,
  });
  const compact: Compact = async () => {
    w.compactions.started++;
    if (hangOn === "compaction") {
      reached.release();
      return hangs<AgentCompactOkMsg>();
    }
    w.compactions.folded++;
    return compacted();
  };
  const options = (store: Store<S>) => ({
    store,
    ctx: {},
    disposeTimeoutMs: 0,
    onError: (error: unknown, context: { readonly phase: string }) => {
      if (context.phase !== "discard") throw error;
    },
  });
  if (mode === "compaction") {
    const wired = wireCompacting(compactingAgent(invoke), read, compact);
    return assemble(wired, r, results, reached.reached, deferred, (store) =>
      cancelThrough(run(wired.machine, { ...wired, ...options(store) })),
    );
  }
  const wired = wirePlain(plainAgent(invoke), read);
  return assemble(wired, r, results, reached.reached, deferred, (store) =>
    cancelThrough(run(wired.machine, { ...wired, ...options(store) })),
  );
}

// A runtime that boots nothing, so the stop is read before any work resumes:
// cancel the restored run and report where it ended.
async function cancelThrough(booting: {
  readonly ready: Promise<{
    dispatch(msg: M): Promise<void>;
    getState(): S;
    stop(): Promise<void>;
  }>;
}): Promise<string> {
  const stopped = await booting.ready;
  await stopped.dispatch(agentCancelMsg(NOW));
  const { kind } = status(stopped.getState());
  await stopped.stop();
  return kind;
}

// The step engine, over the host exactly as a Durable Object holds it: `runtime()`
// to reach the run, `reset()` to stop it, `status()` to read the end.
function assemble<C extends Cmd>(
  wired: AgentWired<C>,
  r: Retained,
  results: ReturnType<typeof mailbox>,
  reached: Promise<void>,
  deferred: boolean,
  cancelOver: (store: Store<S>) => Promise<string>,
) {
  const { host, teardown } = hostOver(wired, r.store);
  const calls = { resumes: 0, enqueues: 0 };
  const order: string[] = [];

  const engine: StepEngine<string, Hands, string> = {
    tokenFor: async (runId) =>
      (await r.storage.get<string>(`token:${runId}`)) ?? null,
    async beforeResume(runId) {
      order.push("check-stop");
      if ((await r.storage.get<boolean>(`stop:${runId}`)) !== true) return null;
      await host.reset();
      return { done: true, output: await cancelOver(r.store) };
    },
    async resume(_runId, posted) {
      calls.resumes++;
      order.push("resume");
      const runtime = await host.runtime();
      results.deliver(posted.callId, posted.result);
      await reaches(
        runtime,
        (s) =>
          s.kind !== "running" &&
          !(
            s.kind === "suspended" &&
            s.pending.some((call) => call.callId === posted.callId)
          ),
      );
    },
    async nextStep() {
      order.push("next-step");
      const now = await reaches(
        await host.runtime(),
        (s) => s.kind !== "running",
      );
      const call = now.kind === "suspended" ? now.pending[0] : undefined;
      return call === undefined
        ? null
        : { callId: call.callId, tool: call.name, input: call.args };
    },
    async terminalOutput() {
      const now = await host.status();
      return now.kind === "done" ? (now.output?.content ?? "") : now.kind;
    },
  };

  const ctx = { storage: r.storage };
  const handle: (request: Request, now: number) => Promise<Outcome> = deferred
    ? stepHost(ctx, engine, {
        deferResume: {
          settled: () => false,
          enqueue() {
            calls.enqueues++;
          },
        },
      }).handle
    : stepHost(ctx, engine).handle;

  return {
    handle,
    calls,
    order,
    teardown,
    reached,
    // The run route: record the capability, start the run, wait for its first
    // tool call.
    async launch(runId: string) {
      await r.storage.put(`token:${runId}`, TOKEN);
      const runtime = await host.runtime();
      void runtime.dispatch({ _tag: "agent_start", runId, at: 0 }).catch(noop);
      await reaches(runtime, (s) => s.kind !== "idle" && s.kind !== "running");
    },
    async evict() {
      await host.reset();
    },
  };
}
type Activation = ReturnType<typeof activation>;

// The hands: run each step they are given, post its result, ask again. They
// stop at `until`, a step they were handed but have not posted yet.
async function drive(
  a: Activation,
  w: World,
  first: Request,
  until?: string,
): Promise<Outcome> {
  let request = first;
  for (;;) {
    w.sent.push(request);
    const outcome = await a.handle(request, NOW);
    if (outcome.status !== 200 || !("step" in outcome.body)) return outcome;
    w.executed.push(outcome.body.step.callId);
    if (outcome.body.step.callId === until) return outcome;
    request = post(outcome.body.step.callId);
  }
}

const finished: Outcome = {
  status: 200,
  body: { done: true, output: ANSWER.content },
};

describe.each([
  "model",
  "compaction",
] as const)("a step-hosted run evicted during its %s call, on retained storage", (mode) => {
  it.each(
    REPEATS,
  )("the hands retry on a fresh activation and every turn happens once (repeat %i)", async () => {
    const r = retained();
    const w = world();
    const first = activation(mode, r, w, mode);
    await first.launch(RUN);
    void drive(first, w, pull).catch(noop);
    await first.reached;

    const checkpoint = await r.saved();
    expect(status(checkpoint).kind).toBe("running");
    expect(checkpoint.conversation?.toolRecords).toHaveLength(DOCUMENTS - 1);
    expect(JSON.stringify(checkpoint).length).toBeGreaterThan(100_000);
    const unanswered = w.sent.at(-1);
    expect(unanswered?.posted?.callId).toBe("document-3");
    await first.evict();

    const second = activation(mode, r, w, null);
    expect(await drive(second, w, unanswered ?? pull)).toEqual(finished);

    const third = activation(mode, r, w, null);
    for (const again of [pull, post("document-4")]) {
      expect(await third.handle(again, NOW)).toEqual(finished);
    }

    expect(w.executed).toEqual([
      "document-1",
      "document-2",
      "document-3",
      "document-4",
    ]);
    expect(w.returned).toEqual([1, 2, 3, 4, 5]);
    expect(w.invocations).toBe(w.returned.length + w.lost);
    expect(w.lost).toBe(mode === "model" ? 1 : 0);
    expect(w.compactions).toEqual(
      mode === "compaction"
        ? { started: 2, folded: 1 }
        : { started: 0, folded: 0 },
    );
    expect(status(await r.saved())).toMatchObject({
      kind: "done",
      output: ANSWER,
    });
    expect(r.alarms.length).toBeGreaterThan(0);
    for (const a of [first, second, third]) {
      expect(
        a.teardown.every((name) => INTENTIONAL_TEARDOWN.includes(name)),
      ).toBe(true);
    }
    await second.evict();
    await third.evict();
  });
});

describe.each([
  ["inline", false],
  ["deferred", true],
] as const)("a stop recorded in retained storage, %s step host", (_label, deferred) => {
  const rig = async (stop: boolean) => {
    const r = retained();
    const w = world();
    const first = activation("model", r, w, null);
    await first.launch(RUN);
    await drive(first, w, pull, "document-3");
    if (stop) await r.storage.put(`stop:${RUN}`, true);
    await first.evict();
    return { r, w, next: activation("model", r, w, null, deferred) };
  };

  it.each(
    REPEATS,
  )("ends the run cancelled on each pull and pays for no further model call (repeat %i)", async () => {
    const { r, w, next } = await rig(true);
    const stopped: Outcome = {
      status: 200,
      body: { done: true, output: "cancelled" },
    };

    for (const again of [post("document-3"), post("document-3"), pull]) {
      expect(await next.handle(again, NOW)).toEqual(stopped);
    }
    expect(next.order.filter((step) => step !== "check-stop")).toEqual([]);
    expect(next.order[0]).toBe("check-stop");

    const cold = activation("model", r, w, null, deferred);
    expect(await cold.handle(post("document-3"), NOW)).toEqual(stopped);

    for (const a of [next, cold]) {
      expect(a.calls).toEqual({ resumes: 0, enqueues: 0 });
    }
    expect(w.invocations).toBe(3);
    expect(w.returned).toEqual([1, 2, 3]);
    expect(w.executed).toEqual(["document-1", "document-2", "document-3"]);
    expect(status(await r.saved()).kind).toBe("cancelled");
    expect(await r.storage.get<boolean>(`stop:${RUN}`)).toBe(true);
    await next.evict();
    await cold.evict();
  });

  it("resumes the run as before when no stop was recorded", async () => {
    const { r, w, next } = await rig(false);
    const outcome = await next.handle(post("document-3"), NOW);
    if (deferred) {
      expect(outcome).toEqual({
        status: 200,
        body: { done: false, working: true },
      });
      expect(next.calls).toEqual({ resumes: 0, enqueues: 1 });
      expect(w.invocations).toBe(3);
    } else {
      expect(outcome).toEqual({
        status: 200,
        body: {
          done: false,
          step: { callId: "document-4", tool: "read", input: { n: 4 } },
        },
      });
      expect(next.calls).toEqual({ resumes: 1, enqueues: 0 });
      expect(w.invocations).toBe(4);
    }
    expect(status(await r.saved()).kind).not.toBe("cancelled");
    await next.evict();
  });
});

describe.each([
  "running",
  "suspended",
] as const)("a stop recorded after cold recovery handed out a tool step, run left %s", (left) => {
  it.each(
    REPEATS,
  )("the next post cancels the run in one request and reset resolves (repeat %i)", async () => {
    const r = retained();
    const w = world();
    const lost = activation("model", r, w, left === "running" ? "model" : null);
    await lost.launch(RUN);
    if (left === "running") {
      void drive(lost, w, pull).catch(noop);
      await lost.reached;
    } else {
      await drive(lost, w, pull, "document-3");
    }
    expect(status(await r.saved()).kind).toBe(left);
    await lost.evict();

    const warm = activation("model", r, w, null);
    const handedOut = await drive(
      warm,
      w,
      left === "running" ? post("document-3") : pull,
      left === "running" ? "document-4" : "document-3",
    );
    const step = left === "running" ? "document-4" : "document-3";
    expect(handedOut).toMatchObject({
      status: 200,
      body: { done: false, step: { callId: step } },
    });
    const calls = w.invocations;
    const resumes = warm.calls.resumes;

    await r.storage.put(`stop:${RUN}`, true);
    expect(await warm.handle(post(step), NOW)).toEqual({
      status: 200,
      body: { done: true, output: "cancelled" },
    });

    expect(w.invocations).toBe(calls);
    expect(warm.calls.resumes).toBe(resumes);
    expect(warm.order.at(-1)).toBe("check-stop");
    expect(status(await r.saved()).kind).toBe("cancelled");
    await warm.evict();
    expect(
      warm.teardown.every((name) => INTENTIONAL_TEARDOWN.includes(name)),
    ).toBe(true);
  });
});

type Booting = {
  dispatch(msg: AgentMachineMsg<Purpose, Outputs, string>): Promise<void>;
  stop(): Promise<void>;
};

// A host whose every report reaches `onError`, and which tells the test the
// moment each runtime has booted, and each time `run` is about to hand one to
// the host.
function hostReporting<C extends Cmd>(
  wired: AgentWired<C>,
  store: Store<S>,
  onError: (error: unknown, context: { readonly phase: string }) => void,
  booted: (handle: Booting) => void,
  built: (handle: Booting, index: number) => void = noop,
) {
  let builds = 0;
  return createAgentHost<
    Stage,
    Purpose,
    Outputs,
    string,
    null,
    C,
    DeadlinesSub,
    object
  >({
    run: (machine, options) => {
      const booting = run(machine, { ...options, disposeTimeoutMs: 0 });
      void booting.ready.then(() => booted(booting));
      built(booting, builds++);
      return booting;
    },
    onError,
    buildMachine: () => wired,
    store,
    ctx: {},
    toSseFrame: () => null,
    now: () => 2,
  });
}

describe("a restored run whose agent_boot fails to save", () => {
  it.each(
    REPEATS,
  )("runtime() resolves early, onError hears the boot once, and reset() then runtime() boots again (repeat %i)", async () => {
    const { checkpoint, completed } = await lostDuring("model");
    const failure = new Error("save failed on agent_boot");
    const reports: Array<{ error: unknown; phase: string }> = [];
    let attempts = DOCUMENTS - 1;
    let armed = false;
    let builds = 0;
    const persisted = storage(checkpoint);
    const store: Store<S> = {
      ...persisted.store,
      save: async (state) => {
        if (armed) {
          armed = false;
          throw failure;
        }
        await persisted.store.save(state);
      },
    };
    const wired = wirePlain(
      plainAgent(async () => turn(++attempts)),
      async (cmd) => {
        completed.push(cmd.callId);
        return settled(cmd);
      },
    );
    const host = hostReporting(
      wired,
      store,
      (error, context) => reports.push({ error, phase: context.phase }),
      () => {
        armed = builds++ === 0;
      },
    );
    const boots = () => reports.filter((report) => report.phase === "boot");

    const first = await host.runtime();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(status(first.getState()).kind).toBe("running");
    expect(attempts).toBe(DOCUMENTS - 1);
    expect(boots()).toEqual([{ error: failure, phase: "boot" }]);
    expect(reports.map((report) => report.phase)).toEqual(["boot"]);

    expect(await host.runtime()).toBe(first);
    expect(attempts).toBe(DOCUMENTS - 1);
    expect(boots()).toHaveLength(1);

    await host.reset();
    expect(boots()).toHaveLength(1);
    const second = await host.runtime();
    expect(second).not.toBe(first);
    expect(await reaches(second, (now) => now.kind === "done")).toMatchObject({
      kind: "done",
      output: ANSWER,
    });
    expect(attempts).toBe(DOCUMENTS + 1);
    expect(completed).toEqual([
      "document-1",
      "document-2",
      "document-3",
      "document-4",
    ]);
    expect(boots()).toHaveLength(1);
    await host.reset();
  });
});

// Where `reset()` can arrive in a build's life, and what the build then owes.
// Each row is named by the lifecycle cell (`./host-lifecycle`) it drives.
// Each row holds the build at its point with a controllable store: `load` parks
// the cold load, `save` parks the first save after boot (or fails it), and
// `ahead` queues a second `agent_boot` before the host's own. `ends` is how the
// first runtime is ended while held; `release` is what unparks it afterwards.
interface LifecycleRow {
  readonly load: "held" | "free";
  readonly save: "fails" | "held" | "free";
  readonly ahead: boolean;
  readonly ends: "reset inside run" | "reset" | "stop" | "never";
  readonly first: "rejects" | "resolves";
  readonly dispatches: number;
  readonly reported: "nothing" | "the save failure" | "RuntimeStoppedError";
}

const LIFECYCLE = {
  "building × reset, before run() returns the handle": {
    load: "free",
    save: "free",
    ahead: false,
    ends: "reset inside run",
    first: "rejects",
    dispatches: 0,
    reported: "nothing",
  },
  "building × reset, while the cold load is pending": {
    load: "held",
    save: "free",
    ahead: false,
    ends: "reset",
    first: "rejects",
    dispatches: 0,
    reported: "nothing",
  },
  "live × reset, with the chain queued behind a pending save": {
    load: "free",
    save: "held",
    ahead: true,
    ends: "reset",
    first: "resolves",
    dispatches: 2,
    reported: "nothing",
  },
  "live × reset, and the pending save then rejects": {
    load: "free",
    save: "held",
    ahead: false,
    ends: "reset",
    first: "resolves",
    dispatches: 1,
    reported: "the save failure",
  },
  "live, no reset, and the save rejects": {
    load: "free",
    save: "fails",
    ahead: false,
    ends: "never",
    first: "resolves",
    dispatches: 1,
    reported: "the save failure",
  },
  "building, no reset, and the runtime is stopped under the boot": {
    load: "held",
    save: "free",
    ahead: false,
    ends: "stop",
    first: "resolves",
    dispatches: 1,
    reported: "RuntimeStoppedError",
  },
  "building × built, and the chain resolves": {
    load: "free",
    save: "free",
    ahead: false,
    ends: "never",
    first: "resolves",
    dispatches: 1,
    reported: "nothing",
  },
} as const satisfies Record<string, LifecycleRow>;

describe.each(
  Object.entries(LIFECYCLE),
)("a build against reset: %s", (_name, row: LifecycleRow) => {
  it.each(
    REPEATS,
  )("reports, dispatches and boots again as the table says (repeat %i)", async () => {
    const { checkpoint, completed } = await lostDuring("model");
    const failure = new Error("save failed on agent_boot");
    const reports: Array<{ error: unknown; phase: string }> = [];
    const dispatches: number[] = [];
    const stops: number[] = [];
    const handles: Booting[] = [];
    const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
    let releaseLoad: () => void = noop;
    const loadHeld = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    let rejectSave: (error: Error) => void = noop;
    const saveHeld = new Promise<void>((_resolve, reject) => {
      rejectSave = reject;
    });
    let loads = 0;
    let booted = false;
    let saves = 0;
    let attempts = DOCUMENTS - 1;
    const persisted = storage(checkpoint);
    const store: Store<S> = {
      ...persisted.store,
      load: async () => {
        if (loads++ === 0 && row.load === "held") await loadHeld;
        return persisted.store.load();
      },
      save: async (state) => {
        const first = booted && ++saves === 1;
        if (first && row.save === "fails") throw failure;
        if (first && row.save === "held") await saveHeld;
        await persisted.store.save(state);
      },
    };
    const wired = wirePlain(
      plainAgent(async () => turn(++attempts)),
      async (cmd) => {
        completed.push(cmd.callId);
        return settled(cmd);
      },
    );
    const host: ReturnType<typeof hostReporting> = hostReporting(
      wired,
      store,
      (error, context) => reports.push({ error, phase: context.phase }),
      (handle) => {
        booted = true;
        if (row.ahead) handle.dispatch(agentBootMsg(NOW)).catch(noop);
      },
      (handle, index) => {
        const { dispatch, stop } = handle;
        Object.assign(handle, {
          stop: () => {
            stops[index] = (stops[index] ?? 0) + 1;
            return stop();
          },
          dispatch: (msg: AgentMachineMsg<Purpose, Outputs, string>) => {
            dispatches[index] = (dispatches[index] ?? 0) + 1;
            return dispatch(msg);
          },
        });
        handles[index] = handle;
        if (index === 0 && row.ends === "reset inside run") void host.reset();
      },
    );

    const first = host.runtime();
    const outcome = first.then(
      () => "resolves",
      () => "rejects",
    );
    await tick();
    if (row.ends === "reset") {
      if (row.load === "held") {
        await host.reset();
        releaseLoad();
      } else {
        await first;
        const resetting = host.reset();
        await tick();
        rejectSave(failure);
        await resetting;
      }
    } else if (row.ends === "stop") {
      await handles[0]?.stop();
      releaseLoad();
    } else {
      releaseLoad();
      if (row.save === "free") await tick();
    }
    await tick();

    expect(await outcome).toBe(row.first);
    if (row.first === "rejects")
      await expect(first).rejects.toBeInstanceOf(DispatchDiscardedError);
    expect(dispatches[0] ?? 0).toBe(row.dispatches);
    expect(stops[0] ?? 0).toBe(row.ends === "never" ? 0 : 1);
    const owed = {
      nothing: [],
      "the save failure": [{ error: failure, phase: "boot" }],
      RuntimeStoppedError: [
        { error: expect.any(RuntimeStoppedError), phase: "boot" },
      ],
    } satisfies Record<LifecycleRow["reported"], unknown[]>;
    expect(reports.filter((report) => report.phase === "boot")).toEqual(
      owed[row.reported],
    );
    expect(
      reports.every(
        (report) => report.phase === "boot" || report.phase === "discard",
      ),
    ).toBe(true);

    await host.reset();
    const next = await host.runtime();
    expect(await reaches(next, (now) => now.kind === "done")).toMatchObject({
      kind: "done",
      output: ANSWER,
    });
    expect(completed).toEqual([
      "document-1",
      "document-2",
      "document-3",
      "document-4",
    ]);
    await host.reset();
  });
});

// The host's lifecycle table (`./host-lifecycle`) driven through a real host
// over one retained store, for the cells a teardown can overlap. The first
// build's model call never returns, so the run is still mid-run when `reset()`
// comes, and the save `stop()` makes on the way out is held: that teardown is
// in flight while the cell under test arrives.
function overlapping(checkpoint: S | null) {
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
  let releaseSave: () => void = noop;
  const saveHeld = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  let saveReached: () => void = noop;
  const reachedSave = new Promise<void>((resolve) => {
    saveReached = resolve;
  });
  let stopping = false;
  let holding = true;
  let builds = 0;
  let attempts = DOCUMENTS - 1;
  const persisted = storage(checkpoint);
  const store: Store<S> = {
    ...persisted.store,
    save: async (state) => {
      if (stopping && holding) {
        holding = false;
        saveReached();
        await saveHeld;
      }
      await persisted.store.save(state);
    },
  };
  const invoke = async () =>
    builds === 1 ? hangs<AgentTurn>() : turn(++attempts);
  return {
    tick,
    store,
    persisted,
    invoke,
    releaseSave,
    reachedSave,
    built: () => {
      builds++;
    },
    builds: () => builds,
    stopping: () => {
      stopping = true;
    },
  };
}

describe("a teardown in flight: tearingDown × reset, then runtime()", () => {
  it.each(
    REPEATS,
  )("shares the teardown and builds the replacement after the old run's last save (repeat %i)", async () => {
    const { checkpoint, completed } = await lostDuring("model");
    const held = overlapping(checkpoint);
    const reports: Array<{ error: unknown; phase: string }> = [];
    const wired = wirePlain(plainAgent(held.invoke), async (cmd) => {
      completed.push(cmd.callId);
      return settled(cmd);
    });
    const host = hostReporting(
      wired,
      held.store,
      (error, context) => reports.push({ error, phase: context.phase }),
      noop,
      held.built,
    );

    const first = await host.runtime();
    await held.tick();
    held.stopping();
    const resetting = host.reset();
    await held.reachedSave;
    const overlapped = host.reset();
    const replacement = host.runtime();
    for (let i = 0; i < 8; i++) await held.tick();
    expect(held.builds()).toBe(1);
    held.releaseSave();

    expect(overlapped).toBe(resetting);
    await resetting;
    const second = await replacement;
    expect(second).not.toBe(first);
    expect(await reaches(second, (now) => now.kind === "done")).toMatchObject({
      kind: "done",
      output: ANSWER,
    });
    for (let i = 0; i < 4; i++) await held.tick();
    expect(status(held.persisted.snapshot() as S).kind).toBe("done");
    expect(completed).toEqual([
      "document-1",
      "document-2",
      "document-3",
      "document-4",
    ]);
    expect(reports.filter((report) => report.phase === "boot")).toEqual([]);
    await host.reset();
  });
});

describe("a teardown in flight: tearingDown × runtime, then reset", () => {
  it.each(
    REPEATS,
  )("discards the waiting runtime() and the next runtime() boots once (repeat %i)", async () => {
    const { checkpoint, completed } = await lostDuring("model");
    const held = overlapping(checkpoint);
    const wired = wirePlain(plainAgent(held.invoke), async (cmd) => {
      completed.push(cmd.callId);
      return settled(cmd);
    });
    const host = hostReporting(wired, held.store, noop, noop, held.built);

    await host.runtime();
    await held.tick();
    held.stopping();
    const resetting = host.reset();
    await held.reachedSave;
    const waiting = host.runtime();
    const cancelling = host.reset();
    expect(cancelling).toBe(resetting);
    await expect(waiting).rejects.toBeInstanceOf(DispatchDiscardedError);
    held.releaseSave();
    await resetting;
    expect(held.builds()).toBe(1);

    const next = await host.runtime();
    expect(held.builds()).toBe(2);
    expect(await reaches(next, (now) => now.kind === "done")).toMatchObject({
      kind: "done",
      output: ANSWER,
    });
    expect(completed).toEqual([
      "document-1",
      "document-2",
      "document-3",
      "document-4",
    ]);
    await host.reset();
  });
});
