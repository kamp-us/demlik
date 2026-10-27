import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { Cause, Effect, Exit, Queue, Scope, Stream } from "effect";
import { z } from "zod";
import {
  type AgentMachineMsg,
  type AgentState,
  type AgentTurn,
  agentBootMsg,
  agentCancelMsg,
  createAgent,
  isAgentTurn,
  type ToolCall,
} from "../../packages/tea/src/agent/index.ts";
import { run as runEffect } from "../../packages/tea/src/effect/index.ts";
import { applyCell, Outcome } from "../../packages/tea/src/index.ts";
import type {
  LlmCall,
  Schema,
} from "../../packages/tea/src/internal/llm-call/index.ts";
import { subscribeWith } from "../../packages/tea/src/internal/resilience/deadline/index.ts";
import { memoryStore } from "../../packages/tea/src/mem/index.ts";
import { run as runPromise } from "../../packages/tea/src/promise/index.ts";

const inputSchema = z
  .object({
    id: z.string().optional(),
    profile: z.enum(["promise", "effect"]),
    scenario: z.enum([
      "stamp-null",
      "stamp-missing",
      "projection-error",
      "normal",
      "duplicate",
      "stale-settlements",
      "fresh-boot",
      "terminal-boot",
      "bad-total",
      "tool-io-error",
      "model-error",
      "parse-error",
      "retry-once",
      "retry-exhaust",
      "restart-brain",
      "restart-tool",
      "restart-tool-io-error",
      "cancel",
      "late-tool-fail",
      "deadline",
    ]),
    total: z.number().finite().default(15),
  })
  .strict();
