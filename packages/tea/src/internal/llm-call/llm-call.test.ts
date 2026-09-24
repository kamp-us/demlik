import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { defineMachine, Outcome } from "../../index";
import { run } from "../../promise";
import { bindMachine } from "../../testing";
import { deadlineSub } from "../resilience/deadline";
import {
  createLlmCall,
  type LlmCall,
  type LlmErr,
  type LlmFailMsg,
  type LlmOk,
  type LlmRunCmd,
  type LlmSucceedMsg,
  type LlmTimerMsg,
  type ResilientState,
  type Schema,
} from "./index";

// ---------------------------------------------------------------------------
// Fixtures — a two-purpose surface ("plan" | "report") with structural schemas
// (a `parse(value) => T` each). llm-call is pure (ADR 0021): it owns the slice,
// the `Cmd.define`d run Cmd and the parse; invoking a model is the handler the
// host writes, so the wired tests below write one.
// ---------------------------------------------------------------------------

type Purpose = "plan" | "report";

interface PlanOut {
  readonly steps: readonly string[];
}
interface ReportOut {
  readonly score: number;
}
interface Outputs extends Record<Purpose, unknown> {
  readonly plan: PlanOut;
  readonly report: ReportOut;
}

// A schema that delegates to a `check` fn — throws to simulate a zod parse
// failure, otherwise narrows. Lets a test force a structured-output mismatch.
function schema<T>(check: (v: unknown) => T): Schema<T> {
  return { parse: check };
}

const planSchema = schema<PlanOut>((v) => {
  const o = v as PlanOut;
  if (!Array.isArray(o?.steps)) throw new Error("plan: steps not an array");
  return o;
});
const reportSchema = schema<ReportOut>((v) => {
  const o = v as ReportOut;
  if (typeof o?.score !== "number")
    throw new Error("report: score not a number");
  return o;
});

const schemas = { plan: planSchema, report: reportSchema } as const;

// rng pinned to 0 → "full" jitter collapses backoff to exactly 0, so retryAtMs
// == at: deterministic timer targets in assertions.
const rngZero = () => 0;

const retry = {
  baseMs: 100,
  factor: 2,
  capMs: 10_000,
  maxAttempts: 3,
  jitter: "full" as const,
};

const makeLlm = (withRetry = true) =>
  createLlmCall<Purpose, Outputs>(
    withRetry ? { schemas, retry } : { schemas },
    rngZero,
  );

// The run Cmd the knob emits for a call keyed by its purpose.
const runCmd = (input: LlmCall<Purpose>, key: string = input.purpose) =>
  ({ type: "resilient_run", key, input }) as LlmRunCmd<Purpose>;

// The engine-minted success / failure Msgs for a run Cmd.
const okMsg = (
  input: LlmCall<Purpose>,
  output: Outputs[Purpose],
  at: number,
  key: string = input.purpose,
): LlmSucceedMsg<Purpose, Outputs> => ({
  type: "resilient_run_ok",
  cmd: runCmd(input, key),
  value: { key, purpose: input.purpose, output },
  at,
});
const errMsg = (
  input: LlmCall<Purpose>,
  cause: unknown,
  at: number,
  key: string = input.purpose,
): LlmFailMsg<Purpose> => ({
  type: "resilient_run_err",
  cmd: runCmd(input, key),
  error: { _tag: "port_rejected", cause },
  at,
});

