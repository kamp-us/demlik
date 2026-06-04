import * as fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineMachine, run } from "../index";
import { bindMachine } from "../testing";
import {
  createLlmCall,
  deadlineSub,
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
// (a `parse(value) => T` each) and a fake model whose `withStructuredOutput`
// returns whatever the per-test invoke stub produces. Mirrors the seed's
// brain-only path (plan / report via `withStructuredOutput`).
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

type Message = { readonly role: string; readonly text: string };

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

// A fake model factory. `invoke` is supplied per test so a spec controls what
// the structured-output runnable resolves to (or whether it throws).
function fakeModel(invoke: (messages: readonly Message[]) => Promise<unknown>) {
  return () => ({
    withStructuredOutput<T>(_s: Schema<T>) {
      return { invoke: invoke as (m: readonly Message[]) => Promise<T> };
    },
  });
}

// A loader that records the call it saw and returns one message per purpose.
function loaderOf(seen: LlmCall<Purpose>[]) {
  return async (call: LlmCall<Purpose>): Promise<readonly Message[]> => {
    seen.push(call);
    return [{ role: "user", text: `${call.purpose}:${String(call.payload)}` }];
  };
}

// rng pinned to 0 → "full" jitter collapses backoff to exactly 0, so retryAtMs
// == at: deterministic timer targets in assertions (same trick as the
// resilient-call gold-standard test).
const rngZero = () => 0;

const retry = {
  baseMs: 100,
  factor: 2,
  capMs: 10_000,
  maxAttempts: 3,
  jitter: "full" as const,
};

describe("createLlmCall — slice + verbs are resilient-call's (composition)", () => {
  it("init produces the resilient-call slice (empty calls, closed breaker)", () => {
    const llm = createLlmCall<Purpose, Outputs, Message>(
      { model: fakeModel(async () => ({ steps: [] })), schemas, retry },
      rngZero,
    );
    const s = llm.init();
    expect(s.calls).toEqual({});
    expect(s.circuit).toEqual({ phase: "closed", failures: 0 });
    expect(s.retry).toEqual({});
  });

  it("attempt keys the call by purpose by default and emits the run cmd", () => {
    const llm = createLlmCall<Purpose, Outputs, Message>(
      { model: fakeModel(async () => ({ steps: [] })), schemas, retry },
      rngZero,
    );
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
      deadlineAtMs: 0, // no deadline brick → 0
    });
  });

  it("a distinct key fans out two calls of the same purpose independently", () => {
    const llm = createLlmCall<Purpose, Outputs, Message>(
      { model: fakeModel(async () => ({ steps: [] })), schemas, retry },
      rngZero,
    );
    const a: LlmCall<Purpose> = { purpose: "plan", model: null, payload: "a" };
    const b: LlmCall<Purpose> = { purpose: "plan", model: null, payload: "b" };
    let s = llm.init();
    [s] = llm.attempt(s, a, 0, "plan:a");
    [s] = llm.attempt(s, b, 0, "plan:b");
    expect(Object.keys(s.calls).sort()).toEqual(["plan:a", "plan:b"]);
  });

  it("with a retry brick a failure backs off into waiting_retry (rng-pinned)", () => {
    const llm = createLlmCall<Purpose, Outputs, Message>(
      { model: fakeModel(async () => ({ steps: [] })), schemas, retry },
      rngZero,
    );
    const call: LlmCall<Purpose> = {
      purpose: "plan",
      model: null,
      payload: "j",
    };
    let s = llm.init();
    [s] = llm.attempt(s, call, 100);
    const err: LlmErr<Purpose> = {
      key: "plan",
      purpose: "plan",
      reason: "boom",
      error: new Error("boom"),
    };
    const fail: LlmFailMsg<Purpose> = {
      type: "resilient_err",
      key: "plan",
      error: err,
      at: 100,
    };
    [s] = llm.fail(s, "plan", fail);
    // rngZero → full jitter delay 0 → retryAtMs == at.
    expect(s.calls.plan).toEqual({
      phase: "waiting_retry",
      input: call,
      retryAtMs: 100,
      deadlineAtMs: 0,
    });
  });

  it("with NO retry brick the first failure is terminal (omit a brick, omit its gate)", () => {
    const llm = createLlmCall<Purpose, Outputs, Message>(
      { model: fakeModel(async () => ({ steps: [] })), schemas },
      rngZero,
    );
    const call: LlmCall<Purpose> = {
      purpose: "plan",
      model: null,
      payload: "j",
    };
    let s = llm.init();
    [s] = llm.attempt(s, call, 0);
    const err: LlmErr<Purpose> = {
      key: "plan",
      purpose: "plan",
      reason: "x",
      error: "x",
    };
    const [s2, cmds] = llm.fail(s, "plan", {
      type: "resilient_err",
      key: "plan",
      error: err,
      at: 0,
    });
    expect(cmds).toEqual([]);
    expect(s2.calls.plan).toEqual({ phase: "failed", error: err });
  });

  it("subs arm a retry timer while waiting_retry (inherited from resilient-call)", () => {
    const llm = createLlmCall<Purpose, Outputs, Message>(
      { model: fakeModel(async () => ({ steps: [] })), schemas, retry },
      rngZero,
    );
    const call: LlmCall<Purpose> = {
      purpose: "report",
      model: null,
      payload: "r",
    };
    let s = llm.init();
    [s] = llm.attempt(s, call, 50);
    expect(llm.subs(s)).toEqual([]); // running, no deadline brick → no timers
    [s] = llm.fail(s, "report", {
      type: "resilient_err",
      key: "report",
      error: { key: "report", purpose: "report", reason: "e", error: "e" },
      at: 50,
    });
    expect(llm.subs(s)).toEqual([deadlineSub("resilient:retry:report", 50)]);
  });

  it("a retry timer re-runs the call's invoke for the waiting key", () => {
    const llm = createLlmCall<Purpose, Outputs, Message>(
      { model: fakeModel(async () => ({ steps: [] })), schemas, retry },
      rngZero,
    );
    const call: LlmCall<Purpose> = {
      purpose: "plan",
      model: null,
      payload: "j",
    };
    let s = llm.init();
    [s] = llm.attempt(s, call, 0);
    [s] = llm.fail(s, "plan", {
      type: "resilient_err",
      key: "plan",
      error: { key: "plan", purpose: "plan", reason: "e", error: "e" },
      at: 0,
    });
    expect(s.calls.plan.phase).toBe("waiting_retry");
    const timer: LlmTimerMsg = {
      type: "deadline_exceeded",
      id: "resilient:retry:plan",
      atMs: 0,
    };
    const [s2, cmds] = llm.onTimer(s, timer);
    expect(cmds).toEqual([{ type: "resilient_run", key: "plan", input: call }]);
    expect(s2.calls.plan.phase).toBe("running");
  });
});

