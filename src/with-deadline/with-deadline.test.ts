import * as fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Cmd, defineMachine, replay, run } from "../index";
import { assertWrapperFaithful } from "../testing";
import { type DeadlineModel, deadlineExceededMsg, withDeadline } from "./index";

// ===========================================================================
// A small but non-trivial base machine: a counter that emits a side-effect Cmd
// on every increment, plus a `heartbeat` Msg used to exercise the `progress`
// predicate (heartbeats should NOT re-arm the deadline). The `persist` Cmd lets
// us prove base Cmds pass through UNCHANGED.
// ===========================================================================

interface CounterState {
  readonly count: number;
}

type CounterMsg =
  | { readonly type: "inc"; readonly by: number }
  | { readonly type: "reset" }
  | { readonly type: "heartbeat" };

type PersistCmd = Cmd<"persist"> & { readonly count: number };

interface CounterCtx {
  readonly persist: (count: number) => Promise<void>;
}

function makeBase() {
  return defineMachine<CounterState, CounterMsg, PersistCmd, never, CounterCtx>(
    {
      init: (loaded) => [loaded ?? { count: 0 }, []],
      update: {
        inc: (s, m) => {
          const count = s.count + m.by;
          return [{ count }, [{ type: "persist", count }]];
        },
        reset: () => [{ count: 0 }, []],
        // `heartbeat` is a no-op base transition — used to test that a
        // non-progress Msg does NOT re-arm the deadline.
        heartbeat: (s) => [s, []],
      },
      interpret: {
        persist: async (cmd, ctx) => {
          await ctx.persist(cmd.count);
        },
      },
    },
  );
}

const MSGS: readonly CounterMsg[] = [
  { type: "inc", by: 1 },
  { type: "inc", by: 5 },
  { type: "reset" },
  { type: "heartbeat" },
  { type: "inc", by: 2 },
];

function makeCtx(): CounterCtx & { readonly persisted: number[] } {
  const persisted: number[] = [];
  return {
    persisted,
    persist: async (count: number) => {
      persisted.push(count);
    },
  };
}

// ===========================================================================
// Conformance gate — base byte-identical + slice replay-deterministic. Holds
// because withDeadline never gates base Msgs nor intercepts base Cmds.
// ===========================================================================

describe("withDeadline — conformance gate", () => {
  it("is faithful with the default progress predicate (every Msg re-arms)", () => {
    const base = makeBase();
    assertWrapperFaithful(base, () => withDeadline(base, { ms: 5000 }), {
      msgs: MSGS,
      ctx: makeCtx(),
    });
  });

  it("is faithful with a custom progress predicate (heartbeats excluded)", () => {
    const base = makeBase();
    assertWrapperFaithful(
      base,
      () =>
        withDeadline(base, {
          ms: 5000,
          progress: (msg) => msg.type !== "heartbeat",
        }),
      { msgs: MSGS, ctx: makeCtx() },
    );
  });

  it("is faithful when rehydrated from a composed loaded snapshot", () => {
    const base = makeBase();
    // A non-null composed `loaded` drives the wrapped + bare machines through
    // their rehydrate branches, exercising the base-equivalence path:
    // `state.base` must still match the bare base rehydrated from `baseLoaded`.
    const loaded: DeadlineModel<CounterState> = {
      base: { count: 10 },
      $deadline: { phase: "armed", seq: 3 },
    };
    assertWrapperFaithful(base, () => withDeadline(base, { ms: 5000 }), {
      msgs: MSGS,
      ctx: makeCtx(),
      loaded,
      baseLoaded: loaded.base,
    });
  });
});

// ===========================================================================
// Observe-only — base behavior is untouched (byte-identical, no swallow).
// ===========================================================================

