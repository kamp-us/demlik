import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { Cause, Effect, Exit, Queue, Scope, Stream } from "effect";
import { z } from "zod";
import {
  type AgentCmd,
  type AgentCompactRunCmd,
  type AgentMachineMsg,
  type AgentState,
  type AgentTurn,
  agentBootMsg,
  agentCancelMsg,
  agentTurnSchema,
  compactionSummarySchema,
  createAgent,
  type Schema,
  type ToolCall,
} from "../../packages/tea/src/agent/index.ts";
import { run as runEffect } from "../../packages/tea/src/effect/index.ts";
import { type Machine, Outcome } from "../../packages/tea/src/index.ts";
import {
  type DeadlinesSub,
  subscribeWith,
} from "../../packages/tea/src/internal/resilience/deadline/index.ts";
import { fileStore } from "../../packages/tea/src/node/index.ts";
import { run as runPromise } from "../../packages/tea/src/promise/index.ts";
import {
  DispatchDiscardedError,
  DrainTimeoutNotice,
  RuntimeDiscardedError,
} from "../../packages/tea/src/runtime-types.ts";

const inputSchema = z.strictObject({
  id: z.string(),
  mode: z.enum(["runtime", "writer", "reader"]),
  profile: z.enum(["promise", "effect"]),
  snapshot: z.boolean(),
  compaction: z.boolean(),
  every: z.union([z.number(), z.enum(["NaN", "Infinity"])]).default(2),
  scenario: z.enum(["normal", "held", "held-stop", "writer-fail", "save-fail"]),
  path: z.string(),
  anchors: z.boolean().default(false),
  messageMode: z.enum(["single", "ordered"]).optional(),
});
type Input = z.infer<typeof inputSchema>;
type Outputs = { invoice: AgentTurn };
type State = AgentState<string, "invoice", Outputs, unknown>;
type Msg = AgentMachineMsg<"invoice", Outputs, unknown>;
type Tool = { readonly type: "invoice_tool"; readonly call: ToolCall };
type Req = {
  purpose: "invoice";
  model: string | null;
  payload: { stage: string; conversation: NonNullable<State["conversation"]> };
};
const normalized = (v: unknown) => JSON.parse(JSON.stringify(v));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function factory(invoke: (messages: readonly Req[]) => Promise<unknown>) {
  return () => ({
    withStructuredOutput<T>(schema: Schema<T>) {
      return {
        invoke: async (messages: readonly Req[]) =>
          schema.parse(await invoke(messages)),
      };
    },
  });
}
const turn = (name: string) =>
  name === "done"
    ? {
        content: "invoice verified:15",
        toolCalls: [],
        unknownTurn: { final: true },
      }
    : {
        content: name,
        toolCalls: [
          {
            callId: `${name}-1`,
            name,
            args: { path: "invoice.json", unknownArg: [1, null] },
            unknownCall: { kept: true },
          },
        ],
        usage: { inputTokens: 7, outputTokens: 2 },
        unknownTurn: { kept: true },
      };