describe("createLlmCall — invokeOne: structured-output parse + purpose branch", () => {
  it("assembles messages via the loader, binds the purpose schema, parses the output", async () => {
    const seen: LlmCall<Purpose>[] = [];
    const llm = createLlmCall<Purpose, Outputs, Message>(
      {
        model: fakeModel(async () => ({ steps: ["a", "b"] })),
        schemas,
        retry,
        loadMessages: loaderOf(seen),
      },
      rngZero,
    );
    const call: LlmCall<Purpose> = {
      purpose: "plan",
      model: "gemini",
      payload: "go",
    };
    const ok = await llm.invokeOne(call);
    expect(ok).toEqual({
      key: "plan",
      purpose: "plan",
      output: { steps: ["a", "b"] },
    });
    // The loader saw the full call (so it can branch on purpose, like the seed).
    expect(seen).toEqual([call]);
  });

  it("invokes with [] when no loadMessages port is configured", async () => {
    let sawMessages: readonly Message[] | null = null;
    const llm = createLlmCall<Purpose, Outputs, Message>(
      {
        model: fakeModel(async (messages) => {
          sawMessages = messages;
          return { score: 9 };
        }),
        schemas,
        retry,
      },
      rngZero,
    );
    const ok = await llm.invokeOne({
      purpose: "report",
      model: null,
      payload: 1,
    });
    expect(ok.output).toEqual({ score: 9 });
    expect(sawMessages).toEqual([]);
  });

  it("a structured-output mismatch throws (parse failure is a failure, not a corrupt success)", async () => {
    const llm = createLlmCall<Purpose, Outputs, Message>(
      // Model resolves a shape the report schema rejects (score not a number).
      { model: fakeModel(async () => ({ score: "high" })), schemas, retry },
      rngZero,
    );
    await expect(
      llm.invokeOne({ purpose: "report", model: null, payload: 0 }),
    ).rejects.toThrow("report: score not a number");
  });

  it("a model throw propagates out of invokeOne (so resilient-call can back off)", async () => {
    const boom = new Error("provider 503");
    const llm = createLlmCall<Purpose, Outputs, Message>(
      {
        model: fakeModel(async () => {
          throw boom;
        }),
        schemas,
        retry,
      },
      rngZero,
    );
    await expect(
      llm.invokeOne({ purpose: "plan", model: null, payload: 0 }),
    ).rejects.toBe(boom);
  });
});

