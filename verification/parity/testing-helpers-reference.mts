import assert from "node:assert/strict";
import { inspect } from "node:util";
import { z } from "zod";
import { NoCellError, subIdOf } from "../../packages/tea/src/index.js";
import {
  createPoller,
  type PollerState,
} from "../../packages/tea/src/internal/flow/poller/index.js";
import {
  bindMachine,
  expectActiveSubs,
  expectCmdEmitted,
  expectCmdSequence,
  expectFinalState,
  step,
} from "../../packages/tea/src/testing/index.js";
import {
  counterMsg,
  counterState,
  pollerMsg,
  pollerState,
  type TestingHelperScript,
} from "./testing-helpers-cases.mts";
import { normalize, numeric } from "./timing-clock.mts";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function record(value: unknown) {
  assert(object(value));
  return value;
}
export function testingSourceFailure(error: unknown) {
  return {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : undefined,
    ownKeys:
      error !== null &&
      (typeof error === "object" || typeof error === "function")
        ? Reflect.ownKeys(error).map(String)
        : [],
    raw: inspect(error, { depth: null, colors: false, showHidden: true }),
  };
}
export function executeTestingHelper(input: TestingHelperScript) {
  const log: unknown[] = [];
  const calls: string[] = [];
  const cause = {
    phase: input.fail ?? "none",
    code: 17,
    capability: () => true,
  };
  const payload = { id: "shared" };
  const command = (value: unknown) => {
    const v = record(value);
    return { type: z.string().parse(v.name), n: numeric.parse(v.n), payload };
  };
  const sub = (value: unknown) => {
    const v = record(value);
    const name = z.string().parse(v.name);
    const deps =
      name === "deadline"
        ? [
            {
              id: `poller:tick:${numeric.parse(v.at)}`,
              type: "deadline",
              atMs: numeric.parse(v.at),
            },
          ]
        : { n: numeric.parse(v.n) };
    return { id: subIdOf(name, deps), type: name, deps };
  };
  let machine: unknown;
  let loaded: unknown = null;
  let messages: unknown[] = [];
  let state: (v: unknown) => unknown;
  let message: (v: unknown) => unknown;
  let view: (v: unknown) => unknown;
  if (input.scenario === "counter") {
    type State = {
      type: "active" | "done";
      n: number;
      payload: typeof payload;
    };
    type Msg =
      | { type: "add"; by: number }
      | { type: "noop" | "finish" | "unknown" };
    function buildState(raw: unknown): State {
      const v = counterState.parse(raw);
      return {
        type: v.done ? "done" : "active",
        n: numeric.parse(v.n),
        payload,
      };
    }
    function buildMsg(raw: unknown): Msg {
      const v = counterMsg.parse(raw);
      return v.kind === "add"
        ? { type: v.kind, by: numeric.parse(v.by) }
        : { type: v.kind };
    }
    state = buildState;
    message = buildMsg;
    view = normalize;
    loaded = input.loaded ? buildState(input.loaded) : null;
    messages = input.messages.map(buildMsg);
    function cell(s: State, m: Msg) {
      log.push(["cell", s.type, normalize(s.n), m.type]);
      if (input.fail === "update") throw cause;
      if (m.type === "noop") return [s, []];
      if (m.type === "finish") return [{ ...s, type: "done" }, []];
      if (m.type !== "add") throw Error("not a cell");
      const n = s.n + m.by;
      return [{ ...s, n }, [{ type: "added", n, payload }]];
    }
    const row = { add: cell, noop: cell, finish: cell };
    const update =
      input.form === "reducer"
        ? row
        : {
            active:
              input.form === "disambiguated"
                ? Object.assign(function carrier() {
                    throw Error("must honor __form");
                  }, row)
                : row,
            done: row,
          };
    const entries = Array.from({ length: input.subs }, (_, i) => ({
      type: i === 0 ? "a" : "b",
      deps: (s: State) => {
        log.push(["subs", i, s.type, normalize(s.n)]);
        if (input.fail === "subs") throw cause;
        return { n: s.n };
      },
    }));
    const delta = numeric.parse(input.delta);
    machine = {
      init: (saved: State | null) => {
        log.push(["init", saved === null ? null : view(saved)]);
        if (input.fail === "init") throw cause;
        const old = saved ?? { type: "active", n: 0, payload };
        const next = delta === 0 ? old : { ...old, n: old.n + delta };
        return [next, input.boot ? [{ type: "boot", n: next.n, payload }] : []];
      },
      update,
      subs: entries,
    };
    if (input.form !== "reducer")
      Object.defineProperty(machine, "__form", {
        value: "transitions",
        enumerable: false,
      });
  } else {
    type Reading = { status: string };
    type Model = { poll: PollerState<Reading> };
    type Msg =
      | { type: "begin"; at: number }
      | { type: "deadline" | "unknown" }
      | { type: "read"; at: number; value: Reading };
    const readings = {
      pending: { status: "pending" },
      ready: { status: "ready" },
    };
    const fetch = { type: "fetch", n: 0, payload };
    const poll = createPoller<Model, Reading>(
      {
        everyMs: 5,
        until: () => {
          throw Error("consumer supplies untilHeld");
        },
        onTick: () => fetch,
      },
      () => 0.25,
    );
    function buildState(raw: unknown): Model {
      const v = pollerState.parse(raw);
      const common = {
        tick: numeric.parse(v.tick),
        ...(v.last === "none" ? {} : { lastResult: readings[v.last] }),
        retry: { attempt: 0 },
        dedupe: { entries: {}, order: [] },
      };
      return {
        poll:
          v.phase === "polling"
            ? {
                ...common,
                phase: v.phase,
                nextAtMs: v.nextAt === null ? null : numeric.parse(v.nextAt),
              }
            : { ...common, phase: v.phase },
      };
    }
    function buildMsg(raw: unknown): Msg {
      const v = pollerMsg.parse(raw);
      if (v.kind === "begin") return { type: v.kind, at: numeric.parse(v.at) };
      if (v.kind === "read")
        return {
          type: v.kind,
          at: numeric.parse(v.at),
          value: readings[v.value],
        };
      return { type: v.kind };
    }
    state = buildState;
    message = buildMsg;
    view = (raw) => {
      const s = record(raw),
        p = record(s.poll);
      return {
        value: JSON.parse(JSON.stringify(s)),
        lastOwn: Object.hasOwn(p, "lastResult"),
        lastUndefined: p.lastResult === undefined,
        lastRef:
          p.lastResult === readings.pending
            ? "pending"
            : p.lastResult === readings.ready
              ? "ready"
              : null,
      };
    };
    loaded = input.loaded ? buildState(input.loaded) : null;
    messages = input.messages.map(buildMsg);
    function cell(s: Model, m: Msg) {
      log.push(["cell", m.type]);
      if (input.fail === "update") throw cause;
      let next: readonly [PollerState<Reading>, readonly unknown[]];
      switch (m.type) {
        case "begin":
          next = poll.start(s.poll, m.at);
          break;
        case "deadline":
          next = poll.tick(s.poll);
          break;
        case "read":
          next = poll.tickResult(
            s.poll,
            m.value,
            m.at,
            m.value.status === "ready",
          );
          break;
        default:
          throw Error("not a cell");
      }
      return [{ poll: next[0] }, next[1]];
    }
    machine = {
      init: (saved: Model | null) => {
        log.push(["init", saved === null ? null : view(saved)]);
        if (input.fail === "init") throw cause;
        return [saved ?? { poll: poll.init() }, []];
      },
      update: { begin: cell, deadline: cell, read: cell },
      subs: [
        {
          type: "deadline",
          deps: (s: Model) => {
            log.push(["subs"]);
            if (input.fail === "subs") throw cause;
            const ds = poll.subs(s.poll);
            return ds.length === 0 ? null : ds;
          },
        },
      ],
    };
  }
  const ctx = { opaque: payload };
  function call(
    name: string,
    fn: unknown,
    args: unknown[],
    self: unknown = undefined,
  ) {
    assert(typeof fn === "function");
    calls.push(name);
    return Reflect.apply(fn, self, args);
  }
  const operation = input.operation;
  const bound = input.bound
    ? record(call("bindMachine", bindMachine, [machine, ctx]))
    : null;
  let expected: unknown;
  if (operation.kind === "final") expected = state(operation.expected);
  else if (operation.kind === "contains")
    expected = command(operation.expected);
  else if (operation.kind === "commands")
    expected = operation.expected.map(command);
  else if (operation.kind === "subs") expected = operation.expected.map(sub);
  if (input.fail === "matcherError" || input.fail === "matcherPanic") {
    const target = Array.isArray(expected) ? expected[0] : expected;
    assert(object(target));
    const key =
      input.scenario === "counter" && operation.kind === "final"
        ? "n"
        : operation.kind === "final"
          ? "poll"
          : "type";
    Object.defineProperty(target, key, {
      enumerable: true,
      configurable: true,
      get() {
        throw cause;
      },
    });
  }
  try {
    const opts = { loaded, msgs: messages, ctx };
    const boundOpts = { loaded, msgs: messages };
    let result: unknown;
    if (operation.kind === "step") {
      const s = state(operation.state),
        m = message(operation.msg);
      result = bound
        ? call("BoundMachine.step", bound.step, [s, m], bound)
        : call("step", step, [machine, s, m, ctx]);
      assert(Array.isArray(result) && Array.isArray(result[1]));
      return {
        comparison: {
          status: "ok",
          log,
          result: {
            state: view(result[0]),
            commands: normalize(result[1]),
            sameInput: result[0] === s,
            sameSlice:
              input.scenario === "poller"
                ? record(result[0]).poll === record(s).poll
                : null,
          },
        },
        sourceCalls: calls,
      };
    }
    if (operation.kind === "replay") {
      assert(bound);
      result = record(
        call("BoundMachine.replay", bound.replay, [boundOpts], bound),
      );
      const r = record(result);
      return {
        comparison: {
          status: "ok",
          log,
          result: {
            state: view(r.state),
            commands: normalize(r.cmds),
            subs: normalize(r.subs),
            sameLoaded: r.state === loaded,
          },
        },
        sourceCalls: calls,
      };
    }
    const select = {
      final: { free: expectFinalState, name: "expectFinalState" },
      contains: { free: expectCmdEmitted, name: "expectCmdEmitted" },
      commands: { free: expectCmdSequence, name: "expectCmdSequence" },
      subs: { free: expectActiveSubs, name: "expectActiveSubs" },
    }[operation.kind];
    if (bound)
      call(
        `BoundMachine.${select.name}`,
        bound[select.name],
        [boundOpts, expected],
        bound,
      );
    else call(select.name, select.free, [machine, opts, expected]);
    return { comparison: { status: "ok", log }, sourceCalls: calls };
  } catch (error) {
    let comparison: unknown;
    if (error instanceof NoCellError)
      comparison = {
        status: "refusal",
        log,
        error: {
          name: error.name,
          _tag: error._tag,
          message: error.message,
          msgType: error.msgType,
          stateName: error.stateName,
          acceptedTypes: error.acceptedTypes,
        },
      };
    else if (error === cause)
      comparison = {
        status: "callback",
        log,
        sameCause: true,
        cause: { phase: cause.phase, code: cause.code },
      };
    else {
      assert(
        error instanceof Error && error.name === "AssertionError",
        inspect(error),
      );
      comparison = { status: "mismatch", log };
    }
    return {
      comparison,
      sourceCalls: calls,
      sourceDiagnostics: testingSourceFailure(error),
    };
  }
}
