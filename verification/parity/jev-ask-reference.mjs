import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { Effect, Exit, Scope } from "effect";
import { run as runEffect } from "../../packages/tea/src/effect/index.ts";
import { defineMachine } from "../../packages/tea/src/index.ts";
import {
  createJevAsk,
  decodeJevReply,
} from "../../packages/tea/src/internal/jev/ask/index.ts";
import { runCmdDef } from "../../packages/tea/src/internal/resilience/resilient-call/index.ts";
import { run as runPromise } from "../../packages/tea/src/promise/index.ts";
import { cmdContractOver, Outcome } from "../../packages/tea/src/pure/core.ts";

assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const wire = (value) => JSON.parse(JSON.stringify(value));
const retry = {
  baseMs: 100,
  factor: 2,
  capMs: 1000,
  maxAttempts: 3,
  jitter: "full",
};
function questions() {
  return {
    category: {
      type: "choice",
      instructions: "Which invoice budget?",
      criteria: { freight: "Shipping", office: "Office supplies" },
    },
  };
}
function body() {
  return {
    model: "jev-invoice",
    usage: { input_tokens: 11, output_tokens: 3 },
    answers: {
      category: {
        type: "choice",
        choice: "freight",
        confidence: 0.9,
        probabilities: { freight: 0.9, office: 0.1 },
      },
    },
  };
}
function wireCase(spec) {
  const def = runCmdDef();
  const cmd = def({ key: "invoice:104", input: "invoice" });
  let error;
  if (spec.scenario === "first")
    error = { _tag: "port_rejected", left: "L", right: "R" };
  else if (spec.scenario === "middle")
    error = { left: "L", _tag: "port_rejected", right: "R" };
  else if (spec.scenario === "last")
    error = { left: "L", right: "R", _tag: "port_rejected" };
  else if (spec.scenario === "authority") {
    error = { left: "L", _tag: "deadline_exceeded", right: "R" };
    error._tag = "port_rejected";
  } else if (spec.scenario === "deadline")
    error = { _tag: "deadline_exceeded", left: "L", right: "R" };
  else if (spec.scenario === "jev") {
    const rejected = decodeJevReply(
      { state: "invoice", model: "jev-latest", questions: questions() },
      { status: 401, body: null },
    );
    assert.equal(rejected._tag, "Err");
    error = rejected.error;
  } else throw new Error("unknown wire scenario");
  const edge = cmdContractOver([def], () => 42);
  const msg = edge.settle(cmd, Outcome.err(error));
  assert.equal(msg.error, error);
  edge.checkDispatch(cmd, msg);
  const parsed = JSON.parse(JSON.stringify(error));
  return {
    error: wire(error),
    errorBytes: JSON.stringify(error),
    roundtripBytes: JSON.stringify(parsed),
    message: wire(msg),
    messageBytes: JSON.stringify(msg),
    originalError: true,
  };
}
async function factoryCase(spec) {
  const q = questions();
  const ask = createJevAsk(
    {
      questions: q,
      retry,
      ...(spec.scenario === "named"
        ? { name: "invoice", model: "jev-named" }
        : {}),
    },
    () => 0,
  );
  const queue = {
    retry429: [429, 200],
    terminal401: [401],
    exhaust429: [429, 429, 429],
    thrownRetry: ["throw", 200],
    offline: [],
    named: [200],
  }[spec.scenario];
  assert.ok(queue);
  const frames = [],
    calls = [],
    commands = [],
    outcomes = [],
    settlements = [],
    diagnostics = [];
  const requests = new Set(),
    originalErrors = new Set();
  let initialRequest,
    identityChecks = 0,
    lastRawError;
  const initial = ask.init();
  const machine = defineMachine({
    init: (loaded) => [loaded ?? initial, []],
    cmds: [ask.run],
    update: {
      ask: (state, msg) => {
        const [next, cmds] = ask.attempt(state, msg.key, msg.content, msg.at);
        initialRequest = cmds[0].input;
        requests.add(initialRequest);
        assert.equal(initialRequest.questions, q);
        frames.push({ op: "attempt", state: wire(next), commands: wire(cmds) });
        return [next, cmds];
      },
      [ask.run.okType]: (state, msg) => {
        assert.equal(msg.cmd.input, initialRequest);
        assert.equal(msg.at, spec.stamp);
        const step = ask.succeed(state, msg);
        settlements.push(wire(msg));
        frames.push({
          op: "succeed",
          state: wire(step[0]),
          commands: wire(step[1]),
        });
        return step;
      },
      [ask.run.errType]: (state, msg) => {
        assert.equal(msg.cmd.input, initialRequest);
        assert.equal(msg.error.jev, lastRawError);
        assert.equal(msg.at, spec.stamp);
        originalErrors.add(msg.error.jev);
        const step = ask.fail(state, msg);
        const phase = step[0].calls[spec.key];
        if (phase.phase === "waiting_retry") {
          assert.equal(step[0].retry[spec.key].lastError, msg.error.jev);
        }
        if (phase.phase === "failed") {
          assert.equal(phase.error, msg.error.jev);
          identityChecks++;
        }
        settlements.push(wire(msg));
        frames.push({
          op: "fail",
          state: wire(step[0]),
          commands: wire(step[1]),
        });
        return step;
      },
      [spec.scenario === "named" ? "invoice_deadline" : "deadline_exceeded"]: (
        state,
        msg,
      ) => {
        const step = ask.onTimer(state, msg);
        frames.push({
          op: "timer",
          state: wire(step[0]),
          commands: wire(step[1]),
        });
        return step;
      },
    },
  });
  const handle = (cmd) => {
    assert.equal(cmd.input, initialRequest);
    assert.ok(requests.has(cmd.input));
    assert.equal(cmd.input.questions, q);
    identityChecks++;
    commands.push(wire(cmd));
    let outcome;
    if (spec.scenario === "offline") outcome = ask.offline(cmd.input);
    else {
      const status = queue.shift();
      assert.notEqual(status, undefined);
      calls.push(status);
      outcome =
        status === "throw"
          ? ask.rejected(new Error("socket invoice"))
          : ask.decode(cmd.input, {
              status,
              body: status === 200 ? body() : null,
            });
    }
    if (outcome._tag === "Err") lastRawError = outcome.error.jev;
    outcomes.push(wire(outcome));
    return outcome;
  };
  const onError = (cause) => diagnostics.push(String(cause));
  const drive = async (live, effect) => {
    const invoke = (value) => (effect ? Effect.runPromise(value) : value);
    await invoke(
      live.dispatch({
        type: "ask",
        key: spec.key,
        content: spec.content,
        at: spec.at,
      }),
    );
    await invoke(live.idle());
    for (let guard = 0; guard < 5; guard++) {
      const state = live.getState();
      const deps = ask.timer(state);
      frames.push({
        op: "observe",
        deadlines: wire(ask.deadlines(state)),
        timer: deps ? wire(deps) : null,
      });
      if (state.calls[spec.key].phase !== "waiting_retry") break;
      assert.ok(deps);
      await invoke(live.dispatch(deps.msg));
      await invoke(live.idle());
    }
    const final = live.getState();
    assert.ok(["succeeded", "failed"].includes(final.calls[spec.key].phase));
    return wire(final);
  };
  let state;
  if (spec.profile === "promise") {
    const boot = runPromise(machine, {
      ctx: {},
      clock: () => spec.stamp,
      onError,
      interpret: { [ask.run.cmdType]: async (cmd) => handle(cmd) },
    });
    const live = await boot.ready;
    state = await drive(live, false);
    await live.stop();
  } else {
    const scope = await Effect.runPromise(Scope.make());
    try {
      const boot = await Effect.runPromise(
        Scope.provide(scope)(
          runEffect(machine, {
            ctx: {},
            clock: () => spec.stamp,
            onError,
            interpret: {
              [ask.run.cmdType]: (cmd) =>
                Effect.suspend(() => {
                  const outcome = handle(cmd);
                  return outcome._tag === "Ok"
                    ? Effect.succeed(outcome.value)
                    : Effect.fail(outcome.error);
                }),
            },
          }),
        ),
      );
      state = await drive(await Effect.runPromise(boot.ready), true);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  }
  assert.deepEqual(diagnostics, []);
  return {
    state,
    frames,
    calls,
    commands,
    outcomes,
    settlements,
    identityChecks,
    diagnostics,
  };
}
for await (const line of createInterface({ input: process.stdin })) {
  const spec = JSON.parse(line);
  try {
    const output =
      spec.kind === "wire" ? wireCase(spec) : await factoryCase(spec);
    console.log(JSON.stringify({ id: spec.id, ok: true, output }));
  } catch (cause) {
    console.log(
      JSON.stringify({
        id: spec.id,
        ok: false,
        error: { name: cause.name, message: cause.message, stack: cause.stack },
      }),
    );
    process.exitCode = 1;
  }
}
