import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Cause, Effect, Exit, Queue, Scope, Stream } from "effect";
import { z } from "zod";
import {
  type AgentMachineMsg,
  type AgentState,
  type AgentTurn,
  agentBootMsg,
  agentTurnSchema,
  createAgent,
  type ToolCall,
} from "../../packages/tea/src/agent/index.ts";
import { describeError } from "../../packages/tea/src/describe-error.ts";
import { run as runEffect } from "../../packages/tea/src/effect/index.ts";
import { Outcome, refuse } from "../../packages/tea/src/index.ts";
import type { Schema } from "../../packages/tea/src/internal/llm-call/index.ts";
import { subscribeWith } from "../../packages/tea/src/internal/resilience/deadline/index.ts";
import { fileStore } from "../../packages/tea/src/node/index.ts";
import { run as runPromise } from "../../packages/tea/src/promise/index.ts";

const request = z.strictObject({
  id: z.string(),
  profile: z.enum(["promise", "effect"]),
  mode: z.enum(["writer", "reader"]),
  checkpoint: z.enum(["brain", "tools", "guard-error"]),
  directory: z.string(),
});
type Outputs = { invoice: AgentTurn };
type State = AgentState<"invoice", "invoice", Outputs, number>;
type Msg = AgentMachineMsg<"invoice", Outputs, number>;
type Cmd = { readonly type: "invoice_tool"; readonly call: ToolCall };
function object(x: unknown): x is object {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}
const boundary = z.custom<State>(
  (x) =>
    object(x) &&
    object(Reflect.get(x, "run")) &&
    object(Reflect.get(x, "tools")) &&
    object(Reflect.get(x, "resilience")),
);
async function settle<A, E>(effect: Effect.Effect<A, E>) {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}
async function execute(input: z.infer<typeof request>) {
  let modelCalls = 0,
    toolCalls = 0,
    cut = false,
    loaded: State | null = null,
    decoded: WeakRef<ToolCall> | null = null,
    decodedCommandSame: boolean | null = null,
    decodedRecordSame: boolean | null = null;
  const now = input.mode === "writer" ? 17.25 : 50,
    crash = new Error("persisted-before-effect"),
    diagnostics: unknown[] = [],
    reports: unknown[] = [];
  const invoice = path.join(input.directory, "invoice.json");
  if (input.mode === "writer")
    await writeFile(invoice, JSON.stringify({ lines: [7, 8], total: 15 }));
  function raw() {
    const ordinal = modelCalls++;
    if (input.checkpoint === "guard-error") return null;
    if (
      ordinal === 0 &&
      !(input.mode === "reader" && input.checkpoint === "tools")
    )
      return {
        content: "collect/check",
        toolCalls: [
          {
            callId: "invoice-1",
            name: "collect",
            args: { path: invoice, unknownArg: "kept" },
            unknownCall: { kept: true },
          },
        ],
        unknownTurn: "kept",
        provider: { opaque: true },
      };
    return {
      content: "Invoice total confirmed: 15",
      toolCalls: [],
      unknownFinal: "kept",
    };
  }
  async function tool(cmd: Cmd): Promise<readonly Msg[]> {
    const previous = decoded?.deref();
    if (previous) decodedCommandSame = previous === cmd.call;
    const f: unknown = cmd.call.args.path;
    assert.equal(typeof f, "string");
    if (typeof f !== "string") throw new Error("invoice path");
    const data = z
      .strictObject({ lines: z.array(z.number()), total: z.number() })
      .parse(JSON.parse(await readFile(f, "utf8")));
    const total = data.lines.reduce((a, b) => a + b, 0);
    assert.equal(total, data.total, "real invoice validator");
    toolCalls++;
    return [
      {
        type: "agent_tool_ok",
        callId: cmd.call.callId,
        result: total,
        at: 17.25,
      },
    ];
  }
  const agent = createAgent<"invoice", "invoice", Outputs, number, Cmd>({
    stages: ["invoice"],
    schemas: { invoice: agentTurnSchema },
    turnOf: () => "invoice",
    toolOf: (call) => ({ type: "invoice_tool", call }),
    payloadOf: () => null,
    model: () => ({
      withStructuredOutput<T>(schema: Schema<T>) {
        assert.equal(schema, agentTurnSchema);
        return { invoke: async () => schema.parse(raw()) };
      },
    }),
  });
  const base = fileStore<State>(
    path.join(input.directory, "state.json"),
    (raw) => {
      if (raw === null) return null;
      const value = boundary.safeParse(raw);
      if (value.success) {
        loaded = value.data;
        return value.data;
      }
      return refuse(value.error.message);
    },
  );
  const store = {
    ...base,
    async save(state: State) {
      await base.save(state);
      const target =
        input.mode === "writer" &&
        (input.checkpoint === "brain"
          ? state.conversation?.awaiting.kind === "llm" && modelCalls === 0
          : input.checkpoint === "tools"
            ? state.tools.running.length > 0
            : false);
      if (target && !cut) {
        cut = true;
        throw crash;
      }
    },
  };
  function failure(e: unknown): string {
    if (e === crash) return "save";
    if (object(e)) {
      const cause = Reflect.get(e, "cause");
      if (cause !== undefined && cause !== e) return failure(cause);
      const name = Reflect.get(e, "name");
      if (typeof name === "string") return name;
    }
    return String(e);
  }
  function cause(state: State) {
    if (state.failure?.reason !== "llm") return null;
    const error = state.failure.error;
    assert.ok(object(error));
    const value = Reflect.get(error, "error"),
      reason = Reflect.get(error, "reason");
    assert.equal(typeof reason, "string");
    return {
      kind: value instanceof Error ? "live" : "plain",
      description: describeError(value),
      reason,
    };
  }
  const inspect = (_: unknown, state: State) => {
    const call = decoded?.deref();
    if (call && state.conversation)
      for (const record of state.conversation.toolRecords)
        decodedRecordSame = record.call === call;
  };
  const onError = (e: unknown, p: { phase: string }) => {
    reports.push([failure(e), p.phase]);
    diagnostics.push(
      e instanceof Error
        ? { name: e.name, message: e.message, stack: e.stack }
        : String(e),
    );
  };
  const runner = subscribeWith(() => () => {}),
    wired = agent.toMachine<object>({ toolInterpret: { invoice_tool: tool } });
  let getState: () => State,
    dispatch: (m: Msg) => Promise<void>,
    done: () => Promise<State>,
    stop: () => Promise<void>;
  if (input.profile === "promise") {
    const live = runPromise(wired.machine, {
      ctx: {},
      store,
      clock: () => now,
      terminal: agent.isSettled,
      onError,
      interpret: wired.interpret,
      subscribe: { deadline: runner },
    });
    live.observe(inspect);
    const run = await live.ready;
    getState = run.getState;
    dispatch = run.dispatch;
    done = run.done;
    stop = run.stop;
  } else {
    const scope = await Effect.runPromise(Scope.make());
    const live = await Effect.runPromise(
      Scope.provide(scope)(
        runEffect(wired.machine, {
          ctx: {},
          store,
          clock: () => now,
          terminal: agent.isSettled,
          onError,
          interpret: {
            resilient_run: (cmd) =>
              Effect.promise(() =>
                wired.interpret.resilient_run(cmd, {
                  ok: Outcome.ok,
                  err: Outcome.err,
                  emit() {
                    throw new Error("unexpected brain port");
                  },
                }),
              ).pipe(
                Effect.flatMap((outcome) =>
                  outcome
                    ? outcome._tag === "Ok"
                      ? Effect.succeed(outcome.value)
                      : Effect.fail(outcome.error)
                    : Effect.succeed(undefined),
                ),
              ),
            invoice_tool: (cmd) =>
              Effect.tryPromise({ try: () => tool(cmd), catch: (e) => e }),
          },
          subscribe: {
            deadline: (sub) => {
              const queue = Effect.runSync(Queue.unbounded<Msg>());
              const cancel = runner(sub, {}, (m) =>
                Queue.offerUnsafe(queue, m),
              );
              return Stream.fromQueue(queue).pipe(
                Stream.ensuring(Effect.sync(cancel)),
              );
            },
          },
        }),
      ),
    );
    live.observe(inspect);
    const run = await settle(live.ready);
    getState = run.getState;
    dispatch = (m) => settle(run.dispatch(m));
    done = () => settle(run.done());
    stop = () => Effect.runPromise(Scope.close(scope, Exit.void));
  }
  const ready = getState(),
    readyView = {
      modelCalls,
      toolCalls,
      loadedSame: input.mode === "reader" ? ready === loaded : null,
      wire: JSON.parse(JSON.stringify(ready)),
      cause: cause(ready),
    };
  if (ready.tools.running[0]) decoded = new WeakRef(ready.tools.running[0]);
  let dispatchFailure: string | null = null;
  await dispatch(
    input.mode === "writer"
      ? { type: "agent_start", runId: "default-invoice", at: 0 }
      : agentBootMsg(50),
  ).catch((e) => {
    dispatchFailure = failure(e);
  });
  const state = getState();
  if (agent.isSettled(state)) await done();
  await stop();
  const wireText = await readFile(
    path.join(input.directory, "state.json"),
    "utf8",
  );
  return {
    id: input.id,
    view: {
      ready: readyView,
      wire: JSON.parse(wireText),
      modelCalls,
      toolCalls,
      settled: agent.isSettled(state),
      cause: cause(state),
      cut,
      dispatchFailure,
      decodedCommandSame,
      decodedRecordSame,
      reports,
    },
    wireText,
    diagnostics,
  };
}
let text = "";
for await (const chunk of process.stdin) text += chunk;
console.log(JSON.stringify(await execute(request.parse(JSON.parse(text)))));
