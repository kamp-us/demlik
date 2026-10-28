import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { Cause, Effect, Exit, Queue, Scope, Stream } from "effect";
import { z } from "zod";
import {
  type AgentMachineMsg,
  type AgentTurn,
  agentBootMsg,
  agentCancelMsg,
  createAgent,
  isAgentTurn,
  type ToolCall,
  type ToolCmd,
  type ToolMsg,
  type ToolResult,
  tool,
  toolRouter,
} from "../../packages/tea/src/agent/index.ts";
import { run as runEffect } from "../../packages/tea/src/effect/index.ts";
import {
  definePort,
  Outcome,
  type Port,
  refuse,
} from "../../packages/tea/src/index.ts";
import type {
  LlmCall,
  Schema,
} from "../../packages/tea/src/internal/llm-call/index.ts";
import { subscribeWith } from "../../packages/tea/src/internal/resilience/deadline/index.ts";
import { memoryStore } from "../../packages/tea/src/mem/index.ts";
import { fileStore } from "../../packages/tea/src/node/index.ts";
import { run as runPromise } from "../../packages/tea/src/promise/index.ts";

const request = z.strictObject({
  id: z.string(),
  profile: z.enum(["promise", "effect"]),
  scenario: z.enum([
    "invoice",
    "declared",
    "thrown",
    "rejected",
    "malformed-args",
    "bad-result",
    "selected-B",
    "cold-pending",
    "cancel-late",
    "map-refusal",
  ]),
  directory: z.string(),
  mode: z.enum(["writer", "reader"]).optional(),
});
type Input = z.infer<typeof request>;
type Args = { invoice: string };
type Result = { total: number };
type Host = { directory: string };
type Message = { call: LlmCall<"invoice"> };
const port = definePort<{ name: string; inputSame: boolean }>(
  "agent-routed-invoice-01a16c9d",
);
const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function args(value: unknown): value is Args {
  return record(value) && value.invoice === "inv-17";
}
function result(value: unknown): value is Result {
  return record(value) && typeof value.total === "number" && value.total >= 0;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function settle<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}
