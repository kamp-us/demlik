import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { Cause, Effect, Exit, Queue, Scope, Stream } from "effect";
import { z } from "zod";
import {
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
import { Outcome } from "../../packages/tea/src/index.ts";
import { subscribeWith } from "../../packages/tea/src/internal/resilience/deadline/index.ts";
import { fileStore } from "../../packages/tea/src/node/index.ts";
import { run as runPromise } from "../../packages/tea/src/promise/index.ts";

const number = z.union([
  z.number(),
  z.enum(["NaN", "Infinity", "-Infinity", "-0"]),
]);
const configSchema = z.strictObject({
  folding: number.default(2),
  threshold: z.number().int().default(2),
  retry: z.number().optional(),
  maxTurns: z.number().optional(),
  payload: z.boolean().default(true),
  rng: z.array(z.number()).min(1).default([0.25, 0.75]),
});
const inputSchema = z.strictObject({
  id: z.string(),
  mode: z.enum(["pure", "runtime", "writer", "reader"]),
  config: configSchema.default({
    folding: 2,
    threshold: 2,
    payload: true,
    rng: [0.25, 0.75],
  }),
  actions: z.array(z.unknown()).default([]),
  profile: z.enum(["promise", "effect"]).optional(),
  scenario: z.string().optional(),
  path: z.string().optional(),
});
type Input = z.infer<typeof inputSchema>;
type Outputs = { invoice: AgentTurn };
type State = AgentState<null, "invoice", Outputs, unknown>;
type Msg = AgentMachineMsg<"invoice", Outputs, unknown>;
type Tool = { readonly type: "invoice_tool"; readonly call: ToolCall };
type Request = {
  purpose: "invoice";
  model: string | null;
  payload: { conversation: NonNullable<State["conversation"]> };
};
const normalized = (value: unknown) => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function shared() {
  return {
    log: [] as unknown[],
    calls: [] as string[],
    rngIndex: 0,
    planOwner: null as State["conversation"],
    payloadSame: true,
    summary: null as object | null,
  };
}
type Shared = ReturnType<typeof shared>;
function factory(invoke: () => Promise<unknown>) {
  return () => ({
    withStructuredOutput<T>(schema: Schema<T>) {
      return { invoke: async () => schema.parse(await invoke()) };
    },
  });
}
function agent(
  config: Input["config"],
  ctx: Shared,
  invoke: () => Promise<unknown> = async () => null,
) {
  const folding =
    typeof config.folding === "number"
      ? config.folding
      : Number(config.folding);
  const policy = {
    planCompaction: (conversation: NonNullable<State["conversation"]>) => {
      ctx.log.push(["plan", conversation.turns.length, conversation.turnCount]);
      ctx.planOwner = conversation;
      return conversation.turns.length >= config.threshold ? folding : 0;
    },
    payloadOf: (
      conversation: NonNullable<State["conversation"]>,
      n: number,
    ) => {
      if (conversation.awaiting.kind !== "compacting" && ctx.planOwner !== null)
        ctx.payloadSame &&= conversation === ctx.planOwner;
      ctx.log.push(["payload", conversation.turns.length, n]);
      return config.payload ? { conversation, folding: n } : null;
    },
  };
  return createAgent<null, "invoice", Outputs, unknown, Tool, unknown>({
    stages: [null],
    turnOf: () => "invoice",
    toolOf: (call) => ({ type: "invoice_tool", call }),
    payloadOf: (_, conversation) => ({ conversation }),
    schemas: { invoice: agentTurnSchema },
    model: factory(invoke),
    rng: () => {
      const value = config.rng[ctx.rngIndex++ % config.rng.length];
      assert.notEqual(value, undefined);
      ctx.log.push(["rng", value]);
      return value;
    },
    compaction: policy,
    ...(config.retry === undefined
      ? {}
      : {
          retry: {
            baseMs: 10,
            factor: 2,
            capMs: 1000,
            jitter: "full",
            maxAttempts: config.retry,
          },
        }),
    ...(config.maxTurns === undefined ? {} : { maxTurns: config.maxTurns }),
  });
}
function pure(input: Input) {
  const ctx = shared();
  const knob = agent(input.config, ctx);
  let state = knob.init();
  ctx.calls.push("createAgent.init");
  const frames: unknown[] = [];
  let lastBrain: unknown;
  for (const unknownAction of input.actions) {
    const action = z.record(z.string(), z.unknown()).parse(unknownAction);
    const at = typeof action.at === "number" ? action.at : 0;
    let commands: readonly { type: string }[] = [];
    switch (action.op) {
      case "start":
        [state, commands] = knob.start(state, "invoice-run", at);
        ctx.calls.push("createAgent.start");
        break;
      case "turn":
        [state, commands] = knob.turn(
          state,
          agentTurnSchema.parse(action.turn),
          at,
        );
        ctx.calls.push("createAgent.turn");
        break;
      case "toolOk":
        [state, commands] = knob.toolOk(
          state,
          z.string().parse(action.id),
          action.result,
          at,
        );
        ctx.calls.push("createAgent.toolOk");
        break;
      case "compactOk": {
        const output = compactionSummarySchema.parse(action.output);
        ctx.summary = output;
        const msg = {
          type: "compact_ok" as const,
          key: "$compact" as const,
          result: { key: "$compact", purpose: "$compact" as const, output },
          at,
        };
        [state, commands] = knob.compactOk(state, msg.key, msg, at);
        ctx.calls.push("createAgent.compactOk");
        break;
      }
      case "compactErr": {
        const msg = {
          type: "compact_err" as const,
          key: "$compact" as const,
          error: {
            key: "$compact",
            purpose: "$compact" as const,
            reason: "provider rejected",
            error: action.cause,
          },
          at,
        };
        [state, commands] = knob.compactErr(state, msg.key, msg, at);
        ctx.calls.push("createAgent.compactErr");
        break;
      }
      case "brainErr": {
        const msg = {
          type: "resilient_run_err",
          cmd: lastBrain,
          error: { _tag: "port_rejected", cause: action.cause },
          at,
        };
        [state, commands] = knob.fail(
          state,
          msg as Parameters<typeof knob.fail>[1],
          at,
        );
        ctx.calls.push("createAgent.fail");
        break;
      }
      case "timer":
        [state, commands] = knob.onTimer(state, {
          type: "deadline_exceeded",
          id: z.string().parse(action.id),
          atMs: at,
        });
        ctx.calls.push("createAgent.onTimer");
        break;
      case "cancel": {
        const wired = knob.toMachine({
          toolInterpret: {
            invoice_tool: async () => [],
            compact_run: async () => [],
          },
        });
        const cell = Reflect.get(wired.machine.update, "agent_cancel");
        assert.equal(typeof cell, "function");
        [state, commands] = Reflect.apply(cell, undefined, [
          state,
          agentCancelMsg(at),
        ]);
        ctx.calls.push("createAgent.toMachine.update.agent_cancel");
        break;
      }
      case "boot":
        [state, commands] = knob.boot(state, at);
        ctx.calls.push("createAgent.boot");
        break;
      case "roundTrip":
        state = normalized(state);
        break;
      default:
        throw new Error(`unknown action ${String(action.op)}`);
    }
    const subs = knob.subs(state);
    ctx.calls.push("createAgent.subs");
    frames.push(normalized({ state, cmds: commands, subs, log: ctx.log }));
    for (const command of commands)
      if (command.type === "resilient_run") lastBrain = command;
  }
  const call = state.compaction.calls.$compact;
  const summarySame =
    ctx.summary === null ||
    (call?.phase === "succeeded" && call.result.output === ctx.summary);
  return {
    id: input.id,
    view: { frames, laws: { payloadSame: ctx.payloadSame, summarySame } },
    observedCalls: ctx.calls,
  };
}
async function settle<A, E>(effect: Effect.Effect<A, E>) {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}
async function runtime(input: Input) {
  assert.ok(input.path);
  const directory = input.path;
  await mkdir(directory, { recursive: true });
  if (input.mode !== "reader")
    await writeFile(
      path.join(directory, "invoice.json"),
      JSON.stringify({ id: "inv-17", lines: [4.5, 10.5], total: 15 }),
    );
  const ctx = shared(),
    trace: unknown[] = [],
    timerLog: unknown[] = [];
  let now = input.mode === "reader" ? 57.25 : 17.25,
    models = 0,
    tools = 0,
    compacts = 0,
    loaded: State | null | undefined,
    cause: unknown,
    causeSame = true,
    guardErrors = 0,
    guardChecks = 0;
  const entered = deferred();
  let deadline = deferred();
  const scenario = input.scenario ?? "normal";
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
  const tool = async (command: Tool) => {
    tools++;
    trace.push(["tool", command.call.name]);
    const invoice = JSON.parse(
      await readFile(path.join(directory, "invoice.json"), "utf8"),
    );
    let result = invoice;
    if (command.call.name !== "collect") {
      assert.equal(command.call.name, "check");
      const sum = invoice.lines.reduce((a: number, b: number) => a + b, 0);
      assert.equal(sum, invoice.total);
      result = { valid: true, total: sum };
      await writeFile(
        path.join(directory, "validated.json"),
        JSON.stringify(result),
      );
    }
    return [
      {
        type: "agent_tool_ok" as const,
        callId: command.call.callId,
        result,
        at: now,
      },
    ];
  };
  const compact = async (
    command: AgentCompactRunCmd,
  ): Promise<readonly Msg[]> => {
    const n = compacts++;
    trace.push(["compact", normalized(command.input)]);
    if (input.mode === "writer") {
      entered.resolve();
      await new Promise(() => {});
    }
    if (scenario.startsWith("cancel")) return [];
    const raw =
      scenario === "exhaust" || (scenario === "retry" && n === 0)
        ? { summary: 7, unknownSummary: { kept: true } }
        : {
            summary: "invoice inv-17 total=15 checked",
            unknownSummary: { kept: true },
          };
    try {
      const output = compactionSummarySchema.parse(raw);
      assert.equal(output, raw);
      ctx.summary = output;
      return [
        {
          type: "compact_ok",
          key: command.key,
          result: { key: command.key, purpose: "$compact", output },
          at: now,
        },
      ];
    } catch (error) {
      guardErrors++;
      cause = error;
      const description =
        error instanceof Error ? error.message : String(error);
      return [
        {
          type: "compact_err",
          key: command.key,
          error: {
            key: command.key,
            purpose: "$compact",
            reason: description,
            error,
          },
          at: now,
        },
      ];
    }
  };
  const rows: { at: number; callback: (() => void) | null }[] = [];
  const runner = subscribeWith((_, at, msg, dispatch) => {
    const row: { at: number; callback: (() => void) | null } = {
      at,
      callback: () => dispatch(msg),
    };
    rows.push(row);
    timerLog.push(["arm", at]);
    return () => {
      row.callback = null;
      timerLog.push(["cancel", at]);
    };
  });
  const fire = () => {
    const row = rows.filter((r) => r.callback).sort((a, b) => a.at - b.at)[0];
    if (!row) return false;
    const call = row.callback;
    row.callback = null;
    now = row.at;
    timerLog.push(["fire", now]);
    call?.();
    return true;
  };
  const store = fileStore<State>(
    path.join(directory, "state.json"),
    (value) => {
      loaded = value as State;
      return loaded;
    },
  );
  const loadMessages = async (call: unknown) => {
    const request = call as Request;
    trace.push([
      "load",
      request.payload.conversation.turns.length,
      request.payload.conversation.turns[0] ?? null,
    ]);
    return [];
  };
  const actual = createAgent<null, "invoice", Outputs, unknown, Tool, unknown>({
    stages: [null],
    turnOf: () => "invoice",
    toolOf: (call) => ({ type: "invoice_tool", call }),
    payloadOf: (_, conversation) => ({ conversation }),
    schemas: { invoice: agentTurnSchema },
    loadMessages,
    model: factory(async () => {
      models++;
      trace.push(["model", "invoice"]);
      return turn(
        input.mode === "reader" || models > 2
          ? "done"
          : models === 1
            ? "collect"
            : "check",
      );
    }),
    compaction: {
      planCompaction: (conversation) => {
        ctx.log.push([
          "plan",
          conversation.turns.length,
          conversation.turnCount,
        ]);
        ctx.planOwner = conversation;
        return conversation.turns.length >= input.config.threshold
          ? typeof input.config.folding === "number"
            ? input.config.folding
            : Number(input.config.folding)
          : 0;
      },
      payloadOf: (conversation, folding) => {
        if (
          conversation.awaiting.kind !== "compacting" &&
          ctx.planOwner !== null
        )
          ctx.payloadSame &&= conversation === ctx.planOwner;
        ctx.log.push(["payload", conversation.turns.length, folding]);
        return input.config.payload ? { conversation, folding } : null;
      },
    },
    rng: () => {
      const value = input.config.rng[ctx.rngIndex++ % input.config.rng.length];
      assert.notEqual(value, undefined);
      ctx.log.push(["rng", value]);
      return value;
    },
    ...(input.config.retry === undefined
      ? {}
      : {
          retry: {
            baseMs: 10,
            factor: 2,
            capMs: 1000,
            jitter: "full",
            maxAttempts: input.config.retry,
          },
        }),
    ...(input.config.maxTurns === undefined
      ? {}
      : { maxTurns: input.config.maxTurns }),
  });
  const liveWired = actual.toMachine({
    toolInterpret: { invoice_tool: tool, compact_run: compact },
  });
  ctx.calls.push("createAgent.toMachine");
  let getState!: () => State,
    dispatch!: (m: Msg) => Promise<unknown>,
    idle!: () => Promise<unknown>,
    done!: () => Promise<State>,
    result!: () => State | undefined,
    stop!: () => Promise<void>;
  const committed = (msg: Msg, state: State) => {
    trace.push(["commit", msg.type, state.conversation?.awaiting ?? null]);
    if (msg.type === "compact_err" && cause !== undefined) {
      const expectedCause = cause;
      cause = undefined;
      guardChecks++;
      causeSame &&= msg.error.error === expectedCause;
    }
    if (msg.type === "deadline_exceeded") deadline.resolve();
  };
  if (input.profile === "effect") {
    const scope = await Effect.runPromise(Scope.make());
    const live = await Effect.runPromise(
      Scope.provide(scope)(
        runEffect(liveWired.machine, {
          ctx: {},
          store,
          clock: () => now,
          terminal: actual.isSettled,
          interpret: {
            resilient_run: (cmd) =>
              Effect.promise(() =>
                liveWired.interpret.resilient_run(cmd, {
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
            invoice_tool: (cmd) =>
              Effect.tryPromise({ try: () => tool(cmd), catch: (e) => e }),
            compact_run: (cmd) =>
              Effect.tryPromise({ try: () => compact(cmd), catch: (e) => e }),
          },
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
    const runtime = await settle(live.ready);
    runtime.observe(committed);
    getState = runtime.getState;
    dispatch = (msg) => settle(runtime.dispatch(msg));
    idle = () => settle(runtime.idle());
    done = () => settle(runtime.done());
    result = runtime.result;
    stop = () => Effect.runPromise(Scope.close(scope, Exit.void));
    ctx.calls.push("effect.run.ready");
  } else {
    const runtime = await runPromise(liveWired.machine, {
      ctx: {},
      store,
      clock: () => now,
      terminal: actual.isSettled,
      interpret: liveWired.interpret,
      subscribe: { deadline: runner },
    }).ready;
    runtime.observe(committed);
    getState = runtime.getState;
    dispatch = runtime.dispatch;
    idle = () => runtime.idle();
    done = () => runtime.done();
    result = runtime.result;
    stop = () => runtime.stop();
    ctx.calls.push("promise.run.ready");
  }
  const ready = normalized(getState()),
    readyCounts = [models, tools, compacts],
    readySame = loaded == null || getState() === loaded;
  const message: Msg =
    input.mode === "reader"
      ? agentBootMsg(now)
      : { type: "agent_start", runId: "invoice-run", at: now };
  if (input.mode === "writer") {
    void dispatch(message);
    await entered.promise;
    const checkpointBytes = await readFile(
      path.join(directory, "state.json"),
      "utf8",
    );
    return {
      id: input.id,
      view: normalized({
        ready,
        readyCounts,
        readySame,
        identityDomains: {
          loaded: {
            status: loaded == null ? "not-applicable" : "tracked",
            checks: loaded == null ? 0 : 1,
          },
          guard: {
            status: guardErrors > 0 ? "tracked" : "not-applicable",
            errors: guardErrors,
            checks: guardChecks,
          },
        },
        checkpoint: JSON.parse(checkpointBytes),
        trace,
        timerLog,
        counts: [models, tools, compacts],
        policyLog: ctx.log,
      }),
      checkpointBytes,
      observedCalls: ctx.calls,
    };
  }
  await dispatch(message);
  ctx.calls.push("runtime.dispatch");
  if (scenario.startsWith("cancel")) {
    await dispatch(agentCancelMsg(now));
    const message: Msg =
      scenario === "cancel-late-error"
        ? {
            type: "compact_err",
            key: "$compact",
            error: {
              key: "$compact",
              purpose: "$compact",
              reason: "late",
              error: { late: true },
            },
            at: now,
          }
        : {
            type: "compact_ok",
            key: "$compact",
            result: {
              key: "$compact",
              purpose: "$compact",
              output: { summary: "late" },
            },
            at: now,
          };
    await dispatch(message);
  }
  for (let i = 0; i < 5 && !actual.isSettled(getState()); i++) {
    deadline = deferred();
    if (!fire()) break;
    await deadline.promise;
    await idle();
  }
  const final = getState();
  const doneSame =
    actual.isSettled(final) && (await done()) === final && result() === final;
  await stop();
  const checkpointBytes = await readFile(
    path.join(directory, "state.json"),
    "utf8",
  );
  const call = final.compaction.calls.$compact;
  const summarySame =
    ctx.summary === null ||
    (call?.phase === "succeeded" && call.result.output === ctx.summary);
  return {
    id: input.id,
    view: normalized({
      ready,
      readyCounts,
      readySame,
      identityDomains: {
        loaded: {
          status: loaded == null ? "not-applicable" : "tracked",
          checks: loaded == null ? 0 : 1,
        },
        guard: {
          status: guardErrors > 0 ? "tracked" : "not-applicable",
          errors: guardErrors,
          checks: guardChecks,
        },
      },
      state: final,
      checkpoint: JSON.parse(checkpointBytes),
      trace,
      timerLog,
      counts: [models, tools, compacts],
      policyLog: ctx.log,
      doneSame,
      payloadSame: ctx.payloadSame,
      summarySame,
      causeSame,
    }),
    checkpointBytes,
    observedCalls: ctx.calls,
  };
}
for await (const text of createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})) {
  const input = inputSchema.parse(JSON.parse(text));
  const output = input.mode === "pure" ? pure(input) : await runtime(input);
  console.log(JSON.stringify(output));
}