describe("withDeadline — observe-only", () => {
  it("does NOT transform base Cmds — they pass through byte-identical", () => {
    const base = makeBase();
    const ctx = makeCtx();
    const bare = replay(base, { msgs: MSGS, ctx });
    const composed = replay(withDeadline(base, { ms: 5000 }), {
      msgs: MSGS,
      ctx,
    });
    const basePersists = bare.cmds.filter((c) => c.type === "persist");
    const composedPersists = composed.cmds.filter((c) => c.type === "persist");
    expect(composedPersists).toEqual(basePersists);
    expect(composedPersists).toEqual([
      { type: "persist", count: 1 },
      { type: "persist", count: 6 },
      { type: "persist", count: 2 },
    ]);
  });

  it("does NOT gate base Msgs — base state is byte-identical to the bare run", () => {
    const base = makeBase();
    const ctx = makeCtx();
    const bare = replay(base, { msgs: MSGS, ctx });
    const composed = replay(withDeadline(base, { ms: 5000 }), {
      msgs: MSGS,
      ctx,
    });
    expect(composed.state.base).toEqual(bare.state);
  });

  it("appends the decision Cmd AFTER base Cmds (observe, not intercept)", () => {
    const base = makeBase();
    const ctx = makeCtx();
    const { cmds } = replay(withDeadline(base, { ms: 5000 }), {
      msgs: [{ type: "inc", by: 3 }],
      ctx,
    });
    expect(cmds).toEqual([
      { type: "persist", count: 3 },
      { type: "$deadline:decision", decision: "rearm", seq: 1 },
    ]);
  });
});

// ===========================================================================
// Slice mechanics — re-arm bumps seq, predicate gates re-arm, phase flips on
// the delivered exceeded Msg. All pure (replay, no clock).
// ===========================================================================

describe("withDeadline — slice mechanics", () => {
  it("init seeds { phase: armed, seq: 0 } and passes base init Cmds through", () => {
    const base = makeBase();
    const { state, cmds } = replay(withDeadline(base, { ms: 5000 }), {
      msgs: [],
      ctx: makeCtx(),
    });
    expect(state).toEqual({
      base: { count: 0 },
      $deadline: { phase: "armed", seq: 0 },
    });
    expect(cmds).toEqual([]);
  });

  it("rehydrates the composed Model verbatim, honoring the [loaded, []] contract", () => {
    const base = makeBase();
    const loaded: DeadlineModel<CounterState> = {
      base: { count: 42 },
      $deadline: { phase: "exceeded", seq: 7 },
    };
    // replay throws if init returns Cmds on a non-null loaded — passing means
    // the rehydrate branch is a pure passthrough (no re-arm Cmd on boot).
    const { state, cmds } = replay(withDeadline(base, { ms: 5000 }), {
      msgs: [],
      ctx: makeCtx(),
      loaded,
    });
    expect(state).toEqual(loaded);
    expect(cmds).toEqual([]);
  });

  it("bumps seq on every progress Msg (default predicate re-arms each time)", () => {
    const base = makeBase();
    const { state } = replay(withDeadline(base, { ms: 5000 }), {
      msgs: MSGS,
      ctx: makeCtx(),
    });
    // 5 msgs, all count as progress under the default → seq === 5.
    expect(state.$deadline).toEqual({ phase: "armed", seq: 5 });
  });

  it("a non-progress Msg does NOT bump seq (custom predicate excludes it)", () => {
    const base = makeBase();
    const wrapped = withDeadline(base, {
      ms: 5000,
      progress: (msg) => msg.type !== "heartbeat",
    });
    const { state, cmds } = replay(wrapped, {
      msgs: [
        { type: "inc", by: 1 },
        { type: "heartbeat" },
        { type: "inc", by: 1 },
      ],
      ctx: makeCtx(),
    });
    // inc(+1) → seq 1, heartbeat → idle (seq stays 1), inc(+1) → seq 2.
    expect(state.$deadline).toEqual({ phase: "armed", seq: 2 });
    const decisions = cmds.filter((c) => c.type === "$deadline:decision");
    expect(decisions).toEqual([
      { type: "$deadline:decision", decision: "rearm", seq: 1 },
      { type: "$deadline:decision", decision: "idle", seq: 1 },
      { type: "$deadline:decision", decision: "rearm", seq: 2 },
    ]);
  });

  it("the delivered $deadline:exceeded Msg flips phase armed → exceeded", () => {
    const base = makeBase();
    const wrapped = withDeadline(base, { ms: 5000 });
    // One progress Msg (seq → 1), then the timer for generation 1 fires.
    const { state, cmds } = replay(wrapped, {
      msgs: [{ type: "inc", by: 1 }, deadlineExceededMsg(1)],
      ctx: makeCtx(),
    });
    expect(state.$deadline).toEqual({ phase: "exceeded", seq: 1 });
    expect(cmds.filter((c) => c.type === "$deadline:decision")).toEqual([
      { type: "$deadline:decision", decision: "rearm", seq: 1 },
      { type: "$deadline:decision", decision: "expire", seq: 1 },
    ]);
  });

  it("a stale exceeded Msg (wrong seq) is a no-op — the re-arm already retired it", () => {
    const base = makeBase();
    const wrapped = withDeadline(base, { ms: 5000 });
    // seq → 1 → 2 via two progress Msgs; a timer from generation 1 then fires
    // LATE. Its seq (1) no longer matches the current seq (2) → no expiry.
    const { state } = replay(wrapped, {
      msgs: [
        { type: "inc", by: 1 },
        { type: "inc", by: 1 },
        deadlineExceededMsg(1),
      ],
      ctx: makeCtx(),
    });
    expect(state.$deadline).toEqual({ phase: "armed", seq: 2 });
  });

  it("once exceeded, further base Msgs do NOT re-arm (the machine auto-failed)", () => {
    const base = makeBase();
    const wrapped = withDeadline(base, { ms: 5000 });
    const { state } = replay(wrapped, {
      msgs: [
        { type: "inc", by: 1 },
        deadlineExceededMsg(1),
        { type: "inc", by: 1 },
      ],
      ctx: makeCtx(),
    });
    // Base still advances (observe-only), but the deadline stays exceeded.
    expect(state.base).toEqual({ count: 2 });
    expect(state.$deadline).toEqual({ phase: "exceeded", seq: 1 });
  });
});