describe("createLlmCall — slice + verbs are resilient-call's (composition)", () => {
  it("init produces the resilient-call slice (empty calls, closed breaker)", () => {
    const s = makeLlm().init();
    expect(s.calls).toEqual({});
    expect(s.circuit).toEqual({ phase: "closed", failures: 0 });
    expect(s.retry).toEqual({});
  });

  it("attempt keys the call by purpose by default and emits the run cmd", () => {
    const llm = makeLlm();
    const call: LlmCall<Purpose> = {
      purpose: "plan",
      model: null,
      payload: "j",
    };
    const [s, cmds] = llm.attempt(llm.init(), call, 0);
    expect(cmds).toEqual([{ type: "resilient_run", key: "plan", input: call }]);
    expect(s.calls.plan).toEqual({
      phase: "running",
      input: call,
      // No deadline brick → nothing to spend; the anchor still tracks `at`.
      budget: { remainingMs: 0, chargingSinceMs: 0 },
    });
  });

  it("the run Cmd is Cmd.define'd: the engine mints resilient_run_ok / _err", () => {
    const llm = makeLlm();
    expect(llm.run.cmdType).toBe("resilient_run");
    expect(llm.run.okType).toBe("resilient_run_ok");
    expect(llm.run.errType).toBe("resilient_run_err");
    expect(llm.run.errTags).toContain("port_rejected");
  });

  it("a distinct key fans out two calls of the same purpose independently", () => {
    const llm = makeLlm();
    const a: LlmCall<Purpose> = { purpose: "plan", model: null, payload: "a" };
    const b: LlmCall<Purpose> = { purpose: "plan", model: null, payload: "b" };
    let s = llm.init();
    [s] = llm.attempt(s, a, 0, "plan:a");
    [s] = llm.attempt(s, b, 0, "plan:b");
    expect(Object.keys(s.calls).sort()).toEqual(["plan:a", "plan:b"]);
  });

  it("with a retry brick a failure backs off into waiting_retry (rng-pinned)", () => {
    const llm = makeLlm();
    const call: LlmCall<Purpose> = {
      purpose: "plan",
      model: null,
      payload: "j",
    };
    let s = llm.init();
    [s] = llm.attempt(s, call, 100);
    [s] = llm.fail(s, errMsg(call, new Error("boom"), 100));
    // rngZero → full jitter delay 0 → retryAtMs == at.
    expect(s.calls.plan).toEqual({
      phase: "waiting_retry",
      input: call,
      retryAtMs: 100,
      budget: { remainingMs: 0, chargingSinceMs: 100 },
    });
  });

  it("with NO retry brick the first failure is terminal, carrying the typed LlmErr", () => {
    const llm = makeLlm(false);
    const call: LlmCall<Purpose> = {
      purpose: "plan",
      model: null,
      payload: "j",
    };
    let s = llm.init();
    [s] = llm.attempt(s, call, 0);
    const [s2, cmds] = llm.fail(s, errMsg(call, "x", 0));
    expect(cmds).toEqual([]);
    const err: LlmErr<Purpose> = {
      key: "plan",
      purpose: "plan",
      reason: "x",
      error: "x",
    };
    expect(s2.calls.plan).toEqual({ phase: "failed", error: err });
  });

  it("deadlines arm a retry timer while waiting_retry, and timer counts it down", () => {
    const llm = makeLlm();
    const call: LlmCall<Purpose> = {
      purpose: "report",
      model: null,
      payload: "r",
    };
    let s = llm.init();
    [s] = llm.attempt(s, call, 50);
    expect(llm.deadlines(s)).toEqual([]); // running, no deadline brick → no timers
    expect(llm.timer(s)).toBeNull();
    [s] = llm.fail(s, errMsg(call, "e", 50));
    expect(llm.deadlines(s)).toEqual([
      deadlineSub("resilient:retry:report", 50),
    ]);
    expect(llm.timer(s)).toEqual({
      ms: 0,
      msg: {
        type: "deadline_exceeded",
        id: "resilient:retry:report",
        atMs: 50,
      },
    });
  });

  it("a retry timer re-runs the call for the waiting key", () => {
    const llm = makeLlm();
    const call: LlmCall<Purpose> = {
      purpose: "plan",
      model: null,
      payload: "j",
    };
    let s = llm.init();
    [s] = llm.attempt(s, call, 0);
    [s] = llm.fail(s, errMsg(call, "e", 0));
    expect(s.calls.plan?.phase).toBe("waiting_retry");
    const timer: LlmTimerMsg = {
      type: "deadline_exceeded",
      id: "resilient:retry:plan",
      atMs: 0,
    };
    const [s2, cmds] = llm.onTimer(s, timer);
    expect(cmds).toEqual([{ type: "resilient_run", key: "plan", input: call }]);
    expect(s2.calls.plan?.phase).toBe("running");
  });
});

