import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Cause, Effect, Exit, Scope, type Stream } from "effect";
import {
  type AgentEvent,
  type AgentMachineMsg,
  type AgentState,
  type AgentTurn,
  agentEvents,
  agentTurnSchema,
  createAgent,
  type Schema,
  type ToolCall,
  type ToolFailure,
  transcript,
} from "../../packages/tea/src/agent/index.ts";
import { run as runEffect } from "../../packages/tea/src/effect/index.ts";
import { applyCell, Outcome } from "../../packages/tea/src/index.ts";
import { run as runPromise } from "../../packages/tea/src/promise/index.ts";
import type {
  RuntimeErrorContext,
  Store,
} from "../../packages/tea/src/runtime-types.ts";

type Stage = "collect" | "check" | "summarize";
type Outputs = { invoice: AgentTurn };
type Result = {
  readonly raw: string;
  readonly total: number;
  readonly valid: boolean;
};
type State = AgentState<Stage, "invoice", Outputs, Result>;
type Msg = AgentMachineMsg<"invoice", Outputs, Result>;
type Tool = { readonly type: "invoice_io"; readonly call: ToolCall };
type Event = AgentEvent<Result>;
type Input = {
  id: string;
  mode: "pure" | "runtime";
  scenario: string;
  profile?: "promise" | "effect";
};
const input: Input = JSON.parse(process.argv[2]);
const directory = process.argv[3];
const payload = { invoiceId: "invoice-17", audit: { revision: 3 } };
const readCall: ToolCall = {
  callId: "read-17",
  name: "read",
  args: { relative: "invoice.txt", extra: "keep" },
};
const checkCall: ToolCall = {
  callId: "check-17",
  name: "check",
  args: { expected: 17, extra: [1, 2] },
};
const turn = (content: string, ...calls: ToolCall[]): AgentTurn => ({
  content,
  toolCalls: calls,
});
const turns = [
  turn("collect invoice", readCall),
  turn("collected"),
  turn("check invoice", checkCall),
  turn("checked"),
  turn("invoice 17 is valid"),
];
const result: Result = {
  raw: "invoice=17\namount=17\n",
  total: 17,
  valid: true,
};
const failure: ToolFailure & {
  readonly data: { readonly file: string; readonly code: number };
} = {
  kind: "error",
  reason: "invoice unavailable",
  _tag: "missing",
  data: { file: "invoice.txt", code: 17 },
};
const copy = (value: unknown) => JSON.parse(JSON.stringify(value));

function make(
  invoke: () => Promise<unknown> = async () => turns[0],
  retry = false,
) {
  const model = () => ({
    withStructuredOutput<T>(schema: Schema<T>) {
      return { invoke: async () => schema.parse(await invoke()) };
    },
  });
  return createAgent<Stage, "invoice", Outputs, Result, Tool, ToolFailure>({
    stages: ["collect", "check", "summarize"],
    turnOf: () => "invoice",
    toolOf: (call) => ({ type: "invoice_io", call }),
    model,
    schemas: { invoice: agentTurnSchema },
    payloadOf: () => payload,
    rng: () => 0,
    ...(retry
      ? {
          toolResilienceOf: () => ({
            retry: {
              baseMs: 10,
              factor: 2,
              capMs: 100,
              maxAttempts: 2,
              jitter: "full",
            },
          }),
        }
      : {}),
  });
}