async function settle<A, E>(effect: Effect.Effect<A, E>) {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}
function anchors(calls: string[]) {
  return [
    ["zero", 0],
    ["fractional", 2.5],
    ["nan", Number.NaN],
    ["infinity", Number.POSITIVE_INFINITY],
  ].map(([id, every]) => {
    const knob = createAgent<string, "invoice", Outputs, unknown, Tool, Req>({
      stages: ["collect", "report"],
      turnOf: () => "invoice",
      toolOf: (call) => ({ type: "invoice_tool", call }),
      schemas: { invoice: agentTurnSchema },
      model: factory(async () => null),
      snapshotEvery: Number(every),
      rng: () => 0,
    });
    let [state] = knob.start(knob.init(), "anchor", 0);
    const emitted: unknown[] = [];
    for (const name of ["collect", "check", "done", "done"]) {
      const step = knob.turn(state, agentTurnSchema.parse(turn(name)), 1);
      calls.push("createAgent.turn");
      state = step[0];
      emitted.push(...step[1].filter((c) => c.type === "snapshot_write"));
      if (name !== "done") {
        [state] = knob.toolOk(state, `${name}-1`, { ok: true }, 1);
        calls.push("createAgent.toolOk");
      }
    }
    return normalized({ id, snapshot: state.run.snapshot, commands: emitted });
  });
}
async function runtime(input: Input) {
  const directory = input.path;
  await mkdir(directory, { recursive: true });
  if (input.mode !== "reader")
    await writeFile(
      path.join(directory, "invoice.json"),
      JSON.stringify({ id: "inv-17", lines: [4.5, 10.5], total: 15 }),
    );
  if (input.mode === "reader")
    await copyFile(
      path.join(directory, "named.json"),
      path.join(directory, "state.json"),
    );
  const calls: string[] = [],
    trace: unknown[] = [],
    reports: unknown[] = [],
    rawReports: unknown[] = [],
    perStage = new Map<string, number>(),
    entered = deferred(),
    release = deferred();
  const now = input.mode === "reader" ? 57.25 : 17.25,
    cause = { source: "snapshot-fixture", token: 17 };
  let models = 0,
    tools = 0,
    compacts = 0,
    snapshots = 0,
    loaded: State | null | undefined,
    failNext = false,
    injectedAt: string | null = null;
  const messageValue = {
    label: "original",
    unknown: { values: [1, null, "kept"] },
  };
  const messages: unknown[] = [];
  let ownerChecks = 0,
    ownerSame = true;
  let dispatchOnce!: (msg: Msg) => Promise<unknown>;
  const messageView = () =>
    input.messageMode
      ? {
          messages,
          messageOwners: {
            status: ownerChecks > 0 ? "tracked" : "not-applicable",
            checks: ownerChecks,
            same: ownerChecks > 0 ? ownerSame : null,
          },
        }
      : {};
  const counts = () => [models, tools, compacts, snapshots];
  const onError = (error: unknown, context: { phase: string }) => {
    const same = error === cause;
    const notice =
      error instanceof RuntimeDiscardedError
        ? { name: error.name, pendingCmds: error.pendingCmds }
        : error instanceof DrainTimeoutNotice
          ? {
              name: error.name,
              cmdTypes: error.cmdTypes,
              pendingCmds: error.pendingCmds,
              timeoutMs: error.timeoutMs,
            }
          : error instanceof DispatchDiscardedError
            ? { name: error.name, msgType: error.msgType }
            : { name: error instanceof Error ? error.name : "unknown" };
    reports.push(
      input.messageMode && !same
        ? { phase: context.phase, cause: null, same, notice }
        : { phase: context.phase, cause: error, same },
    );
    rawReports.push({ context, error, display: String(error) });
  };
  const bytes = async (name: string) => {
    try {
      return await readFile(path.join(directory, name), "utf8");
    } catch {
      return null;
    }
  };
  const tool = async (cmd: Tool) => {
    tools++;
    trace.push(["tool", cmd.call.name]);
    const invoice = JSON.parse(
      await readFile(path.join(directory, "invoice.json"), "utf8"),
    );
    let result = invoice;
    if (cmd.call.name !== "collect") {
      assert.equal(cmd.call.name, "check");
      const total = invoice.lines.reduce((a: number, b: number) => a + b, 0);
      assert.equal(total, 15);
      result = { valid: true, total };
      await writeFile(
        path.join(directory, "validated.json"),
        JSON.stringify(result),
      );
    }
    return [
      {
        type: "agent_tool_ok" as const,
        callId: cmd.call.callId,
        result,
        at: now,
      },
    ];
  };
  const compact = async (cmd: AgentCompactRunCmd): Promise<readonly Msg[]> => {
    compacts++;
    trace.push(["compact", normalized(cmd.input)]);
    const raw = {
        summary: "invoice inv-17 total=15 checked",
        unknownSummary: { kept: true },
      },
      output = compactionSummarySchema.parse(raw);
    assert.equal(output, raw);
    calls.push("compactionSummarySchema.parse");
    return [
      {
        type: "compact_ok",
        key: cmd.key,
        result: { key: cmd.key, purpose: "$compact", output },
        at: now,
      },
    ];
  };
  const snapshot = async (
    cmd: {
      key: string;
      seq: number;
      at: number;
      payload: unknown;
    },
    _ctx?: unknown,
    _fromHandler?: (msg: Msg) => void,
    signal?: AbortSignal,
  ) => {
    snapshots++;
    const saved = await bytes("state.json");
    assert.ok(saved !== null, "actual Store save before checkpoint IO");
    trace.push([
      "snapshot",
      normalized(cmd),
      {
        ownPayload: Object.hasOwn(cmd, "payload"),
        payloadKind: typeof cmd.payload,
      },
      JSON.parse(saved),
    ]);
    if (input.scenario === "writer-fail") {
      injectedAt = "handler";
      throw cause;
    }
    await writeFile(path.join(directory, "named.json"), saved);
    if (
      input.mode === "writer" ||
      input.scenario === "held" ||
      input.scenario === "held-stop"
    ) {
      entered.resolve();
      if (input.mode === "writer") await new Promise(() => {});
      else if (signal && input.scenario === "held-stop")
        await new Promise<void>((resolve, reject) => {
          const aborted = () => reject(signal.reason);
          signal.addEventListener("abort", aborted, { once: true });
          release.promise.then(() => {
            signal.removeEventListener("abort", aborted);
            resolve();
          });
        });
      else await release.promise;
    }
    return undefined;
  };
  const snapshotMessages = async (
    cmd: Parameters<typeof snapshot>[0],
    ctx?: unknown,
    dispatch?: (msg: Msg) => void,
    signal?: AbortSignal,
  ) => {
    await snapshot(cmd, ctx, dispatch, signal);
    if (input.messageMode) {
      const returned: Msg[] = [];
      if (snapshots === 1) {
        if (input.messageMode === "ordered") {
          const make = (callId: string, at: number): Msg => ({
            type: "agent_tool_ok",
            callId,
            result: messageValue,
            at,
          });
          const direct = make("follow-context", now + 1);
          trace.push(["context-dispatch", normalized(direct)]);
          if (dispatch) dispatch(direct);
          else
            void dispatchOnce(direct).catch((error) =>
              onError(error, { phase: "fixture-dispatch" }),
            );
          returned.push(
            make("follow-first", now + 1.25),
            make("follow-second", now + 1.5),
          );
        }
        returned.push(agentCancelMsg(now + 2.25));
        calls.push("agentCancelMsg");
      }
      trace.push(["returned", normalized(returned)]);
      return input.messageMode === "single" ? returned[0] : returned;
    }
    return undefined;
  };
  const original = fileStore<State>(
    path.join(directory, "state.json"),
    (value) => {
      loaded = value as State;
      return loaded;
    },
  );
  const store = {
    ...original,
    async save(state: State) {
      trace.push(["save", state.run.phase, normalized(state.run.snapshot)]);
      if (failNext) {
        failNext = false;
        injectedAt = "save";
        throw cause;
      }
      await original.save(state);
    },
  };
  const core = {
    stages: ["collect", "report"],
    turnOf: () => "invoice" as const,
    toolOf: (call: ToolCall): Tool => ({ type: "invoice_tool", call }),
    payloadOf: (
      stage: string | undefined,
      conversation: NonNullable<State["conversation"]>,
    ) => ({ stage, conversation }),
    schemas: { invoice: agentTurnSchema },
    loadMessages: async (call: unknown) => {
      const request = call as Req;
      trace.push([
        "load",
        request.payload.stage,
        request.payload.conversation.turns.length,
      ]);
      return [request];
    },
    model: factory(async (messages) => {
      const request = messages[0];
      assert.ok(request);
      const stage = request.payload.stage,
        n = perStage.get(stage) ?? 0;
      perStage.set(stage, n + 1);
      models++;
      trace.push(["model", stage, n]);
      const name =
        stage === "report" || n >= 2 ? "done" : n === 0 ? "collect" : "check";
      if (
        input.scenario === "save-fail" &&
        stage === "collect" &&
        name === "done"
      )
        failNext = true;
      return turn(name);
    }),
    rng: () => 0,
  };
  const policy = {
    planCompaction: (c: NonNullable<State["conversation"]>) =>
      c.turns.length >= 2 ? 2 : 0,
    payloadOf: (
      conversation: NonNullable<State["conversation"]>,
      folding: number,
    ) => ({ conversation, folding }),
  };
  const grid = (() => {
    if (input.snapshot && input.compaction) {
      const knob = createAgent<string, "invoice", Outputs, unknown, Tool, Req>({
        ...core,
        snapshotEvery: Number(input.every),
        compaction: policy,
      });
      return {
        knob,
        wired: knob.toMachine({
          toolInterpret: {
            invoice_tool: tool,
            snapshot_write: snapshot,
            compact_run: compact,
          },
        }),
      };
    }
    if (input.snapshot) {
      const knob = createAgent<string, "invoice", Outputs, unknown, Tool, Req>({
        ...core,
        snapshotEvery: Number(input.every),
      });
      return {
        knob,
        wired: knob.toMachine({
          toolInterpret: { invoice_tool: tool, snapshot_write: snapshot },
        }),
      };
    }
    if (input.compaction) {
      const knob = createAgent<string, "invoice", Outputs, unknown, Tool, Req>({
        ...core,
        compaction: policy,
      });
      return {
        knob,
        wired: knob.toMachine({
          toolInterpret: { invoice_tool: tool, compact_run: compact },
        }),
      };
    }
    const knob = createAgent<string, "invoice", Outputs, unknown, Tool, Req>(
      core,
    );
    return {
      knob,
      wired: knob.toMachine({ toolInterpret: { invoice_tool: tool } }),
    };
  })();
  calls.push("createAgent.toMachine");
  // The four concrete obligations above are checked before this fixture-only
  // covariant command widening; actual machine/handler objects are retained.
  if (input.messageMode) {
    assert.equal(
      Reflect.get(grid.wired.interpret, "snapshot_write"),
      snapshot,
      "actual typed IO handler instance",
    );
    assert.equal(
      Reflect.set(grid.wired.interpret, "snapshot_write", snapshotMessages),
      true,
    );
    assert.equal(
      Reflect.get(grid.wired.interpret, "snapshot_write"),
      snapshotMessages,
    );
  }
  const snapshotCell = Reflect.get(grid.wired.interpret, "snapshot_write");
  const invokeSnapshot = async (
    cmd: Parameters<typeof snapshot>[0],
    signal: AbortSignal,
  ) => {
    assert.equal(typeof snapshotCell, "function");
    return Reflect.apply(snapshotCell, undefined, [
      cmd,
      undefined,
      undefined,
      signal,
    ]);
  };
  const machine: Machine<
    State,
    Msg,
    AgentCmd<"invoice", Tool>,
    DeadlinesSub,
    object
  > = grid.wired.machine;
  let getState!: () => State,
    dispatch!: (m: Msg) => Promise<unknown>,
    done!: () => Promise<State>,
    result!: () => State | undefined,
    stop!: () => Promise<void>,
    idle!: () => Promise<void>,
    observeCommit!: (cb: (msg: Msg, state: State) => void) => void;
  const runner = subscribeWith(() => {
    throw new Error("no deadline arms configured");
  });
  if (input.profile === "effect") {
    const scope = await Effect.runPromise(Scope.make());
    const live = await Effect.runPromise(
      Scope.provide(scope)(
        runEffect(machine, {
          ctx: {},
          store,
          clock: () => now,
          terminal: grid.knob.isSettled,
          onError,
          ...(input.scenario === "held-stop" ? { disposeTimeoutMs: 5 } : {}),
          interpret: {
            resilient_run: (
              cmd: Parameters<typeof grid.wired.interpret.resilient_run>[0],
            ) =>
              Effect.promise(() =>
                grid.wired.interpret.resilient_run(cmd, {
                  ok: Outcome.ok,
                  err: Outcome.err,
                  emit() {
                    throw new Error("unexpected emission");
                  },
                }),
              ).pipe(
                Effect.flatMap((out) =>
                  out
                    ? out._tag === "Ok"
                      ? Effect.succeed(out.value)
                      : Effect.fail(out.error)
                    : Effect.succeed(undefined),
                ),
              ),
            invoice_tool: (cmd: Tool) =>
              Effect.tryPromise({ try: () => tool(cmd), catch: (e) => e }),
            ...(input.snapshot
              ? {
                  snapshot_write: (cmd: Parameters<typeof snapshot>[0]) =>
                    Effect.tryPromise({
                      try: (signal) =>
                        input.messageMode
                          ? invokeSnapshot(cmd, signal)
                          : snapshot(cmd, undefined, undefined, signal),
                      catch: (e) => e,
                    }).pipe(
                      Effect.ensuring(
                        Effect.sync(() => {
                          if (
                            input.messageMode &&
                            input.scenario === "held-stop"
                          )
                            trace.push(["writer-cleanup"]);
                        }),
                      ),
                    ),
                }
              : {}),
            ...(input.compaction
              ? {
                  compact_run: (cmd: AgentCompactRunCmd) =>
                    Effect.tryPromise({
                      try: () => compact(cmd),
                      catch: (e) => e,
                    }),
                }
              : {}),
          } as never,
          subscribe: {
            deadline: (sub) => {
              const queue = Effect.runSync(Queue.unbounded<Msg>());
              const cancel = runner(sub, {}, (msg) =>
                Queue.offerUnsafe(queue, msg),
              );
              return Stream.fromQueue(queue).pipe(
                Stream.ensuring(Effect.sync(cancel)),
              );
            },
          },
        }),
      ),
    );
    const liveRun = await settle(live.ready);
    getState = liveRun.getState;
    observeCommit = (cb) => {
      liveRun.observe(cb);
    };
    dispatch = (m) => settle(liveRun.dispatch(m));
    dispatchOnce = (m) => settle(liveRun.dispatchOnce(m));
    idle = () => settle(liveRun.idle());
    done = () => settle(liveRun.done());
    result = liveRun.result;
    stop = () => Effect.runPromise(Scope.close(scope, Exit.void));
    calls.push("effect.run.ready");
  } else {
    const live = await runPromise(machine, {
      ctx: {},
      store,
      clock: () => now,
      terminal: grid.knob.isSettled,
      onError,
      ...(input.scenario === "held-stop" ? { disposeTimeoutMs: 5 } : {}),
      interpret: grid.wired.interpret as never,
      subscribe: { deadline: runner },
    }).ready;
    getState = live.getState;
    observeCommit = (cb) => {
      live.observe(cb);
    };
    dispatch = live.dispatch;
    dispatchOnce = live.dispatchOnce;
    idle = () => live.idle();
    done = () => live.done();
    result = live.result;
    stop = () => live.stop();
    calls.push("promise.run.ready");
  }
  const ready = normalized(getState()),
    readyCounts = counts(),
    tracked = loaded != null,
    readySame = !tracked || getState() === loaded;
  const committer = (msg: Msg, state: State) => {
    trace.push([
      "commit",
      msg.type,
      state.run.phase,
      normalized(state.run.snapshot),
    ]);
    if (input.messageMode) {
      if (msg.type === "agent_cancel") messages.push(normalized(msg));
      else if (
        msg.type === "agent_tool_ok" &&
        msg.callId.startsWith("follow-")
      ) {
        messages.push(normalized(msg));
        ownerChecks++;
        ownerSame = ownerSame && msg.result === messageValue;
      }
    }
  };
  observeCommit(committer);
  let earlyDoneResolved = false;
  const early =
    input.scenario === "held"
      ? done().then((s) => {
          earlyDoneResolved = true;
          return s;
        })
      : null;
  const pending = dispatch(
    input.mode === "reader"
      ? agentBootMsg(now)
      : { type: "agent_start", runId: "invoice-run", at: now },
  );
  let held: unknown = null;
  if (
    input.mode === "writer" ||
    input.scenario === "held" ||
    input.scenario === "held-stop"
  ) {
    await Promise.race([
      entered.promise,
      pending.then(() => {
        throw new Error("checkpoint hold not reached");
      }),
    ]);
    if (input.mode === "writer")
      return {
        id: input.id,
        view: normalized({
          ready,
          readyCounts,
          loaded: {
            status: tracked ? "tracked" : "not-applicable",
            checks: tracked ? 1 : 0,
            same: readySame,
          },
          state: getState(),
          counts: counts(),
          trace,
          held: null,
          failure: null,
          reports,
          ...messageView(),
        }),
        storeBytes: await bytes("state.json"),
        namedBytes: await bytes("named.json"),
        observedCalls: calls,
        rawReports,
      };
    if (input.scenario === "held-stop") {
      const before = getState();
      const beforeStop = {
        storeBytes: await bytes("state.json"),
        namedBytes: await bytes("named.json"),
      };
      await stop();
      const after = getState();
      const afterStop = {
        storeBytes: await bytes("state.json"),
        namedBytes: await bytes("named.json"),
      };
      release.resolve();
      await idle();
      let rejected = false;
      try {
        await pending;
      } catch {
        rejected = true;
      }
      const final = getState();
      return {
        id: input.id,
        view: normalized({
          ready,
          readyCounts,
          loaded: {
            status: tracked ? "tracked" : "not-applicable",
            checks: tracked ? 1 : 0,
            same: readySame,
          },
          state: final,
          counts: counts(),
          trace,
          held: {
            stateSameAfterStop: before === after,
            stateSameAfterLate: after === final,
            afterStop,
            initialDispatchRejected: rejected,
          },
          failure: null,
          doneSame: false,
          reports,
          beforeStop,
          ...messageView(),
        }),
        storeBytes: await bytes("state.json"),
        namedBytes: await bytes("named.json"),
        observedCalls: calls,
        rawReports,
      };
    }
    const state = getState(),
      late = await done();
    held = normalized({
      state,
      counts: counts(),
      trace: [...trace],
      earlyDonePending: !earlyDoneResolved,
      lateDoneSame: late === state,
      resultSame: result() === state,
      storeBytes: await bytes("state.json"),
      namedBytes: await bytes("named.json"),
    });
    release.resolve();
  }
  let failure: unknown = null;
  try {
    await pending;
  } catch (error) {
    failure = {
      phase: error === cause ? injectedAt : "other",
      cause: error,
      same: error === cause,
    };
  }
  const final = getState(),
    doneSame =
      failure === null &&
      grid.knob.isSettled(final) &&
      (await done()) === final;
  if (early) await early;
  const beforeStop = {
    storeBytes: await bytes("state.json"),
    namedBytes: await bytes("named.json"),
  };
  await stop();
  const view = normalized({
    ready,
    readyCounts,
    loaded: {
      status: tracked ? "tracked" : "not-applicable",
      checks: tracked ? 1 : 0,
      same: readySame,
    },
    state: final,
    counts: counts(),
    trace,
    held,
    failure,
    doneSame,
    reports,
    beforeStop,
    ...messageView(),
    ...(input.anchors ? { anchors: anchors(calls) } : {}),
  });
  return {
    id: input.id,
    view,
    storeBytes: await bytes("state.json"),
    namedBytes: await bytes("named.json"),
    observedCalls: calls,
    rawReports,
  };
}
for await (const line of createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})) {
  const input = inputSchema.parse(JSON.parse(line));
  console.log(JSON.stringify(await runtime(input)));
}
