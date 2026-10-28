import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  agentTurnSchema,
  createAgent,
  type ToolCall,
} from "../../packages/tea/src/agent/index.ts";
import { run as runEffect } from "../../packages/tea/src/effect/index.ts";
import { subscribeWith } from "../../packages/tea/src/internal/resilience/deadline/index.ts";
import { fileStore } from "../../packages/tea/src/node/index.ts";
import { run as runPromise } from "../../packages/tea/src/promise/index.ts";
import { Outcome } from "../../packages/tea/src/pure/core.ts";

type Purpose = "collect" | "check" | "summarize";
type Outputs = Record<Purpose, AgentTurn>;
type State = AgentState<Purpose, Purpose, Outputs, unknown>;
type Msg = AgentMachineMsg<Purpose, Outputs, unknown>;
type Tool = { readonly type: "policy_tool"; readonly call: ToolCall };
function object(value: unknown): value is object {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
// Same-version fixture carrier check, following agent-state-json-reference; not a general AgentState codec.
const stateBoundary = z.custom<State>((value) => {
  if (!object(value)) return false;
  const run = Reflect.get(value, "run"),
    tools = Reflect.get(value, "tools"),
    resilience = Reflect.get(value, "resilience"),
    conversation = Reflect.get(value, "conversation"),
    ladders = Reflect.get(value, "toolResilience");
  return (
    object(run) &&
    typeof Reflect.get(run, "phase") === "string" &&
    object(tools) &&
    Array.isArray(Reflect.get(tools, "running")) &&
    object(resilience) &&
    object(Reflect.get(resilience, "calls")) &&
    object(ladders) &&
    (conversation === null || object(conversation))
  );
});
const wire = (value: any) => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function settle<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}
async function execute(input: any) {
  const mode = input.mode ?? "runtime",
    scenario = input.scenario ?? "retry-recover";
  assert.ok(input.path);
  await mkdir(input.path, { recursive: true });
  if (mode !== "reader")
    await writeFile(
      path.join(input.path, "invoice.json"),
      JSON.stringify({ invoice: "inv-17", lines: [4.5, 10.5], total: 15 }),
    );
  const trace: any[] = [],
    timerLog: any[] = [],
    commits: any[] = [],
    reports: any[] = [];
  let now = mode === "reader" ? 500.25 : 17.25,
    models = 0,
    tools = 0,
    cursor = mode === "reader" ? 1 : 0,
    loaded: any;
  const attempts = new Map<string, number>(),
    entered = deferred(),
    release = deferred();
  const rows: { due: number; callback: (() => void) | null }[] = [];
  const runner = subscribeWith((_, at, msg, dispatch) => {
    const row: { due: number; callback: (() => void) | null } = {
      due: Math.max(now, at),
      callback: () => dispatch(msg),
    };
    rows.push(row);
    timerLog.push(["arm", row.due]);
    return () => {
      row.callback = null;
      timerLog.push(["cancel", row.due]);
    };
  });
  const fire = () => {
    const row = rows.filter((r) => r.callback).sort((a, b) => a.due - b.due)[0];
    if (!row) return false;
    const cb = row.callback;
    row.callback = null;
    now = row.due;
    timerLog.push(["fire", now]);
    cb?.();
    return true;
  };
  const tool = async (cmd: Tool): Promise<readonly Msg[]> => {
    tools++;
    const id = cmd.call.callId,
      attempt = (attempts.get(id) ?? 0) + 1;
    attempts.set(id, attempt);
    trace.push(["tool", id, attempt]);
    const invoice = JSON.parse(
      await readFile(path.join(input.path, "invoice.json"), "utf8"),
    );
    if (scenario === "timeout-late" && id === "collect-1") {
      entered.resolve();
      await release.promise;
    }
    const failed =
      id === "collect-1" &&
      scenario !== "timeout-late" &&
      ((scenario === "retry-exhaust" && attempt <= 2) ||
        (scenario !== "retry-exhaust" && attempt === 1 && mode !== "reader"));
    if (failed)
      return [
        { type: "agent_tool_err", callId: id, reason: "offline", at: now },
      ];
    const result =
      cmd.call.args.op === "check"
        ? {
            valid:
              invoice.lines.reduce((a: number, b: number) => a + b, 0) ===
              invoice.total,
            total: invoice.total,
          }
        : invoice;
    if (cmd.call.args.op === "check")
      await writeFile(
        path.join(input.path, "checked.json"),
        JSON.stringify(result),
      );
    return [{ type: "agent_tool_ok", callId: id, result, at: now }];
  };
  const knob = createAgent<Purpose, Purpose, Outputs, unknown, Tool, unknown>({
    stages: ["collect", "check", "summarize"],
    turnOf: (stage) => {
      assert.ok(stage !== undefined);
      return stage;
    },
    payloadOf: (_, conversation) => ({ conversation }),
    schemas: {
      collect: agentTurnSchema,
      check: agentTurnSchema,
      summarize: agentTurnSchema,
    },
    toolOf: (call: any) => {
      trace.push(["of", call.callId]);
      return { type: "policy_tool", call };
    },
    toolResilienceOf: (call: any) => {
      trace.push(["policy", call.name, call.callId]);
      if (scenario === "none") return null;
      if (scenario === "empty") return {};
      return {
        timeoutMs: 50,
        ...(scenario === "timeout-late"
          ? {}
          : {
              retry: {
                baseMs: 10,
                factor: 1,
                capMs: 100,
                jitter: "none",
                maxAttempts: scenario === "retry-exhaust" ? 2 : 3,
              },
            }),
      };
    },
    model: () => ({
      withStructuredOutput: (schema: any) => ({
        invoke: async () => {
          const index = cursor++;
          models++;
          trace.push(["model", index]);
          const op = index === 0 ? "collect" : index === 2 ? "check" : null;
          return schema.parse(
            op
              ? {
                  content: op,
                  toolCalls: [
                    {
                      callId: `${op}-1`,
                      name: "lookup",
                      args: { op, file: "invoice.json" },
                    },
                  ],
                }
              : {
                  content:
                    index === 4 ? "invoice verified:15" : "stage complete",
                  toolCalls: [],
                },
          );
        },
      }),
    }),
    rng: () => {
      trace.push(["rng", 0.25]);
      return 0.25;
    },
  });
  const wired = knob.toMachine({ toolInterpret: { policy_tool: tool } }),
    store = fileStore<State>(path.join(input.path, "state.json"), (raw) => {
      loaded = stateBoundary.parse(raw);
      return loaded;
    });
  let getState: any,
    dispatch: any,
    idle: any,
    done: any,
    result: any,
    stop: any;
  const committed = (msg: any, state: any) =>
    commits.push(
      wire({
        tag: msg.type,
        run: state.run.phase,
        lifecycle: state.lifecycle,
        awaiting: state.conversation?.awaiting ?? null,
        records: state.conversation?.toolRecords ?? [],
      }),
    );
  if (input.profile === "effect") {
    const scope = await Effect.runPromise(Scope.make());
    const live = await Effect.runPromise(
      Scope.provide(scope)(
        runEffect(wired.machine, {
          ctx: {},
          store,
          clock: () => now,
          terminal: knob.isSettled,
          interpret: {
            resilient_run: (cmd: any) =>
              Effect.promise(() =>
                wired.interpret.resilient_run(cmd, {
                  emit: () => {},
                  ok: Outcome.ok,
                  err: Outcome.err,
                }),
              ).pipe(
                Effect.flatMap((out: any) =>
                  out
                    ? out._tag === "Ok"
                      ? Effect.succeed(out.value)
                      : Effect.fail(out.error)
                    : Effect.succeed(undefined),
                ),
              ),
            policy_tool: (cmd: any) =>
              Effect.tryPromise({ try: () => tool(cmd), catch: (e) => e }),
          },
          subscribe: {
            deadline: (sub: any) => {
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
    const runtime: any = await settle(live.ready);
    runtime.observe(committed);
    getState = runtime.getState;
    dispatch = (m: any) => settle(runtime.dispatch(m));
    idle = () => settle(runtime.idle());
    done = () => settle(runtime.done());
    result = runtime.result;
    stop = () => Effect.runPromise(Scope.close(scope, Exit.void));
  } else {
    const runtime: any = await runPromise(wired.machine, {
      ctx: {},
      store,
      clock: () => now,
      terminal: knob.isSettled,
      interpret: wired.interpret,
      subscribe: { deadline: runner },
    }).ready;
    runtime.observe(committed);
    runtime.onError?.((e: any) => reports.push(e));
    getState = runtime.getState;
    dispatch = runtime.dispatch;
    idle = () => runtime.idle();
    done = () => runtime.done();
    result = runtime.result;
    stop = () => runtime.stop();
  }
  const ready = wire(getState()),
    loadedIdentity =
      loaded == null
        ? { status: "not-applicable", checks: 0, same: null }
        : { status: "tracked", checks: 1, same: getState() === loaded };
  const start =
    mode === "reader"
      ? agentBootMsg(now)
      : { type: "agent_start", runId: "policy-run", at: now };
  if (scenario === "timeout-late") {
    const pending = dispatch(start);
    await entered.promise;
    assert.ok(fire());
    release.resolve();
    await pending;
    await idle();
  } else {
    await dispatch(start);
    await idle();
  }
  if (mode === "writer") {
    const checkpointBytes = await readFile(
      path.join(input.path, "state.json"),
      "utf8",
    );
    const state = wire(getState());
    await stop();
    return {
      view: {
        ready,
        loadedIdentity,
        state,
        checkpointBytes,
        models,
        tools,
        trace,
        timerLog,
        commits,
        reports,
      },
    };
  }
  if (scenario === "cancel-waiting") {
    now += 1;
    await dispatch(agentCancelMsg(now));
    await idle();
  }
  let fires = 0;
  while (!result() && fires < 8) {
    if (!fire()) break;
    fires++;
    await idle();
  }
  const settled = result() ? await done() : getState();
  await stop();
  let checked: any = null;
  try {
    checked = JSON.parse(
      await readFile(path.join(input.path, "checked.json"), "utf8"),
    );
  } catch {}
  return {
    view: {
      ready,
      loadedIdentity,
      state: wire(settled),
      models,
      tools,
      trace,
      timerLog,
      commits,
      reports,
      checked,
      liveTimers: rows.filter((r) => r.callback).length,
    },
  };
}
for await (const line of createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})) {
  try {
    const frame = JSON.parse(line);
    const out = await execute(frame.input);
    console.log(JSON.stringify({ id: frame.id, ...out }));
  } catch (e) {
    console.log(
      JSON.stringify({
        id: null,
        error: { name: (e as Error).name, message: (e as Error).message },
      }),
    );
  }
}