function pure() {
  const agent = make(undefined, input.scenario === "retry");
  const project = agentEvents<Stage, "invoice", Outputs, Result>();
  const initial = agent.init();
  const start: Msg = { type: "agent_start", runId: "invoice-run", at: 11 };
  const boot: Msg = { type: "agent_boot", at: 12 };
  const [started] = agent.start(initial, "invoice-run", 11);
  const [pending] = agent.turn(started, turns[0], 13);
  const ok: Msg = {
    type: "agent_tool_ok",
    callId: readCall.callId,
    result,
    at: 17,
  };
  const err = {
    type: "agent_tool_err",
    callId: readCall.callId,
    reason: failure.reason,
    at: 17,
  } satisfies Msg;
  const checks: Record<string, unknown> = {};
  const batches: unknown[] = [];
  if (input.scenario === "idle") {
    const events = project(start, initial);
    assert.deepEqual(events, []);
    batches.push(events);
  } else if (input.scenario === "outbox") {
    const first = project(start, started);
    const embedded = project(boot, started);
    const [next] = agent.boot(started, 19);
    const fresh = project({ type: "agent_boot", at: 19 }, next);
    assert.deepEqual(
      first.map((e) => e.type),
      ["BrainStarted"],
    );
    assert.deepEqual(embedded, []);
    assert.deepEqual(
      fresh.map((e) => e.type),
      ["BrainStarted"],
    );
    checks.payloadChecks = 2;
    checks.payloadSame = [...first, ...fresh].every(
      (e) => e.type === "BrainStarted" && e.payload === payload,
    );
    checks.freshOutbox = started.lifecycle !== next.lifecycle;
    assert.equal(checks.payloadSame, true);
    assert.equal(checks.freshOutbox, true);
    batches.push(first, embedded, fresh);
  } else if (input.scenario === "direct") {
    const [next] = agent.toolOk(pending, readCall.callId, result, 17);
    const first = project(ok, next);
    const second = project(ok, next);
    assert.deepEqual(
      first.map((e) => e.type),
      ["ToolSettled", "BrainStarted"],
    );
    assert.deepEqual(
      second.map((e) => e.type),
      ["ToolSettled"],
    );
    checks.resultChecks = 2;
    checks.resultSame = [...first, ...second]
      .filter((e) => e.type === "ToolSettled")
      .every((e) => e.result === result);
    assert.equal(checks.resultSame, true);
    batches.push(first, second);
  } else if (input.scenario === "refused") {
    const [next] = agent.toolErr(pending, readCall.callId, failure, 17);
    const first = project(err, next);
    const late = project(ok, next);
    assert.deepEqual(
      first.map((e) => e.type),
      ["ToolFailed", "BrainStarted"],
    );
    assert.deepEqual(late, []);
    checks.failureChecks = 1;
    checks.failureSame = first.some(
      (e) => e.type === "ToolFailed" && e.failure === failure,
    );
    assert.equal(checks.failureSame, true);
    batches.push(first, late);
  } else if (input.scenario === "cancel") {
    const cancel: Msg = { type: "agent_cancel", at: 21 };
    const wired = agent.toMachine<object>({
      toolInterpret: { invoice_io: async () => ok },
    });
    const [next] = applyCell(wired.machine, pending, cancel);
    const first = project(cancel, next);
    const second = project(cancel, next);
    const late = project(ok, next);
    assert.deepEqual(
      first.map((e) => e.type),
      ["RunDone"],
    );
    assert.deepEqual(second, []);
    assert.deepEqual(late, []);
    batches.push(first, second, late);
  } else if (input.scenario === "retry") {
    const [waiting] = agent.toolErr(pending, readCall.callId, failure, 17);
    const first = project(err, waiting);
    assert.deepEqual(first, []);
    const timer = agent
      .subs(waiting)
      .find((t) => t.id.startsWith("resilient:retry:$tool:"));
    assert.ok(timer);
    const timerMsg: Msg = { type: "deadline_exceeded", id: timer.id, atMs: 18 };
    const [running] = agent.onTimer(waiting, timerMsg);
    const retryEvents = project(timerMsg, running);
    const [ended] = agent.toolErr(running, readCall.callId, failure, 19);
    const final = project({ ...err, at: 19 }, ended);
    assert.deepEqual(retryEvents, []);
    assert.deepEqual(
      final.map((e) => e.type),
      ["ToolFailed", "BrainStarted"],
    );
    checks.finalFailureChecks = 1;
    checks.exhaustedTag = final.some(
      (e) => e.type === "ToolFailed" && e.failure._tag === "retry_exhausted",
    );
    assert.equal(checks.exhaustedTag, true);
    batches.push(first, retryEvents, final);
  } else throw new Error(`unknown scenario ${input.scenario}`);
  return { batches, checks };
}

async function settle<A, E>(effect: Effect.Effect<A, E>) {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}