describe("createLlmCall — handlers: RETURN the enriched resilient settle Msg (re-entry)", () => {
  // The handler is an `interpret` cell — it RETURNS a settle Msg the substrate
  // enqueues as a follow-up (re-entry) into the host reducer. It must NOT
  // dispatch the consumer's Msg directly: returning the settle Msg is what makes
  // the host's `resilient_ok` / `resilient_err` arms run `succeed` / `fail`,
  // which drives the inherited backoff loop. These tests pin the returned Msg
  // shape; the wired block below proves the end-to-end loop.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function callHandler(
    llm: ReturnType<typeof createLlmCall<Purpose, Outputs, Message>>,
    cmd: LlmRunCmd<Purpose>,
  ) {
    // `now` is read at the effect boundary (the resilient handler stamps `at`).
    vi.spyOn(Date, "now").mockReturnValue(42);
    return llm.handlers().resilient_run(cmd);
  }

  it("returns a resilient_ok Msg carrying the parsed LlmOk on success", async () => {
    const llm = createLlmCall<Purpose, Outputs, Message>(
      { model: fakeModel(async () => ({ steps: ["x"] })), schemas, retry },
      rngZero,
    );
    const msg = await callHandler(llm, {
      type: "resilient_run",
      key: "plan",
      input: { purpose: "plan", model: null, payload: 0 },
    });
    expect(msg).toEqual({
      type: "resilient_ok",
      key: "plan",
      result: { key: "plan", purpose: "plan", output: { steps: ["x"] } },
      at: 42,
    });
  });

  it("returns a resilient_err Msg carrying the typed LlmErr on a model throw", async () => {
    const boom = new Error("provider down");
    const llm = createLlmCall<Purpose, Outputs, Message>(
      {
        model: fakeModel(async () => {
          throw boom;
        }),
        schemas,
        retry,
      },
      rngZero,
    );
    const msg = (await callHandler(llm, {
      type: "resilient_run",
      key: "report",
      input: { purpose: "report", model: null, payload: 0 },
    })) as LlmFailMsg<Purpose>;
    expect(msg.type).toBe("resilient_err");
    expect(msg.key).toBe("report");
    expect(msg.at).toBe(42);
    // The raw throw is enriched into the typed LlmErr (purpose + reason + raw).
    expect(msg.error).toEqual({
      key: "report",
      purpose: "report",
      reason: "provider down",
      error: boom,
    });
  });

  it("returns a resilient_err on a schema parse mismatch (parse failure surfaces, not stalls)", async () => {
    const llm = createLlmCall<Purpose, Outputs, Message>(
      { model: fakeModel(async () => ({ score: "nope" })), schemas, retry },
      rngZero,
    );
    const msg = (await callHandler(llm, {
      type: "resilient_run",
      key: "report",
      input: { purpose: "report", model: null, payload: 0 },
    })) as LlmFailMsg<Purpose>;
    expect(msg.type).toBe("resilient_err");
    expect(msg.error.purpose).toBe("report");
    expect(msg.error.reason).toBe("report: score not a number");
  });
});

