import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
import { run as runEffect } from "../../packages/tea/src/effect/index.ts";
import { Outcome, refuse } from "../../packages/tea/src/index.ts";
import type {
  LlmCall,
  Schema,
} from "../../packages/tea/src/internal/llm-call/index.ts";
import { subscribeWith } from "../../packages/tea/src/internal/resilience/deadline/index.ts";
import { fileStore } from "../../packages/tea/src/node/index.ts";
import { run as runPromise } from "../../packages/tea/src/promise/index.ts";

const request = z.strictObject({
  id: z.string(),
  profile: z.enum(["promise", "effect"]),
  mode: z.enum(["writer", "reader"]),
  checkpoint: z.enum([
    "brain",
    "tools",
    "tool-error",
    "done",
    "model-error",
    "guard-error",
  ]),
  directory: z.string(),
});
type Input = z.infer<typeof request>;
type Purpose = "collect" | "check" | "summarize";
type Outputs = Record<Purpose, AgentTurn>;
type ResultValue = { readonly value: number };
type State = AgentState<Purpose, Purpose, Outputs, ResultValue>;
type Msg = AgentMachineMsg<Purpose, Outputs, ResultValue>;
type Cmd = { readonly type: "invoice_tool"; readonly call: ToolCall };
type Message = { readonly call: LlmCall<Purpose> };
const invoiceSchema = z.strictObject({
  invoiceId: z.literal("inv-17"),
  lines: z.array(z.number()),
  total: z.number(),
});
function object(value: unknown): value is object {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
// Caller-owned same-version checkpoint carrier check, not a general AgentState schema.
const stateBoundary = z.custom<State>((value) => {
  if (!object(value)) return false;
  const run = Reflect.get(value, "run"),
    tools = Reflect.get(value, "tools"),
    resilience = Reflect.get(value, "resilience"),
    conversation = Reflect.get(value, "conversation");
  return (
    object(run) &&
    typeof Reflect.get(run, "phase") === "string" &&
    object(tools) &&
    Array.isArray(Reflect.get(tools, "running")) &&
    object(resilience) &&
    object(Reflect.get(resilience, "calls")) &&
    (conversation === null || object(conversation))
  );
});
function wire(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}
async function settle<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}
async function execute(input: Input) {
  if (input.mode === "writer") {
    await mkdir(input.directory, { recursive: true });
    await writeFile(
      path.join(input.directory, "invoice.json"),
      JSON.stringify({
        invoiceId: "inv-17",
        lines: [4.5, 10.5],
        total: input.checkpoint === "tool-error" ? 16 : 15,
      }),
    );
  }
  const now = input.mode === "writer" ? 17.25 : 50;
  let modelCalls = 0,
    toolCalls = 0,
    schemaSame = true,
    validated = true,
    cut = false,
    loaded: State | null = null,
    saved: State | null = null;
  let decoded: WeakRef<ToolCall> | null = null,
    decodedCommandSame: boolean | null = null,
    decodedRecordSame: boolean | null = null;
  const trace: string[] = [],
    reports: unknown[] = [],
    diagnostics: unknown[] = [],
    timers: unknown[] = [],
    guardErrors: unknown[] = [],
    requests: LlmCall<Purpose>[] = [];
  const originalCause = new Error("invoice model rejected"),
    crash = new Error("persisted-before-effect");
  const stage = (s: State) => agent.currentStage(s) ?? "-";
  function inspect(s: State) {
    const expected = decoded?.deref();
    if (expected && s.conversation)
      for (const record of s.conversation.toolRecords)
        if (record.call.callId === expected.callId)
          decodedRecordSame = record.call === expected;
  }
  function causeView(s: State) {
    if (s.failure?.reason !== "llm") return null;
    const error: unknown = s.failure.error;
    assert.ok(object(error));
    const cause: unknown = Reflect.get(error, "error"),
      reason: unknown = Reflect.get(error, "reason");
    assert.equal(typeof reason, "string");
    const kind =
      cause === originalCause
        ? "live-model"
        : guardErrors.includes(cause)
          ? "live-guard"
          : "plain-data";
    return {
      kind,
      originalSame: cause === originalCause || guardErrors.includes(cause),
      value: wire(cause),
      reason,
    };
  }
  function parse(p: Purpose): Schema<AgentTurn> {
    return {
      parse(value: unknown) {
        trace.push(`parse:${p}`);
        try {
          return agentTurnSchema.parse(value);
        } catch (e) {
          guardErrors.push(e);
          throw e;
        }
      },
    };
  }
  const schemas = {
    collect: parse("collect"),
    check: parse("check"),
    summarize: parse("summarize"),
  };
  function records(call: LlmCall<Purpose>) {
    assert.ok(object(call.payload));
    const history = Reflect.get(call.payload, "conversation");
    assert.ok(object(history));
    const values: unknown = Reflect.get(history, "toolRecords");
    assert.ok(Array.isArray(values));
    return values;
  }
  function prepare(call: LlmCall<Purpose>): unknown {
    const history = records(call),
      count = history.length,
      p = call.purpose;
    if (
      history.some(
        (r) =>
          object(r) &&
          object(Reflect.get(r, "outcome")) &&
          Reflect.get(Reflect.get(r, "outcome"), "kind") === "error",
      )
    )
      validated = false;
    const ordinal = p === "collect" ? 1 + count : p === "check" ? 3 + count : 5;
    const args = {
      file: "invoice.json",
      unknownArg: "kept",
      unknownUndefined: undefined,
    };
    Object.defineProperty(args, "__proto__", {
      value: { args: true },
      enumerable: true,
    });
    const calls =
      p !== "summarize" && count === 0
        ? [
            {
              callId: `${p}-17`,
              name: p,
              args,
              unknownCall: { ordinal },
              unknownUndefined: undefined,
            },
          ]
        : [];
    return {
      content:
        input.checkpoint === "guard-error"
          ? 0
          : p === "summarize"
            ? validated
              ? "Invoice total confirmed: 15"
              : "Invoice requires review"
            : p,
      toolCalls: calls,
      unknownTurn: ordinal,
      unknownUndefined: undefined,
      provider: { opaque: "kept" },
    };
  }
  async function tool(cmd: Cmd): Promise<readonly Msg[]> {
    const expected = decoded?.deref();
    if (expected?.callId === cmd.call.callId)
      decodedCommandSame = cmd.call === expected;
    toolCalls++;
    trace.push(`tool:${cmd.call.name}`);
    assert.equal(
      cmd.call.args.unknownArg,
      "kept",
      "decoded args retain unknown field",
    );
    const file: unknown = cmd.call.args.file;
    assert.ok(typeof file === "string");
    const invoice = invoiceSchema.parse(
        JSON.parse(await readFile(path.join(input.directory, file), "utf8")),
      ),
      sum = invoice.lines.reduce((a, b) => a + b, 0);
    if (sum !== invoice.total) {
      validated = false;
      return [
        {
          type: "agent_tool_err",
          callId: cmd.call.callId,
          reason: "invoice total mismatch",
          at: now,
        },
      ];
    }
    return [
      {
        type: "agent_tool_ok",
        callId: cmd.call.callId,
        result: { value: sum },
        at: now,
      },
    ];
  }
  const agent = createAgent<
    Purpose,
    Purpose,
    Outputs,
    ResultValue,
    Cmd,
    Message
  >({
    stages: ["collect", "check", "summarize"],
    schemas,
    turnOf: (s) => s ?? "collect",
    toolOf: (call) => ({ type: "invoice_tool", call }),
    payloadOf: (_, conversation) => ({ conversation }),
    deadlineMs: 100,
    rng: () => 0,
    loadMessages: async (call) => {
      trace.push(`load:${call.purpose}`);
      requests.push(call);
      return [{ call }];
    },
    model: () => {
      trace.push("factory");
      return {
        withStructuredOutput<T>(schema: Schema<T>) {
          const call = requests.at(-1);
          assert.ok(call);
          schemaSame &&= schema === schemas[call.purpose];
          trace.push(`bind:${call.purpose}`);
          return {
            async invoke(messages: readonly Message[]) {
              assert.equal(messages[0]?.call, call);
              modelCalls++;
              trace.push(`model:${call.purpose}`);
              if (input.checkpoint === "model-error") throw originalCause;
              return schema.parse(prepare(call));
            },
          };
        },
      };
    },
  });
  const base = fileStore<State>(
    path.join(input.directory, "state.json"),
    (raw) => {
      if (raw === null) return null;
      const result = stateBoundary.safeParse(raw);
      if (!result.success) return refuse(result.error.message);
      loaded = result.data;
      return result.data;
    },
  );
  const store = {
    load: () => base.load(),
    migrate: (raw: unknown) => base.migrate(raw),
    async save(s: State) {
      trace.push(`save:${s.run.phase}:${stage(s)}`);
      await base.save(s);
      saved = s;
      const first = stage(s) === "collect",
        target =
          input.mode === "writer" &&
          first &&
          (input.checkpoint === "brain"
            ? s.conversation?.awaiting.kind === "llm" && modelCalls === 0
            : input.checkpoint === "tools"
              ? s.conversation?.awaiting.kind === "tools"
              : input.checkpoint === "tool-error"
                ? s.conversation?.awaiting.kind === "llm" &&
                  (s.conversation?.toolRecords.length ?? 0) > 0
                : false);
      if (target && !cut) {
        cut = true;
        trace.push("crash-window");
        throw crash;
      }
    },
  };
  function failure(e: unknown): string {
    if (e === crash) return "save";
    if (object(e)) {
      const nested = Reflect.get(e, "cause");
      if (nested !== undefined && nested !== e) return failure(nested);
      const name = Reflect.get(e, "name");
      if (typeof name === "string") return name;
    }
    return String(e);
  }
  const onError = (e: unknown, p: { phase: string }) => {
    reports.push([p.phase, failure(e)]);
    diagnostics.push(
      e instanceof Error
        ? { name: e.name, message: e.message, stack: e.stack }
        : String(e),
    );
  };
  const rows: { at: number; active: boolean }[] = [];
  const runner = subscribeWith((_, at) => {
    const row = { at: now + Math.max(0, at - now), active: true };
    rows.push(row);
    timers.push(["arm", row.at]);
    return () => {
      row.active = false;
      timers.push(["cancel", row.at]);
    };
  });
  const wired = agent.toMachine<object>({
    toolInterpret: { invoice_tool: tool },
  });
  let getState: () => State,
    dispatch: (m: Msg) => Promise<void>,
    done: () => Promise<State>,
    stop: () => Promise<void>;
  const committed = (m: Msg, s: State) => {
    inspect(s);
    trace.push(`commit:${m.type}:${s.run.phase}:${stage(s)}`);
  };
  const booted = (s: State) => {
    inspect(s);
    trace.push(`commit:boot:${s.run.phase}:${stage(s)}`);
  };
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
    live.onBoot(booted);
    live.observe(committed);
    const run = await live.ready;
    getState = run.getState;
    dispatch = (m) => run.dispatch(m);
    done = () => run.done();
    stop = () => run.stop();
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
    live.onBoot(booted);
    live.observe(committed);
    const run = await settle(live.ready);
    getState = run.getState;
    dispatch = (m) => settle(run.dispatch(m));
    done = () => settle(run.done());
    stop = () => Effect.runPromise(Scope.close(scope, Exit.void));
  }
  const ready = getState();
  if (input.mode === "reader" && ready.tools.running[0])
    decoded = new WeakRef(ready.tools.running[0]);
  const readyView = {
    loadedSame: input.mode === "reader" ? ready === loaded : null,
    modelCalls,
    toolCalls,
    wire: wire(ready),
    cause: causeView(ready),
  };
  let dispatchFailure: string | null = null;
  await dispatch(
    input.mode === "writer"
      ? { type: "agent_start", runId: "invoice-17", at: 0 }
      : agentBootMsg(now),
  ).catch((e) => {
    dispatchFailure = failure(e);
  });
  const state = getState(),
    cause = causeView(state),
    settled = agent.isSettled(state);
  if (settled) await done();
  await stop();
  const bytes = await readFile(
    path.join(input.directory, "state.json"),
    "utf8",
  );
  return {
    id: input.id,
    view: {
      ready: readyView,
      wire: JSON.parse(bytes),
      modelCalls,
      toolCalls,
      settled,
      savedSame: state === saved,
      cause,
      schemaSame,
      dispatchFailure,
      cut,
      decodedCommandSame,
      decodedRecordSame,
      trace,
      reports,
      timers,
    },
    wireText: bytes,
    diagnostics,
  };
}
let text = "";
for await (const chunk of process.stdin) text += chunk;
console.log(JSON.stringify(await execute(request.parse(JSON.parse(text)))));