type Input = z.infer<typeof inputSchema>;
type Purpose = "collect" | "check" | "summarize";
type Outputs = Record<Purpose, AgentTurn>;
type InvoiceResult = { readonly value: number };
type State = AgentState<Purpose, Purpose, Outputs, InvoiceResult>;
type Msg = AgentMachineMsg<Purpose, Outputs, InvoiceResult>;
type ToolCmd = { readonly type: "invoice_tool"; readonly call: ToolCall };
type Message = { readonly call: LlmCall<Purpose> };
const invoiceSchema = z
  .object({
    invoiceId: z.literal("inv-17"),
    lines: z.array(z.number()),
    total: z.number(),
  })
  .strict();
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function payloadRecords(call: LlmCall<Purpose>): readonly unknown[] {
  const payload = call.payload;
  assert.ok(payload !== null && typeof payload === "object");
  const conversation = Reflect.get(payload, "conversation");
  assert.ok(conversation !== null && typeof conversation === "object");
  const records = Reflect.get(conversation, "toolRecords");
  assert.ok(Array.isArray(records));
  return records;
}
async function settle<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}
async function execute(input: Input) {
  await mkdir("target/parity/agent-runtime-io", { recursive: true });
  const directory = await mkdtemp(
    path.resolve("target/parity/agent-runtime-io/source-"),
  );
  try {
    await writeFile(
      path.join(directory, "invoice.json"),
      JSON.stringify({
        invoiceId: "inv-17",
        lines: [4.5, 10.5],
        total: input.scenario === "bad-total" ? 16 : input.total,
      }),
    );
    let now = 17.25,
      modelCalls = 0,
      toolCalls = 0,
      schemaSame = true,
      validated = true;
    const trace: string[] = [],
      reports: unknown[] = [],
      diagnostics: unknown[] = [],
      timerEvents: unknown[] = [];
    const requests: LlmCall<Purpose>[] = [],
      background: Promise<void>[] = [];
    const cancelled = deferred(),
      released = deferred();
    let deadlineCommit = deferred();
    let originalIo: unknown;
    const dispatchFailures: (string | null)[] = [];
    const cause = new Error("invoice model rejected"),
      crash = new Error("persisted-before-effect");
    const stages: Purpose[] = ["collect", "check", "summarize"];
    function parser(p: Purpose): Schema<AgentTurn> {
      return {
        parse(value: unknown) {
          trace.push(`parse:${p}`);
          if (input.scenario === "parse-error") throw cause;
          if (!isAgentTurn(value))
            throw new Error("fixture returned an invalid AgentTurn");
          return value;
        },
      };
    }
    const schemas = {
      collect: parser("collect"),
      check: parser("check"),
      summarize: parser("summarize"),
    };
    const rows: { at: number; callback: (() => void) | null }[] = [];
    const runner = subscribeWith((_, at, msg, dispatch) => {
      const due = now + Math.max(0, at - now);
      const row: { at: number; callback: (() => void) | null } = {
        at: due,
        callback: () => dispatch(msg),
      };
      rows.push(row);
      timerEvents.push(["arm", due]);
      return () => {
        row.callback = null;
        timerEvents.push(["cancel", due]);
      };
    });
    function fireNext() {
      const row = rows
        .filter((r) => r.callback !== null)
        .sort((a, b) => a.at - b.at)[0];
      if (!row) return false;
      const callback = row.callback;
      row.callback = null;
      now = row.at;
      timerEvents.push(["fire", now]);
      callback?.();
      return true;
    }
    function tool(
      cmd: ToolCmd,
      _ctx: object,
      dispatch?: (msg: Msg) => void,
    ): Promise<readonly Msg[] | undefined> {
      return (async () => {
        toolCalls++;
        trace.push(`tool:${cmd.call.name}`);
        if (
          input.scenario === "cancel" ||
          input.scenario === "late-tool-fail"
        ) {
          await readFile(path.join(directory, "invoice.json"), "utf8");
          now = 30;
          assert.ok(dispatch);
          dispatch(agentCancelMsg(30));
          background.push(
            (async () => {
              await released.promise;
              trace.push("late-tool");
              dispatch(
                input.scenario === "late-tool-fail"
                  ? {
                      type: "agent_tool_err",
                      callId: cmd.call.callId,
                      reason: "late validator rejection",
                      at: now,
                    }
                  : {
                      type: "agent_tool_ok",
                      callId: cmd.call.callId,
                      result: { value: 15 },
                      at: now,
                    },
              );
            })(),
          );
          return;
        }
        const text = await readFile(
          path.join(
            directory,
            input.scenario === "tool-io-error" ? "absent.json" : "invoice.json",
          ),
          "utf8",
        ).catch((error: unknown) => {
          originalIo = error;
          throw error;
        });
        const invoice = invoiceSchema.parse(JSON.parse(text)),
          sum = invoice.lines.reduce((a, b) => a + b, 0);
        if (input.scenario === "deadline") return;
        if (cmd.call.name === "check" && sum !== invoice.total) {
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
        const messages: Msg[] = [
          {
            type: "agent_tool_ok",
            callId: cmd.call.callId,
            result: { value: sum },
            at: now,
          },
        ];
        if (input.scenario === "stale-settlements")
          messages.push({
            type: "agent_tool_err",
            callId: cmd.call.callId,
            reason: "already completed",
            at: now + 1,
          });
        return messages;
      })();
    }
    const agent = createAgent<
      Purpose,
      Purpose,
      Outputs,
      InvoiceResult,
      ToolCmd,
      Message
    >({
      stages,
      schemas,
      turnOf: (stage) => stage ?? "collect",
      toolOf: (call) => ({ type: "invoice_tool", call }),
      payloadOf: (_, conversation) => ({ conversation }),
      deadlineMs: 100,
      rng: () => 0,
      ...(input.scenario === "retry-once" || input.scenario === "retry-exhaust"
        ? {
            retry: {
              baseMs: 5,
              factor: 1,
              capMs: 5,
              jitter: "none" as const,
              maxAttempts: 2,
            },
          }
        : {}),
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
            schemaSame &&= Object.is(schema, schemas[call.purpose]);
            trace.push(`bind:${call.purpose}`);
            return {
              async invoke(messages: readonly Message[]) {
                const current = messages[0]?.call;
                assert.equal(current, call);
                modelCalls++;
                trace.push(`model:${call.purpose}`);
                if (
                  input.scenario === "model-error" ||
                  input.scenario === "retry-exhaust" ||
                  (input.scenario === "retry-once" && modelCalls === 1)
                )
                  throw cause;
                const purpose = call.purpose,
                  needsTool =
                    purpose !== "summarize" &&
                    payloadRecords(call).length === 0;
                const calls: ToolCall[] = needsTool
                  ? [{ callId: `${purpose}-17`, name: purpose, args: {} }]
                  : [];
                if (needsTool && input.scenario === "duplicate")
                  calls.push({
                    callId: `${purpose}-17`,
                    name: "ignored",
                    args: {},
                  });
                const turn: AgentTurn = {
                  content:
                    purpose === "summarize"
                      ? validated
                        ? "Invoice total confirmed: 15"
                        : "Invoice requires review"
                      : purpose,
                  toolCalls: calls,
                };
                // This validating provider honors Llm<T> with the actual parser.
                // brainHandler re-validates; the native provider makes the same two calls.
                return schema.parse(turn);
              },
            };
          },
        };
      },
    });
    const inner = memoryStore<State>();
    let crashed = false;
    const stage = (state: State) => agent.currentStage(state) ?? "-";
    const store = {
      load: () => inner.load(),
      migrate: (raw: unknown) => inner.migrate(raw),
      async save(state: State) {
        trace.push(`save:${state.run.phase}:${stage(state)}`);
        await inner.save(state);
        const target =
          input.scenario === "restart-brain"
            ? state.conversation?.awaiting.kind === "llm"
            : input.scenario === "restart-tool" ||
                input.scenario === "restart-tool-io-error"
              ? state.conversation?.awaiting.kind === "tools"
              : false;
        if (target && !crashed) {
          crashed = true;
          trace.push("crash-window");
          throw crash;
        }
      },
    };
    function failure(error: unknown): string {
      if (error === crash) return "save";
      if (error !== null && typeof error === "object") {
        const code = Reflect.get(error, "code"),
          nested = Reflect.get(error, "cause");
        if (code === "ENOENT") {
          assert.equal(error, originalIo);
          return "tool-io";
        }
        if (nested !== undefined && nested !== error) return failure(nested);
        const name = Reflect.get(error, "name");
        if (typeof name === "string") return name;
      }
      return String(error);
    }
    const onError = (error: unknown, ctx: { phase: string }) => {
      reports.push([ctx.phase, failure(error)]);
      diagnostics.push({
        phase: ctx.phase,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message, stack: error.stack }
            : String(error),
      });
    };
    function stateView(state: State) {
      return {
        phase: state.run.phase,
        stage: stage(state),
        settled: agent.isSettled(state),
        failure: state.failure?.reason ?? null,
        causeSame:
          state.failure?.reason === "llm"
            ? state.failure.error !== null &&
              typeof state.failure.error === "object" &&
              Reflect.get(state.failure.error, "error") === cause
            : null,
        output: state.output?.content ?? null,
        awaiting: state.conversation?.awaiting.kind ?? null,
        records:
          state.conversation?.toolRecords.map((r) => [
            r.call.callId,
            r.outcome.kind === "ok"
              ? { ok: r.outcome.result.value }
              : { error: true },
          ]) ?? [],
        calls: Object.fromEntries(
          Object.entries(state.resilience.calls).map(([key, value]) => [
            key,
            value.phase,
          ]),
        ),
        retryKeys: Object.keys(state.resilience.retry),
      };
    }
    if (
      input.scenario === "stamp-null" ||
      input.scenario === "stamp-missing" ||
      input.scenario === "projection-error"
    ) {
      const wired = agent.toMachine<object>({
        toolInterpret: { invoice_tool: tool },
      });
      const seed = agent.init();
      if (input.scenario === "projection-error") {
        Reflect.deleteProperty(seed, "compaction");
        const entries = wired.machine.subs;
        assert.ok(Array.isArray(entries));
        const entry = entries[0];
        assert.ok(entry && typeof entry === "object");
        const deps = Reflect.get(entry, "deps");
        assert.equal(typeof deps, "function");
        try {
          Reflect.apply(deps, undefined, [seed]);
          return { openProfile: input.scenario, accepted: true };
        } catch (error) {
          return {
            openProfile: input.scenario,
            accepted: false,
            error:
              error instanceof Error
                ? {
                    name: error.name,
                    message: error.message,
                    stack: error.stack,
                  }
                : String(error),
          };
        }
      }
      const [started, commands] = agent.start(seed, "manual-stamp", 0);
      const cmd = commands.find((cmd) => cmd.type === "resilient_run");
      assert.ok(cmd);
      const raw: unknown = JSON.parse(
        JSON.stringify({
          type: "resilient_run_ok",
          cmd,
          value: {
            key: "collect",
            purpose: "collect",
            output: { content: "manual turn", toolCalls: [] },
          },
          at: NaN,
        }),
      );
      assert.ok(raw !== null && typeof raw === "object");
      if (input.scenario === "stamp-missing") Reflect.deleteProperty(raw, "at");
      const at = Reflect.get(raw, "at"),
        atKind =
          at === undefined ? "missing" : at === null ? "null" : typeof at;
      try {
        const folded: unknown = Reflect.apply(applyCell, undefined, [
          wired.machine,
          started,
          raw,
        ]);
        assert.ok(Array.isArray(folded));
        const state: unknown = folded[0];
        assert.ok(state !== null && typeof state === "object");
        const run = Reflect.get(state, "run"),
          resilience = Reflect.get(state, "resilience");
        assert.ok(
          run !== null &&
            typeof run === "object" &&
            resilience !== null &&
            typeof resilience === "object",
        );
        const numberKind = (value: unknown) =>
          value === undefined
            ? "undefined"
            : value === null
              ? "null"
              : typeof value === "number" && Number.isNaN(value)
                ? "NaN"
                : value;
        return {
          openProfile: input.scenario,
          atKind,
          accepted: true,
          phase: Reflect.get(run, "phase"),
          lastProgressAt: numberKind(Reflect.get(run, "lastProgressAt")),
          clockMs: numberKind(Reflect.get(resilience, "clockMs")),
        };
      } catch (error) {
        return {
          openProfile: input.scenario,
          atKind,
          accepted: false,
          error:
            error instanceof Error
              ? { name: error.name, message: error.message, stack: error.stack }
              : String(error),
        };
      }
    }
    let restart: unknown = null,
      finalState: State | null = null,
      doneSame: boolean | null = null;
    const rounds =
      input.scenario === "restart-brain" ||
      input.scenario === "restart-tool" ||
      input.scenario === "restart-tool-io-error" ||
      input.scenario === "terminal-boot"
        ? 2
        : 1;
    for (let round = 0; round < rounds; round++) {
      const wired = agent.toMachine<object>({
        toolInterpret: { invoice_tool: tool },
      });
      const loaded = await inner.load(),
        before = modelCalls;
      let dispatch: (msg: Msg) => Promise<void>,
        getState: () => State,
        idle: () => Promise<void>,
        done: () => Promise<State>,
        result: () => State | undefined,
        stop: () => Promise<void>;
      const committed = (msg: Msg, state: State) => {
        trace.push(`commit:${msg.type}:${state.run.phase}:${stage(state)}`);
        if (state.run.phase === "cancelled") cancelled.resolve();
        if (msg.type === "deadline_exceeded") {
          deadlineCommit.resolve();
        }
      };
      const booted = (state: State) =>
        trace.push(`commit:boot:${state.run.phase}:${stage(state)}`);
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
        const runtime = await live.ready;
        getState = runtime.getState;
        dispatch = (msg) => runtime.dispatch(msg);
        idle = () => runtime.idle();
        done = () => runtime.done();
        result = runtime.result;
        stop = () => runtime.stop();
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
                        throw new Error("unexpected brain port emission");
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
                  Effect.tryPromise({
                    try: () =>
                      tool(cmd, {}, (msg) => {
                        void Effect.runPromise(live.dispatchOnce(msg));
                      }),
                    catch: (error) => error,
                  }),
              },
              subscribe: {
                deadline: (sub) => {
                  const queue = Effect.runSync(Queue.unbounded<Msg>());
                  const cancel = runner(sub, {}, (msg) => {
                    Queue.offerUnsafe(queue, msg);
                  });
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
        const runtime = await settle(live.ready);
        getState = runtime.getState;
        dispatch = (msg) => settle(runtime.dispatch(msg));
        idle = () => settle(runtime.idle());
        done = () => settle(runtime.done());
        result = runtime.result;
        stop = () => Effect.runPromise(Scope.close(scope, Exit.void));
      }
      if (round === 1 && input.scenario === "restart-tool-io-error")
        await rm(path.join(directory, "invoice.json"));
      if (round === 1)
        restart = {
          loadedSame: getState() === loaded,
          newModelCallsAtReady: modelCalls - before,
          stateAtReady: stateView(getState()),
        };
      const msg: Msg =
        round === 0 && input.scenario === "fresh-boot"
          ? agentBootMsg(now)
          : round === 0
            ? { type: "agent_start", runId: "invoice-17", at: 0 }
            : agentBootMsg(now);
      if (input.scenario === "cancel" || input.scenario === "late-tool-fail") {
        const started = dispatch(msg);
        await cancelled.promise;
        now = 35;
        released.resolve();
        await Promise.all(background);
        await started.then(
          () => dispatchFailures.push(null),
          (error) => dispatchFailures.push(failure(error)),
        );
        await idle();
      } else {
        await dispatch(msg).then(
          () => dispatchFailures.push(null),
          (error) => dispatchFailures.push(failure(error)),
        );
      }
      for (let turn = 0; turn < 5; turn++) {
        if (
          agent.isSettled(getState()) ||
          !["retry-once", "retry-exhaust", "deadline"].includes(input.scenario)
        )
          break;
        deadlineCommit = deferred();
        if (!fireNext()) break;
        await deadlineCommit.promise;
        await idle();
      }
      finalState = getState();
      if (agent.isSettled(finalState))
        doneSame = (await done()) === finalState && result() === finalState;
      await stop();
      if (round === 0 && rounds === 2) trace.push("restart");
    }
    assert.ok(finalState);
    return {
      id: input.id ?? null,
      view: {
        state: stateView(finalState),
        savedSame: finalState === (await inner.load()),
        modelCalls,
        toolCalls,
        schemaSame,
        requestReused:
          input.scenario === "retry-once" || input.scenario === "retry-exhaust"
            ? requests.length > 1 && requests[0] === requests[1]
            : null,
        dispatchFailures,
        doneSame,
        restart,
        trace,
        timers: timerEvents,
        reports,
      },
      diagnostics,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
for await (const line of createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})) {
  console.log(
    JSON.stringify(await execute(inputSchema.parse(JSON.parse(line)))),
  );
}