async function runtime() {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "invoice.txt"), result.raw);
  const log: unknown[] = [];
  const events: Event[] = [];
  const projectInputs: unknown[] = [];
  const callbackError = new Error("invoice event listener failed");
  const saveError = new Error("invoice checkpoint refused");
  const reports: { error: unknown; context: RuntimeErrorContext }[] = [];
  let models = input.scenario === "resume" ? 1 : 0;
  let tools = 0;
  let saves = 0;
  let listenerThrown = false;
  const agent = make(async () => {
    const original = turns[models++];
    assert.ok(original, "finite invoice model script");
    log.push(["model", original.content]);
    return original;
  });
  let loaded: State | null = null;
  if (input.scenario === "resume") {
    const [started] = agent.start(agent.init(), "invoice-run", 11);
    [loaded] = agent.turn(started, turns[0], 13);
  }
  const collector = transcript<Result>(loaded === null ? undefined : loaded);
  const project = agentEvents<Stage, "invoice", Outputs, Result>();
  const projectWithTrace = (msg: Msg, state: State) => {
    projectInputs.push([msg.type, state.lifecycle?.map((n) => n.kind) ?? []]);
    return project(msg, state);
  };
  const tool = async (cmd: Tool): Promise<Msg> => {
    tools++;
    log.push(["tool", cmd.call.callId]);
    const raw = await readFile(path.join(directory, "invoice.txt"), "utf8");
    assert.equal(raw, result.raw);
    if (cmd.call.name === "check")
      await writeFile(
        path.join(directory, "checked.txt"),
        "invoice=17:valid\n",
      );
    return { type: "agent_tool_ok", callId: cmd.call.callId, result, at: 51 };
  };
  const wired = agent.toMachine<object>({
    toolInterpret: { invoice_io: tool },
  });
  const store: Store<State> = {
    load: async () => loaded,
    migrate: (raw) => {
      assert.ok(raw === null || raw === loaded, "exact retained state profile");
      return loaded;
    },
    save: async (state) => {
      saves++;
      log.push(["save", saves, state.run.phase]);
      if (input.scenario === "save" && saves === 2) throw saveError;
    },
  };
  const onError = (error: unknown, context: RuntimeErrorContext) => {
    reports.push({ error, context });
    log.push(["report", context.phase]);
  };
  const scope = await Effect.runPromise(Scope.make());
  let getState!: () => State;
  let dispatch!: (msg: Msg) => Promise<unknown>;
  let stop!: () => Promise<void>;
  let on!: import("../../packages/tea/src/runtime-types.ts").Runtime<
    State,
    Msg,
    Event
  >["on"];
  let observe!: import("../../packages/tea/src/runtime-types.ts").Runtime<
    State,
    Msg,
    Event
  >["observe"];
  let subscribe!: import("../../packages/tea/src/runtime-types.ts").Runtime<
    State,
    Msg,
    Event
  >["subscribe"];
  let onBoot!: import("../../packages/tea/src/runtime-types.ts").Runtime<
    State,
    Msg,
    Event
  >["onBoot"];
  if (input.profile === "effect") {
    const booting = await Effect.runPromise(
      Scope.provide(scope)(
        runEffect(wired.machine, {
          ctx: {},
          store,
          clock: () => 50,
          terminal: agent.isSettled,
          events: projectWithTrace,
          onError,
          interpret: {
            resilient_run: (cmd) =>
              Effect.promise(() =>
                wired.interpret.resilient_run(cmd, {
                  ok: Outcome.ok,
                  err: Outcome.err,
                  emit() {
                    throw new Error("unexpected emit");
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
            invoice_io: (cmd) => Effect.promise(() => tool(cmd)),
          },
          subscribe: {
            deadline: (): Stream.Stream<Msg> => {
              throw new Error("unexpected deadline in no-retry profile");
            },
          },
        }),
      ),
    );
    const live = await settle(booting.ready);
    getState = live.getState;
    dispatch = (msg) => settle(live.dispatch(msg));
    stop = () => Effect.runPromise(Scope.close(scope, Exit.void));
    on = live.on;
    observe = live.observe;
    subscribe = live.subscribe;
    onBoot = live.onBoot;
  } else {
    const live = await runPromise(wired.machine, {
      ctx: {},
      store,
      clock: () => 50,
      terminal: agent.isSettled,
      events: projectWithTrace,
      onError,
      interpret: wired.interpret,
      subscribe: {
        deadline: () => {
          throw new Error("unexpected deadline in no-retry profile");
        },
      },
    }).ready;
    getState = live.getState;
    dispatch = live.dispatch;
    stop = () => live.stop();
    on = live.on;
    observe = live.observe;
    subscribe = live.subscribe;
    onBoot = live.onBoot;
  }
  let dispatchError: unknown;
  let completed: { stopSaves: number } | undefined;
  try {
    assert.ok(loaded === null || getState() === loaded);
    const retainedReadySame =
      loaded === null ? "not-applicable" : getState() === loaded;
    const ready = copy(getState());
    const readyEvents = events.length;
    onBoot((state) => log.push(["boot", state.run.phase]));
    subscribe(() => log.push(["change"]));
    observe((msg) => log.push(["observe", msg.type]));
    const removed = on("TurnSettled", () => {
      throw new Error("unsubscribed callback must not run");
    });
    removed();
    on("TurnSettled", () => {
      if (input.scenario === "listener" && !listenerThrown) {
        listenerThrown = true;
        throw callbackError;
      }
    });
    const record = (event: Event) => {
      events.push(event);
      log.push(["event", event.type]);
      collector.onEvent(event);
    };
    on("BrainStarted", record);
    on("TurnSettled", record);
    on("ToolStarted", record);
    on("ToolSettled", record);
    on("ToolFailed", record);
    on("RunDone", record);
    try {
      await dispatch(
        loaded === null
          ? { type: "agent_start", runId: "invoice-run", at: 11 }
          : { type: "agent_boot", at: 15 },
      );
    } catch (error) {
      dispatchError = error;
    }
    const state = getState();
    const snapshot = collector.read();
    const checks = {
      readyNoEvents: readyEvents === 0,
      retainedReadySame,
      turnChecks: events.filter((e) => e.type === "TurnSettled").length,
      originalTurns: events
        .filter((e) => e.type === "TurnSettled")
        .every((e) => turns.includes(e.turn)),
      resultChecks: events.filter((e) => e.type === "ToolSettled").length,
      originalResults: events
        .filter((e) => e.type === "ToolSettled")
        .every((e) => e.result === result),
      argsChecks: events.filter((e) => e.type === "ToolStarted").length,
      originalArgs: events
        .filter((e) => e.type === "ToolStarted")
        .every((e) => [readCall.args, checkCall.args].includes(e.args)),
      payloadChecks: events.filter((e) => e.type === "BrainStarted").length,
      originalPayloads: events
        .filter((e) => e.type === "BrainStarted")
        .every((e) => e.payload === payload),
      callbackCauseSame: reports.every((r) => r.error === callbackError),
      dispatchCauseSame:
        dispatchError === undefined
          ? "not-applicable"
          : dispatchError === saveError ||
            (typeof dispatchError === "object" &&
              dispatchError !== null &&
              "cause" in dispatchError &&
              dispatchError.cause === saveError),
    };
    assert.equal(checks.readyNoEvents, true);
    if (input.scenario === "save") {
      assert.ok(dispatchError);
      assert.equal(checks.dispatchCauseSame, true);
      assert.equal(events.length, 0);
      assert.equal(models, 0);
      assert.equal(tools, 0);
      assert.equal(state.run.phase, "running");
      assert.equal(snapshot.outcome.kind, "running");
    } else {
      assert.equal(dispatchError, undefined);
      assert.equal(state.run.phase, "done");
      assert.equal(models, 5);
      assert.equal(tools, 2);
      assert.equal(snapshot.turns.length, 5);
      assert.equal(snapshot.tools.length, 2);
      assert.equal(snapshot.outcome.kind, "done");
      assert.equal(checks.turnChecks, loaded === null ? 5 : 4);
      assert.equal(checks.resultChecks, 2);
      assert.equal(checks.argsChecks, 2);
      assert.equal(checks.originalTurns, true);
      assert.equal(checks.originalResults, true);
      assert.equal(checks.originalArgs, true);
      assert.equal(checks.originalPayloads, true);
      assert.equal(events.filter((e) => e.type === "RunDone").length, 1);
      assert.equal(
        await readFile(path.join(directory, "checked.txt"), "utf8"),
        "invoice=17:valid\n",
      );
    }
    assert.equal(reports.length, input.scenario === "listener" ? 1 : 0);
    assert.equal(checks.callbackCauseSame, true);
    const output = {
      stopSaves: 0,
      ready,
      state,
      events,
      transcript: snapshot,
      log,
      projectInputs,
      models,
      tools,
      transitionSaves: saves,
      checks,
      reports: reports.map((r) => ({
        phase: r.context.phase,
        error:
          r.error instanceof Error
            ? {
                name: r.error.name,
                message: r.error.message,
                stack: r.error.stack,
              }
            : r.error,
      })),
      dispatchError:
        dispatchError instanceof Error
          ? { name: dispatchError.name, message: dispatchError.message }
          : null,
    };
    completed = output;
    return output;
  } finally {
    const before = saves;
    await stop();
    if (completed !== undefined) completed.stopSaves = saves - before;
  }
}

const output = input.mode === "pure" ? pure() : await runtime();
console.log(JSON.stringify({ input, output }));