describe("createLlmCall — decode / rejected / errOf: the pure outcome pieces", () => {
  const llm = makeLlm();

  it("decode parses the model's answer with the purpose schema into an Ok LlmOk", () => {
    const cmd = runCmd({ purpose: "plan", model: null, payload: 0 });
    expect(llm.decode(cmd, { steps: ["a", "b"] })).toEqual({
      _tag: "Ok",
      value: { key: "plan", purpose: "plan", output: { steps: ["a", "b"] } },
    });
  });

  it("decode keys the LlmOk by the Cmd's own key (a fanned-out call keeps its key)", () => {
    const cmd = runCmd({ purpose: "plan", model: null, payload: 0 }, "plan:7");
    const out = llm.decode(cmd, { steps: [] });
    expect(out._tag === "Ok" && out.value.key).toBe("plan:7");
  });

  it("a structured-output mismatch is a port_rejected Err (a failure, not a corrupt success)", () => {
    const cmd = runCmd({ purpose: "report", model: null, payload: 0 });
    const out = llm.decode(cmd, { score: "high" });
    expect(out._tag).toBe("Err");
    if (out._tag === "Err") {
      expect(out.error._tag).toBe("port_rejected");
      expect((out.error.cause as Error).message).toBe(
        "report: score not a number",
      );
    }
  });

  it("rejected wraps a model throw as the declared port_rejected tag", () => {
    const boom = new Error("provider 503");
    expect(llm.rejected(boom)).toEqual(
      Outcome.err({ _tag: "port_rejected", cause: boom }),
    );
  });

  it("errOf reads a minted failure back as the typed, purpose-tagged LlmErr", () => {
    const boom = new Error("provider down");
    const input: LlmCall<Purpose> = {
      purpose: "report",
      model: null,
      payload: 0,
    };
    expect(llm.errOf(errMsg(input, boom, 42))).toEqual({
      key: "report",
      purpose: "report",
      reason: "provider down",
      error: boom,
    });
  });

  it("schemaOf hands back the purpose's configured schema", () => {
    expect(llm.schemaOf("plan")).toBe(schemas.plan);
    expect(llm.schemaOf("report")).toBe(schemas.report);
  });
});

// ---------------------------------------------------------------------------
// Wired into a machine via replay — the run Cmd listed in `cmds`, the minted
// settle Msgs folded by `succeed` / `fail`, the built-in timer armed by `timer`.
// ---------------------------------------------------------------------------

interface HostState {
  readonly resilience: ResilientState<
    LlmCall<Purpose>,
    LlmOk<Purpose, Outputs>
  >;
}
type CallLlm = { type: "call_llm"; input: LlmCall<Purpose>; at: number };

function hostMachine(llm: ReturnType<typeof makeLlm>) {
  return defineMachine({
    types: {
      model: {} as HostState,
      msg: {} as CallLlm | { type: "nop" } | LlmTimerMsg,
      ctx: {} as object,
    },
    cmds: [llm.run],
    init: (loaded) =>
      loaded !== null ? [loaded, []] : [{ resilience: llm.init() }, []],
    update: {
      call_llm: (s, m) => {
        const [slice, cmds] = llm.attempt(s.resilience, m.input, m.at);
        return [{ resilience: slice }, cmds];
      },
      resilient_run_ok: (s, m) => {
        const [slice, cmds] = llm.succeed(s.resilience, m);
        return [{ resilience: slice }, cmds];
      },
      resilient_run_err: (s, m) => {
        const [slice, cmds] = llm.fail(s.resilience, m);
        return [{ resilience: slice }, cmds];
      },
      deadline_exceeded: (s, m) => {
        const [slice, cmds] = llm.onTimer(s.resilience, m);
        return [{ resilience: slice }, cmds];
      },
      nop: (s) => [s, []],
    },
    subs: [{ type: "timer", deps: (s: HostState) => llm.timer(s.resilience) }],
  });
}

describe("createLlmCall — wired in a machine (replay)", () => {
  const llm = makeLlm();
  const bound = bindMachine(hostMachine(llm), {} as object);

  it("a call_llm msg emits the run cmd through the reducer", () => {
    const input: LlmCall<Purpose> = {
      purpose: "plan",
      model: null,
      payload: "j",
    };
    bound.expectCmdSequence({ msgs: [{ type: "call_llm", input, at: 0 }] }, [
      { type: "resilient_run", key: "plan", input },
    ]);
  });

  it("call → ok settles succeeded with the parsed output, no further subs", () => {
    const input: LlmCall<Purpose> = {
      purpose: "plan",
      model: null,
      payload: "j",
    };
    const { state, subs } = bound.replay({
      msgs: [
        { type: "call_llm", input, at: 0 },
        okMsg(input, { steps: ["s"] }, 0),
      ],
    });
    expect(state.resilience.calls.plan).toEqual({
      phase: "succeeded",
      result: { key: "plan", purpose: "plan", output: { steps: ["s"] } },
    });
    expect(subs).toEqual([]);
  });

  it("call → err leaves the built-in retry timer desired at the final state", () => {
    const input: LlmCall<Purpose> = {
      purpose: "report",
      model: null,
      payload: "r",
    };
    const { subs } = bound.replay({
      msgs: [{ type: "call_llm", input, at: 0 }, errMsg(input, "e", 0)],
    });
    expect(subs.map((sub) => sub.type)).toEqual(["timer"]);
    expect(subs[0]?.deps).toEqual({
      ms: 0,
      msg: { type: "deadline_exceeded", id: "resilient:retry:report", atMs: 0 },
    });
  });
});