// ---------------------------------------------------------------------------
// Wired into a machine via replay — proves the knob splices into a host's
// reducer / subs exactly like the resilient-call gold standard.
// ---------------------------------------------------------------------------

describe("createLlmCall — wired in a machine (replay)", () => {
  interface HostState {
    readonly resilience: ResilientState<
      LlmCall<Purpose>,
      LlmOk<Purpose, Outputs>
    >;
  }
  type HostMsg =
    | { type: "call_llm"; input: LlmCall<Purpose>; at: number }
    | LlmSucceedMsg<Purpose, Outputs>
    | LlmFailMsg<Purpose>
    | LlmTimerMsg;
  type HostCmd = LlmRunCmd<Purpose>;

  const llm = createLlmCall<Purpose, Outputs, Message>(
    { model: fakeModel(async () => ({ steps: [] })), schemas, retry },
    rngZero,
  );
  const machine = defineMachine<
    HostState,
    HostMsg,
    HostCmd,
    ReturnType<typeof llm.subs>[number],
    object
  >({
    init: (loaded) =>
      loaded !== null ? [loaded, []] : [{ resilience: llm.init() }, []],
    update: {
      call_llm: (s, m) => {
        const [slice, cmds] = llm.attempt(s.resilience, m.input, m.at);
        return [{ resilience: slice }, cmds];
      },
      resilient_ok: (s, m) => {
        const [slice, cmds] = llm.succeed(s.resilience, m.key, m);
        return [{ resilience: slice }, cmds];
      },
      resilient_err: (s, m) => {
        const [slice, cmds] = llm.fail(s.resilience, m.key, m);
        return [{ resilience: slice }, cmds];
      },
      deadline_exceeded: (s, m) => {
        const [slice, cmds] = llm.onTimer(s.resilience, m);
        return [{ resilience: slice }, cmds];
      },
    },
    subscriptions: (s) => llm.subs(s.resilience),
    subscribe: { deadline: () => () => {} },
  });
  const bound = bindMachine(machine, {} as object);

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
    const out: LlmOk<Purpose, Outputs> = {
      key: "plan",
      purpose: "plan",
      output: { steps: ["s"] },
    };
    const { state, subs } = bound.replay({
      msgs: [
        { type: "call_llm", input, at: 0 },
        { type: "resilient_ok", key: "plan", result: out, at: 0 },
      ],
    });
    expect(state.resilience.calls.plan).toEqual({
      phase: "succeeded",
      result: out,
    });
    expect(subs).toEqual([]);
  });

  it("call → err leaves a retry timer desired at the final state", () => {
    const input: LlmCall<Purpose> = {
      purpose: "report",
      model: null,
      payload: "r",
    };
    bound.expectActiveSubs(
      {
        msgs: [
          { type: "call_llm", input, at: 0 },
          {
            type: "resilient_err",
            key: "report",
            error: {
              key: "report",
              purpose: "report",
              reason: "e",
              error: "e",
            },
            at: 0,
          },
        ],
      },
      [deadlineSub("resilient:retry:report", 0)],
    );
  });
});

// ---------------------------------------------------------------------------
// Wired end-to-end through `run()` + `interpret` re-entry — the systemic test
// the suite was missing, and exactly why the retry-loop-dead bug shipped green.
//
// The replay block above hand-feeds `resilient_ok` / `resilient_err` Msgs and
// asserts the Cmds those exact Msgs emit. It never runs the REAL dispatch
// lifecycle, so it could not see that `handlers` failed to RE-ENTER those Msgs
// into the reducer — the slice stays stuck at `running`, retry never fires.
//
// Here we build an actual `run()` Runtime from the knob's verbs + the REAL
// `interpret` handler and drive: attempt → (Cmd) resilient_run → invokeOne →
// (follow-up Msg) resilient_err → fail → waiting_retry → retry timer →
// (Cmd) resilient_run → invokeOne → resilient_ok → succeed. We assert the END
// STATE: `succeeded` with the parsed output, and `retry[key]` reset to empty.
//
// Pre-fix (`handlers` dispatched the consumer's enriched Msg directly via
// `ctx.dispatch` instead of RETURNING the settle Msg): the settle never
// re-enters, so `fail` / `succeed` never run. The first invoke fails, the slice
// is wedged at `running`, no retry timer is armed, the retry counter never
// resets — `calls.plan.phase` is `running`, NOT `succeeded`. The assertions
// below FAIL against that code and PASS after the fix.
// ---------------------------------------------------------------------------