async function execute(input: Input) {
  await mkdir(input.directory, { recursive: true });
  if (input.mode !== "reader")
    await writeFile(
      path.join(input.directory, "invoice.json"),
      JSON.stringify({ lines: [4.5, 10.5], total: 15 }),
    );
  let now = input.mode === "reader" ? 50 : 17.25,
    modelCalls = 0,
    toolCalls = 0,
    maps = 0,
    cut = false;
  const trace: unknown[] = [],
    ports: unknown[] = [],
    commits: unknown[] = [],
    saves: unknown[] = [],
    reports: unknown[] = [],
    diagnostics: unknown[] = [],
    rejections: unknown[] = [];
  const requests: LlmCall<"invoice">[] = [],
    returned: object[] = [],
    callOwners = new Map<string, ToolCall>();
  const entered = deferred(),
    release = deferred(),
    crash = new Error("persisted-before-tool");
  const mapCause = new Error(
    'tool: "map_fault" is reserved — it is an agent-owned Msg prefix',
  );
  const inputSchema = z.custom<Args>(args, { message: "Invalid invoice args" });
  const make = (group: string) => {
    const outputSchema = z.custom<Result>(
      (value) =>
        result(value) && !(input.scenario === "selected-B" && group === "A"),
      { message: "Invalid invoice result" },
    );
    const read = tool<"read_invoice", Args, Result, readonly ["denied"], Host>(
      "read_invoice",
      {
        description: "Read invoice",
        input: inputSchema,
        ok: outputSchema,
        err: ["denied"],
      },
      async (value, ctx, { ok, fail }) => {
        toolCalls++;
        trace.push(["handler", group, "read", value.invoice]);
        const original = callOwners.get("read")?.args;
        ctx.emit(port, { name: "read", inputSame: original === value });
        if (input.scenario === "cancel-late") {
          entered.resolve();
          await release.promise;
          trace.push(["released", "read"]);
        }
        const invoice = z
          .strictObject({ lines: z.array(z.number()), total: z.number() })
          .parse(
            JSON.parse(
              await readFile(path.join(ctx.directory, "invoice.json"), "utf8"),
            ),
          );
        const total = invoice.lines.reduce((a, b) => a + b, 0);
        assert.equal(total, invoice.total);
        now = 20.5;
        if (input.scenario === "declared")
          return fail({
            _tag: "denied",
            invoice: "inv-17",
            kind: "payload",
            reason: "payload",
          });
        if (input.scenario === "thrown") throw new Error("invoice unavailable");
        const output = { total: input.scenario === "bad-result" ? -1 : total };
        returned.push(output);
        return ok(output);
      },
    );
    const check = tool<
      "check_invoice",
      Args,
      Result,
      readonly ["denied"],
      Host
    >(
      "check_invoice",
      {
        description: "Check invoice",
        input: inputSchema,
        ok: z.custom<Result>(result, { message: "Invalid invoice result" }),
        err: ["denied"],
      },
      async (value, ctx, { ok }) => {
        toolCalls++;
        trace.push(["handler", group, "check", value.invoice]);
        ctx.emit(port, {
          name: "check",
          inputSame: callOwners.get("check")?.args === value,
        });
        const invoice = JSON.parse(
          await readFile(path.join(ctx.directory, "invoice.json"), "utf8"),
        );
        assert.equal(
          invoice.lines.reduce((a: number, b: number) => a + b, 0),
          invoice.total,
        );
        now = 25.75;
        const output = { total: invoice.total };
        returned.push(output);
        return ok(output);
      },
    );
    return { read, check, router: toolRouter([read, check]) };
  };
  const origin = make("A"),
    selected = input.scenario === "selected-B" ? make("B") : origin;
  type Tools = typeof origin.read | typeof origin.check;
  type R = ToolResult<Tools>;
  type Outputs = { invoice: AgentTurn };
  const turnSchema: Schema<AgentTurn> = {
    parse(value) {
      if (!isAgentTurn(value)) throw new Error("bad turn fixture");
      return value;
    },
  };
  const records = (call: LlmCall<"invoice">) => {
    assert.ok(record(call.payload));
    const conversation = call.payload.conversation;
    assert.ok(record(conversation));
    assert.ok(Array.isArray(conversation.toolRecords));
    return conversation.toolRecords;
  };
  const agent = createAgent<
    "invoice",
    "invoice",
    Outputs,
    R,
    ToolCmd<Tools>,
    Message
  >({
    stages: ["invoice"],
    schemas: { invoice: turnSchema },
    turnOf: () => "invoice",
    payloadOf: (_, conversation) => ({ conversation }),
    toolOf: (call) => {
      maps++;
      trace.push(["map", call.callId, call.name]);
      if (input.scenario === "map-refusal" && maps === 2) throw mapCause;
      return origin.router.toolOf(call);
    },
    loadMessages: async (call) => {
      requests.push(call);
      trace.push(["load", records(call).length]);
      return [{ call }];
    },
    model: () => ({
      withStructuredOutput<T>(schema: Schema<T>) {
        assert.equal(schema, turnSchema);
        const call = requests.at(-1);
        assert.ok(call);
        return {
          invoke: async (messages: readonly Message[]) => {
            assert.equal(messages[0]?.call, call);
            const prior = records(call);
            modelCalls++;
            trace.push(["model", prior.length]);
            let calls: ToolCall[] = [];
            if (prior.length < 2) {
              const id = prior.length === 0 ? "read" : "check";
              calls = [
                {
                  callId: id,
                  name:
                    id === "read" && input.scenario === "rejected"
                      ? "missing_tool"
                      : `${id}_invoice`,
                  args:
                    id === "read" && input.scenario === "malformed-args"
                      ? { invoice: 0 }
                      : { invoice: "inv-17", extra: "kept" },
                },
              ];
              for (const c of calls) callOwners.set(c.callId, c);
            } else now = 30.125;
            const raw: AgentTurn = {
              content:
                prior.length < 2
                  ? prior.length === 0
                    ? "collect"
                    : "check"
                  : prior.some(
                        (row) =>
                          record(row) &&
                          record(row.outcome) &&
                          row.outcome.kind === "error",
                      )
                    ? "Invoice requires review"
                    : "Invoice total confirmed: 15",
              toolCalls: calls,
            };
            return schema.parse(raw);
          },
        };
      },
    }),
    rng: () => 0,
  });
  type State = ReturnType<typeof agent.init>;
  type Msg = AgentMachineMsg<"invoice", Outputs, R> | ToolMsg<Tools>;
  let loaded: State | null = null;
  const memory = memoryStore<State>();
  const file = fileStore<State>(
    path.join(input.directory, "state.json"),
    (raw) => {
      if (raw === null) return null;
      if (
        !record(raw) ||
        !record(raw.tools) ||
        !Array.isArray(raw.tools.running) ||
        !Array.isArray(raw.tools.done) ||
        !Array.isArray(raw.tools.failed) ||
        raw.tools.done.length ||
        raw.tools.failed.length ||
        !record(raw.conversation) ||
        !Array.isArray(raw.conversation.toolRecords) ||
        raw.conversation.toolRecords.length
      )
        return refuse("pending-only routed checkpoint");
      const parsed = z
        .custom<State>(
          (value) =>
            record(value) && record(value.run) && record(value.resilience),
        )
        .safeParse(raw);
      if (!parsed.success) return refuse(parsed.error.message);
      loaded = parsed.data;
      for (const call of loaded.tools.running) {
        callOwners.set(call.callId, call);
      }
      return loaded;
    },
  );
  const base = input.scenario === "cold-pending" ? file : memory;
  const store = {
    ...base,
    async save(state: State) {
      saves.push(
        wire({
          phase: state.run.phase,
          awaiting: state.conversation?.awaiting ?? null,
          records: state.conversation?.toolRecords ?? [],
        }),
      );
      await base.save(state);
      if (input.mode === "writer" && !cut && state.tools.running.length) {
        cut = true;
        throw crash;
      }
    },
  };
  const wired = agent.toMachine<Host, Tools>({ tools: selected.router });
  const runner = subscribeWith((_, _at, _msg, _dispatch) => {
    throw new Error("unexpected deadline in no-policy profile");
  });
  const onError = (error: unknown, context: { phase: string }) => {
    reports.push({
      phase: context.phase,
      mapCauseSame: error === mapCause,
      saveCauseSame: error === crash,
    });
    diagnostics.push({
      phase: context.phase,
      error:
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : String(error),
    });
  };
  let getState!: () => State,
    dispatch!: (msg: Msg) => Promise<void>,
    idle!: () => Promise<void>,
    stop!: () => Promise<void>;
  const observed = (message: Msg, state: State) =>
    commits.push(wire({ tag: message.type, message, state }));
  let effectEmit:
    | import("../../packages/tea/src/index.ts").PortEmitter["emit"]
    | undefined;
  const effectHost = {
    directory: input.directory,
    ok: Outcome.ok,
    err: Outcome.err,
    emit<T>(p: Port<T>, value: T) {
      assert.ok(effectEmit);
      effectEmit(p, value);
    },
  };
  const effectOf = <O, E>(work: () => Promise<Outcome<O, E>>) =>
    Effect.promise(work).pipe(
      Effect.flatMap((out) => {
        assert.ok(out, "configured defined handler returned no Outcome");
        return out._tag === "Ok"
          ? Effect.succeed(out.value)
          : Effect.fail(out.error);
      }),
    );
  if (input.profile === "promise") {
    const live = await runPromise(wired.machine, {
      ctx: { directory: input.directory },
      store,
      clock: () => now,
      terminal: agent.isSettled,
      onError,
      interpret: wired.interpret,
      subscribe: { deadline: runner },
    }).ready;
    getState = live.getState;
    dispatch = live.dispatch;
    idle = live.idle;
    stop = live.stop;
    live.observe(observed);
    live.subscribePort(port, (value) => {
      ports.push(value);
      trace.push(["port", value]);
    });
  } else {
    const scope = await Effect.runPromise(Scope.make());
    const live = await Effect.runPromise(
      Scope.provide(scope)(
        runEffect(wired.machine, {
          ctx: { directory: input.directory },
          store,
          clock: () => now,
          terminal: agent.isSettled,
          onError,
          interpret: {
            resilient_run: (cmd) =>
              effectOf(async () => {
                const out = await wired.interpret.resilient_run(
                  cmd,
                  effectHost,
                );
                assert.ok(out);
                return out;
              }),
            read_invoice: (cmd) =>
              effectOf(() => selected.read.interpret(cmd, effectHost)),
            check_invoice: (cmd) =>
              effectOf(() => selected.check.interpret(cmd, effectHost)),
            tool_rejected: (cmd) =>
              effectOf(async () => {
                const out = await selected.router.interpret.tool_rejected(
                  cmd,
                  effectHost,
                );
                assert.ok(out);
                return out;
              }),
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
    const ready = await settle(live.ready);
    effectEmit = ready.emitPort;
    getState = ready.getState;
    dispatch = (msg) => settle(ready.dispatch(msg));
    idle = () => settle(ready.idle());
    stop = () => Effect.runPromise(Scope.close(scope, Exit.void));
    ready.observe(observed);
    ready.subscribePort(port, (value) => {
      ports.push(value);
      trace.push(["port", value]);
    });
  }
  const ready = wire(getState()),
    readyCalls = { model: modelCalls, tools: toolCalls };
  const loadedIdentity =
    loaded === null
      ? { status: "not-applicable", same: null }
      : { status: "tracked", same: getState() === loaded };
  const start: Msg =
    input.mode === "reader"
      ? agentBootMsg(now)
      : { type: "agent_start", runId: "invoice-routed", at: now };
  const dispatchSafe = async (msg: Msg) => {
    try {
      await dispatch(msg);
    } catch (error) {
      rejections.push(
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : String(error),
      );
    }
  };
  if (input.scenario === "cancel-late") {
    const pending = dispatchSafe(start);
    await entered.promise;
    now = 19.5;
    const cancelled = dispatchSafe(agentCancelMsg(now));
    release.resolve();
    await Promise.all([pending, cancelled]);
  } else await dispatchSafe(start);
  await idle();
  const final = wire(getState());
  let checkpoint: string | null = null;
  if (input.scenario === "cold-pending")
    checkpoint = await readFile(
      path.join(input.directory, "state.json"),
      "utf8",
    );
  // Writer intentionally ends its process without stop: preserve the saved crash window.
  if (input.mode !== "writer") await stop();
  return {
    ready,
    readyCalls,
    loadedIdentity,
    final,
    commits,
    trace,
    ports,
    saves,
    modelCalls,
    toolCalls,
    maps,
    reports,
    diagnostics,
    rejections,
    checkpoint,
    stopInvoked: input.mode !== "writer",
    returnedCount: returned.length,
  };
}
for await (const line of createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})) {
  if (!line.trim()) continue;
  const spec = request.parse(JSON.parse(line));
  try {
    console.log(
      JSON.stringify({ id: spec.id, ok: true, view: await execute(spec) }),
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        id: spec.id,
        ok: false,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : String(error),
      }),
    );
  }
}