// ---------------------------------------------------------------------------
// Wired end-to-end through `run()` — the handler the host writes RETURNS an
// outcome, the engine mints the settle Msg, and `succeed` / `fail` drive the
// retry loop. The timer runner is overridden with a no-op and the retry timer
// fired by hand, so the loop is deterministic under rngZero.
// ---------------------------------------------------------------------------

describe("createLlmCall — wired end-to-end: retry loop drives to a terminal phase", () => {
  interface Ledger {
    readonly outcomes: ("ok" | "fail")[];
    readonly calls: { count: number };
  }

  function runWired(ledger: Ledger) {
    const llm = makeLlm();
    const machine = hostMachine(llm);
    return run(machine, {
      ctx: {},
      clock: () => 0,
      interpret: {
        resilient_run: async (cmd) => {
          ledger.calls.count += 1;
          const outcome = ledger.outcomes.shift() ?? "ok";
          if (outcome === "fail")
            return llm.rejected(new Error("provider 503"));
          return llm.decode(cmd, { steps: ["done"] });
        },
      },
      subscribe: { timer: () => () => {} },
    });
  }

  async function drain(
    runtime: {
      dispatch(m: CallLlm | { type: "nop" } | LlmTimerMsg): Promise<void>;
      getState(): HostState;
    },
    ledger: Ledger,
    key: string,
  ): Promise<void> {
    let guard = 0;
    while (guard++ < 50) {
      const before = ledger.calls.count;
      await runtime.dispatch({ type: "nop" });
      const call = runtime.getState().resilience.calls[key];
      if (call?.phase === "waiting_retry") {
        await runtime.dispatch({
          type: "deadline_exceeded",
          id: `resilient:retry:${key}`,
          atMs: call.retryAtMs,
        });
        continue;
      }
      if (ledger.calls.count === before) return;
    }
  }

  it("fail → retry timer → succeed: the slice reaches succeeded and retry[key] resets", async () => {
    const ledger: Ledger = { outcomes: ["fail", "ok"], calls: { count: 0 } };
    const runtime = await runWired(ledger).ready;
    const input: LlmCall<Purpose> = {
      purpose: "plan",
      model: null,
      payload: "j",
    };
    await runtime.dispatch({ type: "call_llm", input, at: 0 });
    await drain(runtime, ledger, "plan");

    expect(runtime.getState().resilience.calls.plan).toEqual({
      phase: "succeeded",
      result: { key: "plan", purpose: "plan", output: { steps: ["done"] } },
    });
    expect(runtime.getState().resilience.retry).toEqual({});
    expect(ledger.calls.count).toBe(2);
    await runtime.stop();
  });

  it("exhausts the retry budget then settles failed with the typed LlmErr", async () => {
    const ledger: Ledger = {
      outcomes: ["fail", "fail", "fail"],
      calls: { count: 0 },
    };
    const runtime = await runWired(ledger).ready;
    const input: LlmCall<Purpose> = {
      purpose: "report",
      model: null,
      payload: "r",
    };
    await runtime.dispatch({ type: "call_llm", input, at: 0 });
    await drain(runtime, ledger, "report");

    const call = runtime.getState().resilience.calls.report;
    expect(call?.phase).toBe("failed");
    if (call?.phase === "failed") {
      const err = call.error as LlmErr<Purpose>;
      expect(err.purpose).toBe("report");
      expect(err.reason).toBe("provider 503");
    }
    expect(ledger.calls.count).toBe(3);
    await runtime.stop();
  });
});

// ---------------------------------------------------------------------------
// Properties — invariants over arbitrary verb sequences.
// ---------------------------------------------------------------------------