describe("createLlmCall — wired end-to-end: retry loop drives to succeeded (defect 1)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  interface WState {
    readonly resilience: ResilientState<
      LlmCall<Purpose>,
      LlmOk<Purpose, Outputs>
    >;
  }
  type WMsg =
    | { type: "call_llm"; input: LlmCall<Purpose>; at: number }
    | { type: "nop" }
    | LlmSucceedMsg<Purpose, Outputs>
    | LlmFailMsg<Purpose>
    | LlmTimerMsg;
  type WCmd = LlmRunCmd<Purpose>;

  // The backend ledger: a queue of per-invoke outcomes the fake model pops, plus
  // a hit counter — the ground-truth "did the invoke actually run".
  interface WCtx {
    readonly outcomes: ("ok" | "fail")[];
    readonly calls: { count: number };
  }

  function wiredMachine(ctx: WCtx) {
    const llm = createLlmCall<Purpose, Outputs, Message>(
      {
        // The fake model pops one outcome per invoke. "fail" throws (a transient
        // provider error → resilient-call backs off); "ok" resolves the parsed
        // shape. The counter is the ground-truth invoke ledger.
        model: () => ({
          withStructuredOutput<T>(_s: Schema<T>) {
            return {
              async invoke(): Promise<T> {
                ctx.calls.count += 1;
                const outcome = ctx.outcomes.shift() ?? "ok";
                if (outcome === "fail") throw new Error("provider 503");
                return { steps: ["done"] } as unknown as T;
              },
            };
          },
        }),
        schemas,
        retry,
      },
      rngZero,
    );
    const machine = defineMachine<
      WState,
      WMsg,
      WCmd,
      ReturnType<typeof llm.subs>[number],
      WCtx
    >({
      init: (loaded) =>
        loaded !== null ? [loaded, []] : [{ resilience: llm.init() }, []],
      update: {
        call_llm: (s, m) => {
          const [slice, cmds] = llm.attempt(s.resilience, m.input, m.at);
          return [{ resilience: slice }, cmds];
        },
        resilient_ok: (s, m) => {
          const [slice, cmds] = llm.succeed(s.resilience, m.key, m);
          return [{ resilience: slice }, cmds];
        },
        resilient_err: (s, m) => {
          const [slice, cmds] = llm.fail(s.resilience, m.key, m);
          return [{ resilience: slice }, cmds];
        },
        deadline_exceeded: (s, m) => {
          const [slice, cmds] = llm.onTimer(s.resilience, m);
          return [{ resilience: slice }, cmds];
        },
        nop: (s) => [s, []],
      },
      subscriptions: (s) => llm.subs(s.resilience),
      // Subs are reconciled but their firing is hand-driven by `drain` below.
      // Driving the retry timer by hand (rather than from the Sub fanout) keeps
      // the loop deterministic under rngZero, where every retry re-arms the SAME
      // sub id at the SAME atMs (0) — the substrate sees no churn, so a
      // Sub-fanout would fire only once. The verbs + handler re-entry under test
      // are unchanged; only the wall-clock that fires the timer is faked.
      subscribe: { deadline: () => () => {} },
      // The REAL handler — returns the enriched settle Msg, which the runtime
      // enqueues as a follow-up Msg (re-entry) into the reducer.
      interpret: llm.handlers(),
    });
    return machine;
  }

  // Drive the full lifecycle to a fixed point. Each `dispatch` settles only its
  // own transition; the settle Msg the REAL handler returns re-enters on the
  // tail. After each step we (a) pump `nop` to flush any pending re-entry, then
  // (b) if a call sits in `waiting_retry`, fire its retry timer Msg by hand —
  // the verb path resilient-call's `subs` would otherwise drive. Loop until the
  // invoke ledger AND the desired subs both stop changing.
  async function drain(
    runtime: {
      dispatch(m: WMsg): Promise<void>;
      getState(): WState;
    },
    ctx: WCtx,
    key: string,
  ): Promise<void> {
    let guard = 0;
    while (guard++ < 50) {
      const before = ctx.calls.count;
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
      // No pending retry; if the ledger also held steady, we've settled.
      if (ctx.calls.count === before) return;
    }
  }

  it("fail → retry timer → succeed: the slice reaches succeeded and retry[key] resets", async () => {
    vi.spyOn(Date, "now").mockReturnValue(0);
    const ctx: WCtx = { outcomes: ["fail", "ok"], calls: { count: 0 } };
    const runtime = run(wiredMachine(ctx), { ctx });
    await runtime.ready;

    const input: LlmCall<Purpose> = {
      purpose: "plan",
      model: null,
      payload: "j",
    };
    await runtime.dispatch({ type: "call_llm", input, at: 0 });
    await drain(runtime, ctx, "plan");

    // END STATE — the systemic assertion: the retry loop actually ran.
    // The first invoke failed → backoff → retry timer → second invoke succeeded.
    expect(runtime.getState().resilience.calls.plan).toEqual({
      phase: "succeeded",
      result: { key: "plan", purpose: "plan", output: { steps: ["done"] } },
    });
    // The retry counter for this key is dropped on success (the run ended).
    expect(runtime.getState().resilience.retry).toEqual({});
    // Both invokes actually reached the backend — proof the loop drove a retry,
    // not a single bypassed invoke.
    expect(ctx.calls.count).toBe(2);

    await runtime.stop();
  });

  it("exhausts the retry budget then settles failed (the loop terminates, not stalls)", async () => {
    vi.spyOn(Date, "now").mockReturnValue(0);
    // maxAttempts 3 → three invokes all fail → the call settles `failed`.
    const ctx: WCtx = {
      outcomes: ["fail", "fail", "fail"],
      calls: { count: 0 },
    };
    const runtime = run(wiredMachine(ctx), { ctx });
    await runtime.ready;

    const input: LlmCall<Purpose> = {
      purpose: "report",
      model: null,
      payload: "r",
    };
    await runtime.dispatch({ type: "call_llm", input, at: 0 });
    await drain(runtime, ctx, "report");

    const call = runtime.getState().resilience.calls.report;
    expect(call.phase).toBe("failed");
    // The terminal error is the typed LlmErr the handler enriched.
    if (call.phase === "failed") {
      const err = call.error as LlmErr<Purpose>;
      expect(err.purpose).toBe("report");
      expect(err.reason).toBe("provider 503");
    }
    expect(ctx.calls.count).toBe(3);

    await runtime.stop();
  });
});

