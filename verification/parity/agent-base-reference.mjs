import assert from "node:assert/strict";
import readline from "node:readline";
import {
  agentCancelMsg,
  createAgent,
  status,
} from "../../packages/tea/src/agent/index.ts";
import { foldUpdates } from "../../packages/tea/src/pure/core.ts";

const num = (v) => (v === "nan" ? NaN : v === "infinity" ? Infinity : v);
const wire = (v) => JSON.parse(JSON.stringify(v));
function validate(script) {
  assert.ok(script && typeof script === "object" && !Array.isArray(script));
  assert.ok(
    Object.keys(script).every((k) => ["config", "actions"].includes(k)),
  );
  assert.ok(Array.isArray(script.actions));
  assert.notEqual(script.config, null);
  const config = script.config ?? {};
  assert.ok(config && typeof config === "object" && !Array.isArray(config));
  const configKeys = new Set([
    "stages",
    "instructions",
    "toolConcurrency",
    "deadlineMs",
    "retry",
    "maxTurns",
    "maxElapsedMs",
    "stopAfter",
  ]);
  for (const key of Object.keys(config)) assert.ok(configKeys.has(key));
  if (config.stages !== undefined)
    assert.ok(
      Array.isArray(config.stages) &&
        config.stages.every(
          (s) => s && typeof s === "object" && typeof s.name === "string",
        ),
    );
  if (config.instructions !== undefined)
    assert.equal(typeof config.instructions, "string");
  for (const key of [
    "deadlineMs",
    "retry",
    "maxTurns",
    "maxElapsedMs",
    "stopAfter",
  ])
    if (config[key] !== undefined) assert.equal(typeof config[key], "number");
  if (config.toolConcurrency !== undefined)
    assert.ok(
      typeof config.toolConcurrency === "number" ||
        ["nan", "infinity"].includes(config.toolConcurrency),
    );
  const keys = new Set([
    "op",
    "at",
    "runId",
    "turn",
    "id",
    "result",
    "error",
    "reason",
    "first",
    "usage",
    "legacy",
    "context",
    "instructions",
    "turnCount",
    "profile",
  ]);
  for (const a of script.actions) {
    assert.ok(a && typeof a === "object" && !Array.isArray(a));
    for (const key of Object.keys(a)) assert.ok(keys.has(key));
    assert.ok(
      [
        "start",
        "turn",
        "succeed",
        "fail",
        "toolOk",
        "toolErr",
        "boot",
        "cancel",
        "timer",
        "roundtrip",
        "legacy",
        "optional",
      ].includes(a.op),
    );
    if (!["roundtrip", "legacy", "optional"].includes(a.op))
      assert.equal(typeof a.at, "number");
    if (["turn", "succeed"].includes(a.op)) {
      assert.ok(
        a.turn &&
          typeof a.turn.content === "string" &&
          Array.isArray(a.turn.toolCalls),
      );
      assert.ok(
        Object.keys(a.turn).every((k) =>
          ["content", "toolCalls", "provider", "usage"].includes(k),
        ),
      );
      if (a.turn.usage !== undefined) {
        assert.ok(
          a.turn.usage &&
            typeof a.turn.usage === "object" &&
            !Array.isArray(a.turn.usage),
        );
        assert.ok(
          Object.keys(a.turn.usage).every((k) =>
            [
              "inputTokens",
              "outputTokens",
              "reasoningTokens",
              "cachedInputTokens",
            ].includes(k),
          ),
        );
        for (const k of ["inputTokens", "outputTokens"]) {
          assert.ok(Object.hasOwn(a.turn.usage, k));
        }
        for (const value of Object.values(a.turn.usage))
          assert.ok(typeof value === "number" || value === null);
      }
      assert.ok(
        a.turn.toolCalls.every(
          (c) =>
            c &&
            typeof c.callId === "string" &&
            typeof c.name === "string" &&
            Object.hasOwn(c, "args"),
        ),
      );
    }
    if (["toolOk", "toolErr", "timer"].includes(a.op))
      assert.equal(typeof a.id, "string");
    if (a.op === "toolOk") assert.ok(Object.hasOwn(a, "result"));
    if (a.op === "fail") assert.ok(Object.hasOwn(a, "error"));
    if (a.op === "toolErr")
      assert.ok(Object.hasOwn(a, "error") || typeof a.reason === "string");
    if (a.first !== undefined) assert.equal(typeof a.first, "boolean");
    if (a.op === "legacy") {
      for (const key of ["usage", "legacy"])
        assert.ok(["absent", "undefined", "null", "value"].includes(a[key]));
      assert.ok(["absent", "undefined", "null"].includes(a.context));
      if (a.turnCount !== undefined)
        assert.ok(["null", "nan"].includes(a.turnCount));
      if (a.instructions !== undefined) assert.equal(a.instructions, "absent");
    }
    if (a.op === "toolErr" && Object.hasOwn(a, "error"))
      assert.ok(
        a.error &&
          a.error.kind === "error" &&
          typeof a.error.reason === "string",
      );
    if (a.op === "optional")
      assert.ok(["compacting", "tool-ladder"].includes(a.profile));
  }
}
export function execute(script) {
  validate(script);
  const config = script.config ?? {},
    callbacks = [],
    created = new WeakMap();
  const stages = config.stages ?? [
    { name: "collect" },
    { name: "check" },
    { name: "summarize" },
  ];
  let toolSerial = 0;
  const retainedNotes = [];
  const agent = createAgent({
    stages,
    model: async () => {
      throw new Error("pure probe must not invoke model");
    },
    schemas: Object.fromEntries(
      [...stages.map((s) => s.name), "solo"].map((p) => [
        p,
        { parse: (v) => v },
      ]),
    ),
    instructions: config.instructions,
    modelId: null,
    toolConcurrency: num(config.toolConcurrency ?? 1),
    deadlineMs: config.deadlineMs,
    maxTurns: config.maxTurns,
    maxElapsedMs: config.maxElapsedMs,
    ...(config.retry === undefined
      ? {}
      : {
          retry: {
            baseMs: 10,
            factor: 2,
            capMs: 100,
            maxAttempts: config.retry,
            jitter: "none",
          },
        }),
    rng: () => 0,
    turnOf(stage) {
      callbacks.push(["turnOf", stage?.name ?? null]);
      return stage?.name ?? "solo";
    },
    payloadOf(stage, conv, instructions) {
      callbacks.push([
        "payloadOf",
        stage?.name ?? null,
        conv.turnCount,
        instructions,
      ]);
      return { stage: stage ?? null, turnCount: conv.turnCount, instructions };
    },
    toolOf(call) {
      callbacks.push(["toolOf", call.callId]);
      const cmd = { type: "base_tool", call };
      created.set(cmd, ++toolSerial);
      return cmd;
    },
    ...(config.stopAfter === undefined
      ? {}
      : {
          stopWhen(s) {
            callbacks.push(["stopWhen", s.conversation.turnCount]);
            if (s.lifecycle?.[0]) retainedNotes.push(s.lifecycle[0]);
            return s.conversation.turnCount >= config.stopAfter;
          },
        }),
  });
  let state = agent.init(),
    commands = [],
    lastBrain,
    firstBrain;
  const originalTurns = [],
    results = [],
    failures = [],
    snapshots = [];
  const callRefs = (s) => s.conversation?.turns ?? [];
  function snapshot(action, before, error) {
    for (const cmd of commands)
      if (cmd.type === "resilient_run") {
        lastBrain = cmd;
        firstBrain ??= cmd;
      }
    const conv = state.conversation,
      prior = before?.conversation;
    const ptr = (a, b) => a === b;
    const out = {
      action,
      currentStage: agent.currentStage(state) ?? null,
      currentStageRef: stages.indexOf(agent.currentStage(state)),
      state: wire(state),
      commands: wire(commands),
      callbacks: wire(callbacks.splice(0)),
      toolSources: commands
        .filter((c) => c.type === "base_tool")
        .map((c) => created.get(c)),
      owners: {
        state: ptr(state, before),
        run: ptr(state.run, before?.run),
        resilience: ptr(state.resilience, before?.resilience),
        tools: ptr(state.tools, before?.tools),
        usage: ptr(state.usage, before?.usage),
        conversation: ptr(conv, prior),
        turns: ptr(conv?.turns, prior?.turns),
        records: ptr(conv?.toolRecords, prior?.toolRecords),
        output: ptr(state.output, before?.output),
        failure: ptr(state.failure, before?.failure),
        lifecycle: ptr(state.lifecycle, before?.lifecycle),
      },
      lifecycleRefs: (state.lifecycle ?? []).map((note) =>
        retainedNotes.indexOf(note),
      ),
      turnRefs: callRefs(state).map((t) => originalTurns.indexOf(t)),
      outputRef: originalTurns.indexOf(state.output),
      recordResults: (conv?.toolRecords ?? []).map((r) =>
        r.outcome.kind === "ok" ? results.indexOf(r.outcome.result) : -1,
      ),
      recordFailures: (conv?.toolRecords ?? []).map((r) =>
        r.outcome.kind === "error" ? failures.indexOf(r.outcome) : -1,
      ),
      llmCauseRef:
        state.failure?.reason === "llm"
          ? failures.indexOf(state.failure.error.error)
          : -1,
      settled: agent.isSettled(state),
      deadlines: wire(agent.subs(state)),
      projectedStatus: wire(status(state)),
      ...(error ? { error: { name: error.name, message: error.message } } : {}),
    };
    snapshots.push(out);
  }
  snapshot("init", undefined);
  for (const action of script.actions) {
    const before = state;
    commands = [];
    switch (action.op) {
      case "start":
        [state, commands] = agent.start(state, action.runId ?? "r", action.at);
        break;
      case "turn":
        originalTurns.push(action.turn);
        [state, commands] = agent.turn(state, action.turn, action.at);
        break;
      case "succeed": {
        const cmd = action.first ? firstBrain : lastBrain;
        assert.ok(cmd);
        originalTurns.push(action.turn);
        [state, commands] = agent.succeed(
          state,
          agent.brain.ok(
            cmd,
            { key: cmd.key, purpose: cmd.input.purpose, output: action.turn },
            action.at,
          ),
          action.at,
        );
        break;
      }
      case "fail": {
        const cmd = action.first ? firstBrain : lastBrain;
        assert.ok(cmd);
        failures.push(action.error);
        [state, commands] = agent.fail(
          state,
          agent.brain.err(
            cmd,
            { _tag: "port_rejected", cause: action.error },
            action.at,
          ),
          action.at,
        );
        break;
      }
      case "toolOk":
        results.push(action.result);
        [state, commands] = agent.toolOk(
          state,
          action.id,
          action.result,
          action.at,
        );
        break;
      case "toolErr": {
        const e = action.error ?? action.reason;
        if (action.error) failures.push(e);
        [state, commands] = agent.toolErr(state, action.id, e, action.at);
        if (!action.error) {
          const found = state.conversation?.toolRecords.find(
            (r) => r.call.callId === action.id && r.outcome.kind === "error",
          );
          if (found) failures.push(found.outcome);
        }
        break;
      }
      case "boot":
        [state, commands] = agent.boot(state, action.at);
        break;
      case "cancel": {
        const r = foldUpdates(agent.toMachine().machine, state, [
          agentCancelMsg(action.at),
        ]);
        state = r.state;
        commands = r.cmds;
        break;
      }
      case "timer":
        [state, commands] = agent.onTimer(state, {
          type: "deadline_exceeded",
          id: action.id,
          atMs: action.at,
        });
        break;
      case "roundtrip":
        state = wire(state);
        break;
      case "legacy": {
        state = {
          ...state,
          conversation: state.conversation ? { ...state.conversation } : null,
        };
        const assign = (o, k, v) => {
          if (v === "absent") {
            delete o[k];
            return;
          }
          o[k] =
            v === "undefined"
              ? undefined
              : v === "null"
                ? null
                : v === "nan"
                  ? NaN
                  : v;
        };

        assign(
          state,
          "usage",
          action.usage === "value"
            ? { inputTokens: null, outputTokens: 2 }
            : action.usage,
        );
        if (state.conversation) {
          assign(
            state.conversation,
            "usage",
            action.legacy === "value"
              ? { inputTokens: 4, outputTokens: 3 }
              : action.legacy,
          );
          assign(state.conversation, "contextTokens", action.context);
          assign(state.conversation, "turnCount", action.turnCount ?? 0);
        }
        if (action.instructions)
          assign(state, "instructions", action.instructions);
        break;
      }
      case "optional":
        state = {
          ...state,
          conversation: {
            ...state.conversation,
            awaiting:
              action.profile === "compacting"
                ? { kind: "compacting", folding: 2 }
                : { kind: "tools", batchTurn: 0 },
          },
          ...(action.profile === "tool-ladder"
            ? { toolResilience: { scan: { ...state.compaction } } }
            : {}),
        };
        break;
      default:
        throw new Error(`unknown op ${action.op}`);
    }
    snapshot(action.op, before);
  }
  return { snapshots };
}
if (process.argv[1]?.endsWith("agent-base-reference.mjs")) {
  const lines = readline.createInterface({ input: process.stdin });
  for await (const line of lines) {
    try {
      const f = JSON.parse(line);
      assert.ok(Object.keys(f).every((k) => ["id", "script"].includes(k)));
      assert.equal(typeof f.id, "string");
      assert.ok(f.script && Array.isArray(f.script.actions));
      const output = execute(f.script);
      process.stdout.write(
        `${JSON.stringify({ id: f.id, ok: true, output })}\n`,
      );
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({
          ok: false,
          error: { name: error.name, message: error.message },
        })}\n`,
      );
    }
  }
}