describe("createLlmCall — properties", () => {
  const llm = makeLlm();

  it("verbs never mutate their input slice (immutability)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.constantFrom<Purpose>("plan", "report"),
        (at, purpose) => {
          const s0 = Object.freeze(llm.init());
          const input: LlmCall<Purpose> = { purpose, model: null, payload: at };
          const [s1, cmds] = llm.attempt(s0, input, at);
          expect(s1).not.toBe(s0);
          const [s2] = llm.succeed(
            s1,
            okMsg(input, { steps: [] } as never, at),
          );
          expect(s2).not.toBe(s1);
          return Array.isArray(cmds);
        },
      ),
    );
  });

  type Action =
    | { kind: "attempt"; purpose: Purpose; at: number }
    | { kind: "ok"; purpose: Purpose; at: number }
    | { kind: "err"; purpose: Purpose; at: number }
    | { kind: "deadline"; purpose: Purpose; at: number }
    | { kind: "retry"; purpose: Purpose; at: number };

  function step(
    k: ReturnType<typeof makeLlm>,
    s: ReturnType<ReturnType<typeof makeLlm>["init"]>,
    a: Action,
    cause: unknown,
  ) {
    const input: LlmCall<Purpose> = {
      purpose: a.purpose,
      model: null,
      payload: a.at,
    };
    switch (a.kind) {
      case "attempt":
        return k.attempt(s, input, a.at);
      case "ok":
        return k.succeed(s, okMsg(input, { steps: ["done"] } as never, a.at));
      case "err":
        return k.fail(s, errMsg(input, cause, a.at));
      case "deadline":
        return k.onTimer(s, {
          type: "deadline_exceeded",
          id: `resilient:deadline:${a.purpose}`,
          atMs: a.at,
        });
      case "retry":
        return k.onTimer(s, {
          type: "deadline_exceeded",
          id: `resilient:retry:${a.purpose}`,
          atMs: a.at,
        });
    }
  }

  it("at most one run cmd is emitted per verb call (the gate is single-shot)", () => {
    const action = fc.record({
      kind: fc.constantFrom("attempt", "ok", "err", "retry"),
      purpose: fc.constantFrom<Purpose>("plan", "report"),
      at: fc.nat(20_000),
    }) as fc.Arbitrary<Action>;
    fc.assert(
      fc.property(fc.array(action, { maxLength: 30 }), (actions) => {
        let s = llm.init();
        for (const a of actions) {
          const [next, cmds] = step(llm, s, a, "e");
          s = next;
          if (cmds.length > 1) return false;
        }
        return true;
      }),
    );
  });

  // DURABILITY GUARD: every reachable TERMINAL slice round-trips through JSON
  // unchanged. `succeeded` carries the parsed `LlmOk`; `failed` carries the
  // typed `LlmErr` `fail` builds (its `error` is the handler's plain-data
  // cause) or the `{_tag:"deadline_exceeded"}` sentinel.
  it("every reachable terminal slice round-trips through JSON unchanged (durable)", () => {
    const durable = createLlmCall<Purpose, Outputs>(
      { schemas, retry: { ...retry, maxAttempts: 1 } },
      rngZero,
    );
    const TERMINAL = new Set(["succeeded", "failed"]);
    const action = fc.record({
      kind: fc.constantFrom("attempt", "ok", "err", "deadline", "retry"),
      purpose: fc.constantFrom<Purpose>("plan", "report"),
      at: fc.nat(20_000),
    }) as fc.Arbitrary<Action>;

    fc.assert(
      fc.property(fc.array(action, { maxLength: 40 }), (actions) => {
        let s = durable.init();
        for (const a of actions) {
          [s] = step(durable, s, a, { _tag: "provider_error", status: 503 });
          for (const call of Object.values(s.calls)) {
            if (TERMINAL.has(call.phase)) {
              expect(JSON.parse(JSON.stringify(s))).toEqual(s);
            }
          }
        }
        return true;
      }),
    );
  });

  it("a fail-driven `failed` slice carries the typed LlmErr as plain data (durable)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<Purpose>("plan", "report"),
        fc.nat(1_000_000),
        (purpose, at) => {
          const llmNoRetry = makeLlm(false);
          const input: LlmCall<Purpose> = { purpose, model: null, payload: at };
          let s = llmNoRetry.init();
          [s] = llmNoRetry.attempt(s, input, at);
          const cause = { _tag: "provider_error", status: 503 };
          [s] = llmNoRetry.fail(s, errMsg(input, cause, at));
          const call = s.calls[purpose];
          expect(call?.phase).toBe("failed");
          expect(JSON.parse(JSON.stringify(s))).toEqual(s);
          if (call?.phase === "failed") {
            expect(call.error).toEqual({
              key: purpose,
              purpose,
              reason: "[object Object]",
              error: cause,
            });
          }
          return true;
        },
      ),
    );
  });
});