// ---------------------------------------------------------------------------
// Properties — invariants over arbitrary verb sequences (inherited from
// resilient-call's slice, re-asserted at the llm-call surface).
// ---------------------------------------------------------------------------

describe("createLlmCall — properties", () => {
  const llm = createLlmCall<Purpose, Outputs, Message>(
    { model: fakeModel(async () => ({ steps: [] })), schemas, retry },
    rngZero,
  );

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
          const [s2] = llm.succeed(s1, purpose, {
            type: "resilient_ok",
            key: purpose,
            result: { key: purpose, purpose, output: { steps: [] } as never },
            at,
          });
          expect(s2).not.toBe(s1);
          return Array.isArray(cmds);
        },
      ),
    );
  });

  it("at most one run cmd is emitted per verb call (the gate is single-shot)", () => {
    type Action =
      | { kind: "attempt"; purpose: Purpose; at: number }
      | { kind: "ok"; purpose: Purpose; at: number }
      | { kind: "err"; purpose: Purpose; at: number }
      | { kind: "retry"; purpose: Purpose; at: number };
    const action = fc.record({
      kind: fc.constantFrom("attempt", "ok", "err", "retry"),
      purpose: fc.constantFrom<Purpose>("plan", "report"),
      at: fc.nat(20_000),
    }) as fc.Arbitrary<Action>;
    fc.assert(
      fc.property(fc.array(action, { maxLength: 30 }), (actions) => {
        let s = llm.init();
        for (const a of actions) {
          let cmds: readonly LlmRunCmd<Purpose>[] = [];
          const input: LlmCall<Purpose> = {
            purpose: a.purpose,
            model: null,
            payload: a.at,
          };
          switch (a.kind) {
            case "attempt":
              [s, cmds] = llm.attempt(s, input, a.at);
              break;
            case "ok":
              [s, cmds] = llm.succeed(s, a.purpose, {
                type: "resilient_ok",
                key: a.purpose,
                result: {
                  key: a.purpose,
                  purpose: a.purpose,
                  output: { steps: [] } as never,
                },
                at: a.at,
              });
              break;
            case "err":
              [s, cmds] = llm.fail(s, a.purpose, {
                type: "resilient_err",
                key: a.purpose,
                error: {
                  key: a.purpose,
                  purpose: a.purpose,
                  reason: "e",
                  error: "e",
                },
                at: a.at,
              });
              break;
            case "retry":
              [s, cmds] = llm.onTimer(s, {
                type: "deadline_exceeded",
                id: `resilient:retry:${a.purpose}`,
                atMs: a.at,
              });
              break;
          }
          if (cmds.length > 1) return false;
        }
        return true;
      }),
    );
  });

  // -------------------------------------------------------------------------
  // DURABILITY GUARD (package-wide invariant, llm-call's share).
  //
  // Every reachable TERMINAL slice must round-trip through JSON unchanged:
  // `JSON.parse(JSON.stringify(slice))` deep-equals `slice`. The slice is
  // resilient-call's, but llm-call ENRICHES the payloads that land in the
  // terminal phases — `LlmOk` on `succeeded`, `LlmErr` on `fail`-driven
  // `failed`, and the `{_tag}` deadline sentinel on timer-driven `failed`.
  // This guards the canon: those enriched payloads must be plain data (no
  // `new Error(...)` on `LlmErr.error`, no `undefined`, no function/closure),
  // or the persisted slice would diverge from the in-memory one across a DO
  // eviction/reload.
  //
  // The reachable terminal `CallPhase`s for THIS knob (llm-call forwards only
  // the `retry` brick — no circuit / rate-limit / cache / deadline knob — so
  // `circuit_open` is unreachable here; only these two settle):
  //   - `succeeded` — carries the parsed `LlmOk` (succeed verb).
  //   - `failed`    — carries the typed `LlmErr` (fail verb, no retry left) OR
  //                   the `{_tag:"deadline_exceeded"}` sentinel (onTimer
  //                   deadline branch).
  // We drive arbitrary verb sequences across two purposes and assert the
  // round-trip on the WHOLE slice whenever a key reaches a terminal phase, so
  // the property fails if any enrichment ever lands a non-serializable value.
  // -------------------------------------------------------------------------
  it("every reachable terminal slice round-trips through JSON unchanged (durable)", () => {
    // maxAttempts 1 → the first failure exhausts the budget and settles
    // `failed`; rngZero pins backoff so timer targets are deterministic.
    const durable = createLlmCall<Purpose, Outputs, Message>(
      {
        model: fakeModel(async () => ({ steps: [] })),
        schemas,
        retry: { ...retry, maxAttempts: 1 }, // exhaust fast → reach `failed`
      },
      rngZero,
    );
    const TERMINAL = new Set(["succeeded", "failed"]);

    type Action =
      | { kind: "attempt"; purpose: Purpose; at: number }
      | { kind: "ok"; purpose: Purpose; at: number }
      | { kind: "err"; purpose: Purpose; at: number }
      | { kind: "deadline"; purpose: Purpose; at: number }
      | { kind: "retry"; purpose: Purpose; at: number };
    const action = fc.record({
      kind: fc.constantFrom("attempt", "ok", "err", "deadline", "retry"),
      purpose: fc.constantFrom<Purpose>("plan", "report"),
      at: fc.nat(20_000),
    }) as fc.Arbitrary<Action>;

    fc.assert(
      fc.property(fc.array(action, { maxLength: 40 }), (actions) => {
        let s = durable.init();
        for (const a of actions) {
          const input: LlmCall<Purpose> = {
            purpose: a.purpose,
            model: null,
            payload: a.at,
          };
          switch (a.kind) {
            case "attempt":
              [s] = durable.attempt(s, input, a.at);
              break;
            case "ok":
              [s] = durable.succeed(s, a.purpose, {
                type: "resilient_ok",
                key: a.purpose,
                result: {
                  key: a.purpose,
                  purpose: a.purpose,
                  output: { steps: ["done"] } as never,
                },
                at: a.at,
              });
              break;
            case "err":
              // The typed `LlmErr` carries PLAIN-DATA error (the canon: errors
              // as `{_tag}` sentinels, never a `new Error(...)`), so the
              // `failed` slice it lands on stays JSON-stable.
              [s] = durable.fail(s, a.purpose, {
                type: "resilient_err",
                key: a.purpose,
                error: {
                  key: a.purpose,
                  purpose: a.purpose,
                  reason: "boom",
                  error: { _tag: "provider_error", status: 503 },
                },
                at: a.at,
              });
              break;
            case "deadline":
              // Drive the deadline branch → settles `failed` with the plain
              // `{_tag:"deadline_exceeded"}` sentinel inherited from resilient.
              [s] = durable.onTimer(s, {
                type: "deadline_exceeded",
                id: `resilient:deadline:${a.purpose}`,
                atMs: a.at,
              });
              break;
            case "retry":
              [s] = durable.onTimer(s, {
                type: "deadline_exceeded",
                id: `resilient:retry:${a.purpose}`,
                atMs: a.at,
              });
              break;
          }
          // After EVERY verb, any key that has reached a terminal phase must
          // make the WHOLE slice round-trip equal under JSON.
          for (const call of Object.values(s.calls)) {
            if (TERMINAL.has(call.phase)) {
              const roundTripped = JSON.parse(JSON.stringify(s));
              expect(roundTripped).toEqual(s);
            }
          }
        }
        return true;
      }),
    );
  });

  it("a fail-driven `failed` slice carries the typed LlmErr as plain data (durable)", () => {
    // The terminal payload llm-call OWNS: the enriched `LlmErr`. Pin that a
    // verb-path failure lands a JSON-stable `failed` slice and that the typed
    // error survives the round-trip byte-for-byte (no `{}`-wiped Error object).
    fc.assert(
      fc.property(
        fc.constantFrom<Purpose>("plan", "report"),
        fc.nat(1_000_000),
        (purpose, at) => {
          const llmNoRetry = createLlmCall<Purpose, Outputs, Message>(
            { model: fakeModel(async () => ({ steps: [] })), schemas },
            rngZero,
          );
          const input: LlmCall<Purpose> = { purpose, model: null, payload: at };
          let s = llmNoRetry.init();
          [s] = llmNoRetry.attempt(s, input, at);
          const err: LlmErr<Purpose> = {
            key: purpose,
            purpose,
            reason: "provider 503",
            error: { _tag: "provider_error", status: 503 },
          };
          [s] = llmNoRetry.fail(s, purpose, {
            type: "resilient_err",
            key: purpose,
            error: err,
            at,
          });
          const call = s.calls[purpose];
          expect(call?.phase).toBe("failed");
          const roundTripped = JSON.parse(JSON.stringify(s));
          expect(roundTripped).toEqual(s);
          if (call?.phase === "failed") {
            expect(call.error).toEqual(err);
          }
          return true;
        },
      ),
    );
  });
});