// ===========================================================================
// Subscriptions — the timeout Sub is armed while armed, keyed on seq so a
// re-arm churns the timer id; gone once exceeded. (replay derives the desired
// sub set at the final state.)
// ===========================================================================

describe("withDeadline — subscriptions reconcile by id", () => {
  it("arms a $deadline:timeout sub keyed on seq while armed", () => {
    const base = makeBase();
    const { subs } = replay(withDeadline(base, { ms: 5000 }), {
      msgs: [{ type: "inc", by: 1 }],
      ctx: makeCtx(),
    });
    expect(subs).toEqual([
      { id: "$deadline:timeout:1", type: "$deadline:timeout", delayMs: 5000 },
    ]);
  });

  it("a progress bump CHANGES the sub id (re-arm = id change, reconciled away)", () => {
    const base = makeBase();
    const wrapped = withDeadline(base, { ms: 5000 });
    const a = replay(wrapped, {
      msgs: [{ type: "inc", by: 1 }],
      ctx: makeCtx(),
    });
    const b = replay(wrapped, {
      msgs: [
        { type: "inc", by: 1 },
        { type: "inc", by: 1 },
      ],
      ctx: makeCtx(),
    });
    expect(a.subs[0]?.id).toBe("$deadline:timeout:1");
    expect(b.subs[0]?.id).toBe("$deadline:timeout:2");
    expect(a.subs[0]?.id).not.toBe(b.subs[0]?.id);
  });

  it("returns NO deadline sub once exceeded", () => {
    const base = makeBase();
    const { subs } = replay(withDeadline(base, { ms: 5000 }), {
      msgs: [{ type: "inc", by: 1 }, deadlineExceededMsg(1)],
      ctx: makeCtx(),
    });
    expect(subs.filter((s) => s.type === "$deadline:timeout")).toEqual([]);
  });

  it("merges base subs WITH the deadline sub (base sub preserved)", () => {
    // A base that arms its own sub proves the merge keeps both.
    type Tick = { id: string; type: "tick" };
    const ticking = defineMachine<
      CounterState,
      CounterMsg,
      PersistCmd,
      Tick,
      CounterCtx
    >({
      init: (loaded) => [loaded ?? { count: 0 }, []],
      update: {
        inc: (s, m) => [{ count: s.count + m.by }, []],
        reset: () => [{ count: 0 }, []],
        heartbeat: (s) => [s, []],
      },
      subscriptions: () => [{ id: "tick", type: "tick" }],
      subscribe: { tick: () => () => {} },
      interpret: { persist: async () => {} },
    });
    const { subs } = replay(withDeadline(ticking, { ms: 5000 }), {
      msgs: [{ type: "inc", by: 1 }],
      ctx: makeCtx(),
    });
    expect(subs).toEqual([
      { id: "tick", type: "tick" },
      { id: "$deadline:timeout:1", type: "$deadline:timeout", delayMs: 5000 },
    ]);
  });
});

// ===========================================================================
// Real runtime + fake timers — the END-TO-END proof: arms, re-arms on progress
// (timer restarts), fires deadline-exceeded after `ms` of inactivity, slice
// goes armed → exceeded. `run()` actually wires the Sub's setTimeout.
// ===========================================================================

describe("withDeadline — real run() with fake timers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("auto-fails after `ms` of inactivity (armed → exceeded)", async () => {
    const base = makeBase();
    const runtime = await run(withDeadline(base, { ms: 5000 }), {
      ctx: makeCtx(),
    }).ready;

    // Armed on boot.
    expect(runtime.getState().$deadline).toEqual({ phase: "armed", seq: 0 });

    // Just before the window: still armed.
    await vi.advanceTimersByTimeAsync(4999);
    expect(runtime.getState().$deadline).toEqual({ phase: "armed", seq: 0 });

    // Cross the window: the timeout Sub fires → $deadline:exceeded → phase flips.
    await vi.advanceTimersByTimeAsync(1);
    expect(runtime.getState().$deadline).toEqual({ phase: "exceeded", seq: 0 });

    await runtime.stop();
  });

  it("re-arms on progress — the timer RESTARTS so the old window never fires", async () => {
    const base = makeBase();
    const runtime = await run(withDeadline(base, { ms: 5000 }), {
      ctx: makeCtx(),
    }).ready;

    // 3s in: a progress Msg re-arms (seq 0 → 1). The generation-0 timer is
    // retired by the reconcile pass; a fresh 5s countdown starts.
    await vi.advanceTimersByTimeAsync(3000);
    await runtime.dispatch({ type: "inc", by: 1 });
    expect(runtime.getState().$deadline).toEqual({ phase: "armed", seq: 1 });

    // 4s past the re-arm (7s total): the ORIGINAL window (5s) has elapsed, but
    // because it was retired, NO exceeded fired. Still armed.
    await vi.advanceTimersByTimeAsync(4000);
    expect(runtime.getState().$deadline).toEqual({ phase: "armed", seq: 1 });

    // 1s more (5s since the re-arm): the FRESH window elapses → auto-fail.
    await vi.advanceTimersByTimeAsync(1000);
    expect(runtime.getState().$deadline).toEqual({ phase: "exceeded", seq: 1 });

    await runtime.stop();
  });

  it("repeated progress keeps the machine alive indefinitely", async () => {
    const base = makeBase();
    const runtime = await run(withDeadline(base, { ms: 5000 }), {
      ctx: makeCtx(),
    }).ready;

    // Tick progress every 4s for 5 rounds (20s total, well past one 5s window).
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(4000);
      await runtime.dispatch({ type: "inc", by: 1 });
      expect(runtime.getState().$deadline.phase).toBe("armed");
    }
    expect(runtime.getState().$deadline.seq).toBe(5);

    // Now go silent for the full window → auto-fail.
    await vi.advanceTimersByTimeAsync(5000);
    expect(runtime.getState().$deadline.phase).toBe("exceeded");

    await runtime.stop();
  });

  it("base effects still run while the deadline observes (no interception)", async () => {
    const base = makeBase();
    const ctx = makeCtx();
    const runtime = await run(withDeadline(base, { ms: 5000 }), { ctx }).ready;

    await runtime.dispatch({ type: "inc", by: 4 });
    await runtime.dispatch({ type: "inc", by: 3 });
    expect(ctx.persisted).toEqual([4, 7]);
    expect(runtime.getState().base).toEqual({ count: 7 });

    await runtime.stop();
  });
});

// ===========================================================================
// Reserved-namespace guards — mirror withTelemetry.
// ===========================================================================

describe("withDeadline — reserved-namespace guards", () => {
  it("throws if the base squats on the $deadline:decision interpret handler", () => {
    type SquatCmd = Cmd<"$deadline:decision"> & { readonly note: string };
    const squatting = defineMachine<
      CounterState,
      CounterMsg,
      SquatCmd,
      never,
      CounterCtx
    >({
      init: (loaded) => [loaded ?? { count: 0 }, []],
      update: {
        inc: (s, m) => [
          { count: s.count + m.by },
          [{ type: "$deadline:decision", note: "base-owned" }],
        ],
        reset: () => [{ count: 0 }, []],
        heartbeat: (s) => [s, []],
      },
      interpret: {
        "$deadline:decision": async () => {},
      },
    });
    expect(() => withDeadline(squatting, { ms: 5000 })).toThrow(
      /reserved "\$deadline:decision" interpret handler/,
    );
  });

  it("throws if the base squats on the $deadline:timeout subscribe handler", () => {
    type SquatSub = { id: string; type: "$deadline:timeout" };
    const squatting = defineMachine<
      CounterState,
      CounterMsg,
      PersistCmd,
      SquatSub,
      CounterCtx
    >({
      init: (loaded) => [loaded ?? { count: 0 }, []],
      update: {
        inc: (s, m) => [{ count: s.count + m.by }, []],
        reset: () => [{ count: 0 }, []],
        heartbeat: (s) => [s, []],
      },
      subscriptions: () => [],
      subscribe: { "$deadline:timeout": () => () => {} },
      interpret: { persist: async () => {} },
    });
    expect(() => withDeadline(squatting, { ms: 5000 })).toThrow(
      /reserved "\$deadline:timeout" subscribe handler/,
    );
  });
});

// ===========================================================================
// Property tests — purity (replay under any ambient is deterministic + JSON
// round-trips) and seq monotonicity.
// ===========================================================================

describe("withDeadline — properties", () => {
  const arbMsgs = fc.array(
    fc.oneof(
      fc
        .integer({ min: -100, max: 100 })
        .map((by) => ({ type: "inc", by }) as CounterMsg),
      fc.constant({ type: "reset" } as CounterMsg),
      fc.constant({ type: "heartbeat" } as CounterMsg),
    ),
    { maxLength: 30 },
  );

  it("seq is monotonic — equals the count of accepted progress Msgs (while armed)", () => {
    const base = makeBase();
    fc.assert(
      fc.property(arbMsgs, (msgs) => {
        const wrapped = withDeadline(base, {
          ms: 5000,
          progress: (m) => m.type !== "heartbeat",
        });
        const expected = msgs.filter((m) => m.type !== "heartbeat").length;
        const { state } = replay(wrapped, { msgs, ctx: makeCtx() });
        expect(state.$deadline).toEqual({ phase: "armed", seq: expected });

        // Monotonic, never decreasing across prefixes.
        let prev = 0;
        for (let n = 0; n <= msgs.length; n++) {
          const prefix = replay(wrapped, {
            msgs: msgs.slice(0, n),
            ctx: makeCtx(),
          });
          expect(prefix.state.$deadline.seq).toBeGreaterThanOrEqual(prev);
          prev = prefix.state.$deadline.seq;
        }
      }),
    );
  });

  it("update is PURE — two replays of one log agree and the slice JSON round-trips", () => {
    const base = makeBase();
    fc.assert(
      fc.property(arbMsgs, (msgs) => {
        const wrapped = withDeadline(base, { ms: 5000 });
        const a = replay(wrapped, { msgs, ctx: makeCtx() });
        const b = replay(wrapped, { msgs, ctx: makeCtx() });
        expect(b.state).toEqual(a.state);
        expect(JSON.parse(JSON.stringify(a.state.$deadline))).toEqual(
          a.state.$deadline,
        );
        // Base slice matches the bare base run for every log (byte-identical).
        const bare = replay(base, { msgs, ctx: makeCtx() });
        expect(a.state.base).toEqual(bare.state);
      }),
    );
  });

  it("the slice has NO absolute timestamp — only { phase, seq }", () => {
    const base = makeBase();
    fc.assert(
      fc.property(arbMsgs, (msgs) => {
        const { state } = replay(withDeadline(base, { ms: 5000 }), {
          msgs,
          ctx: makeCtx(),
        });
        expect(Object.keys(state.$deadline).sort()).toEqual(["phase", "seq"]);
      }),
    );
  });
});

// Type-level assertion: the composed Model exposes the named $deadline slice.
const _typecheck: DeadlineModel<CounterState> = {
  base: { count: 0 },
  $deadline: { phase: "armed", seq: 0 },
};
void _typecheck;
