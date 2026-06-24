import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Cmd, defineMachine, replay, run } from "../index";
import { assertWrapperFaithful } from "../testing";
import {
  type TelemetryEvent,
  type TelemetryModel,
  withTelemetry,
} from "./index";

// ===========================================================================
// A small but non-trivial base machine: a counter that emits a side-effect Cmd
// on every increment. The Cmd lets us prove base Cmds pass through UNCHANGED.
// ===========================================================================

interface CounterState {
  readonly count: number;
}

type CounterMsg =
  | { readonly type: "inc"; readonly by: number }
  | { readonly type: "reset" };

// The base's own effect — appears in the Cmd stream and MUST survive wrapping.
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
        // `reset` emits NO base Cmd — proves the wrapper still emits its own.
        reset: () => [{ count: 0 }, []],
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
  { type: "inc", by: 2 },
];

// A ctx that records what the persist port + telemetry sink received.
function makeCtx() {
  const persisted: number[] = [];
  const events: TelemetryEvent[] = [];
  return {
    persisted,
    events,
    ctx: {
      persist: async (count: number) => {
        persisted.push(count);
      },
      telemetrySink: (event: TelemetryEvent) => {
        events.push(event);
      },
      clock: () => 1000,
    },
  };
}

describe("withTelemetry — observe-only composition", () => {
  it("is faithful by the shared conformance gate", () => {
    const base = makeBase();
    const { ctx } = makeCtx();
    assertWrapperFaithful(base, () => withTelemetry(base), {
      msgs: MSGS,
      ctx,
    });
  });

  it("is faithful with a custom event projector too", () => {
    const base = makeBase();
    const { ctx } = makeCtx();
    assertWrapperFaithful(
      base,
      () =>
        withTelemetry(base, {
          event: (msg, _prev, next) => ({
            seq: next.$telemetry.seq,
            msgType: msg.type,
          }),
        }),
      { msgs: MSGS, ctx },
    );
  });

  it("does NOT transform base Cmds — they pass through byte-identical", () => {
    const base = makeBase();
    const { ctx } = makeCtx();
    const wrapped = withTelemetry(base);

    const bare = replay(base, { msgs: MSGS, ctx });
    const composed = replay(wrapped, { msgs: MSGS, ctx });

    // Every base `persist` Cmd is present in the composed stream, in order,
    // with the exact same shape — none rewritten, none dropped, none retimed.
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
    const { ctx } = makeCtx();
    const bare = replay(base, { msgs: MSGS, ctx });
    const composed = replay(withTelemetry(base), { msgs: MSGS, ctx });
    expect(composed.state.base).toEqual(bare.state);
  });

  it("seq === msgs.length (one telemetry tick per base transition)", () => {
    const base = makeBase();
    const { ctx } = makeCtx();
    const { state } = replay(withTelemetry(base), { msgs: MSGS, ctx });
    expect(state.$telemetry.seq).toBe(MSGS.length);
  });

  it("emits exactly one $telemetry:emit Cmd per transition, with the default event", () => {
    const base = makeBase();
    const { ctx } = makeCtx();
    const { cmds } = replay(withTelemetry(base), { msgs: MSGS, ctx });
    const emits = cmds.filter((c) => c.type === "$telemetry:emit");
    expect(emits.length).toBe(MSGS.length);
    expect(emits).toEqual([
      { type: "$telemetry:emit", event: { seq: 1, msgType: "inc" } },
      { type: "$telemetry:emit", event: { seq: 2, msgType: "inc" } },
      { type: "$telemetry:emit", event: { seq: 3, msgType: "reset" } },
      { type: "$telemetry:emit", event: { seq: 4, msgType: "inc" } },
    ]);
  });

  it("appends the emit Cmd AFTER the base Cmds (observe, not intercept)", () => {
    const base = makeBase();
    const { ctx } = makeCtx();
    // Replay a single `inc`: base emits `persist`, wrapper appends `$telemetry:emit`.
    const { cmds } = replay(withTelemetry(base), {
      msgs: [{ type: "inc", by: 3 }],
      ctx,
    });
    expect(cmds).toEqual([
      { type: "persist", count: 3 },
      { type: "$telemetry:emit", event: { seq: 1, msgType: "inc" } },
    ]);
  });

  it("init seeds seq: 0 and passes base init Cmds through (no telemetry on boot)", () => {
    const base = makeBase();
    const { ctx } = makeCtx();
    const { state, cmds } = replay(withTelemetry(base), { msgs: [], ctx });
    expect(state).toEqual({ base: { count: 0 }, $telemetry: { seq: 0 } });
    expect(cmds).toEqual([]);
  });

  it("rehydrates the composed Model verbatim, honoring the [loaded, []] contract", () => {
    const base = makeBase();
    const { ctx } = makeCtx();
    const loaded: TelemetryModel<CounterState> = {
      base: { count: 42 },
      $telemetry: { seq: 7 },
    };
    // replay throws if init returns Cmds on a non-null loaded — passing means
    // the rehydrate branch is a pure passthrough.
    const { state } = replay(withTelemetry(base), { msgs: [], ctx, loaded });
    expect(state).toEqual(loaded);
  });
});

// ===========================================================================
// The sink Port receives events via a REAL run() runtime — proving the interpret
// boundary actually fires the side effect (replay never calls interpret).
// ===========================================================================

describe("withTelemetry — real runtime drives the sink", () => {
  it("delivers a projected, clock-stamped event to the sink per dispatch", async () => {
    const base = makeBase();
    const { ctx, events, persisted } = makeCtx();
    const runtime = await run(withTelemetry(base), { ctx }).ready;

    await runtime.dispatch({ type: "inc", by: 4 });
    await runtime.dispatch({ type: "reset" });

    // The base effect still ran (observe-only did not break it).
    expect(persisted).toEqual([4]);
    // The sink received one event per dispatch, with `at` stamped at the
    // interpret boundary by the `clock` port (never inside the pure update).
    expect(events).toEqual([
      { seq: 1, msgType: "inc", at: 1000 },
      { seq: 2, msgType: "reset", at: 1000 },
    ]);

    // The composed state advanced both the base slice and the wrapper slice.
    expect(runtime.getState()).toEqual({
      base: { count: 0 },
      $telemetry: { seq: 2 },
    });

    await runtime.stop();
  });

  it("throws if the base already declares a reserved $telemetry:emit handler", () => {
    // A base that squats on the wrapper's reserved Cmd namespace. The interpret
    // spread would SILENTLY clobber this handler; the wrap-time guard refuses.
    type SquatCmd = Cmd<"$telemetry:emit"> & { readonly note: string };
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
          [{ type: "$telemetry:emit", note: "base-owned" }],
        ],
        reset: () => [{ count: 0 }, []],
      },
      interpret: {
        "$telemetry:emit": async () => {},
      },
    });
    expect(() => withTelemetry(squatting)).toThrow(
      /reserved "\$telemetry:emit" interpret handler/,
    );
  });

  it("leaves event.at unset when no clock port is supplied", async () => {
    const base = makeBase();
    const events: TelemetryEvent[] = [];
    const runtime = await run(withTelemetry(base), {
      ctx: {
        persist: async () => {},
        telemetrySink: (e: TelemetryEvent) => {
          events.push(e);
        },
        // no `clock`
      },
    }).ready;
    await runtime.dispatch({ type: "inc", by: 1 });
    expect(events).toEqual([{ seq: 1, msgType: "inc" }]);
    await runtime.stop();
  });
});

// ===========================================================================
// Observe-only at the boundary: the sink is fire-and-forget. The runtime awaits
// every interpret handler in its dispatch loop, so a SLOW or FAILING sink must
// NOT backpressure or crash the wrapped machine. These run on a REAL run()
// runtime (replay never calls interpret, so it can't exercise this).
// ===========================================================================

describe("withTelemetry — sink is fire-and-forget (non-blocking, non-crashing)", () => {
  it("a sink that NEVER resolves does not block the runtime — later dispatches still complete", async () => {
    const base = makeBase();
    const persisted: number[] = [];
    // A sink that returns a forever-pending Promise. If the handler awaited it,
    // the dispatch loop would hang here and the second dispatch would never run.
    const hung = new Promise<void>(() => {}); // never resolves, never rejects
    const runtime = await run(withTelemetry(base), {
      ctx: {
        persist: async (count: number) => {
          persisted.push(count);
        },
        telemetrySink: () => hung,
      },
    }).ready;

    // Each dispatch resolves promptly despite the pending sink. A timeout race
    // makes "did it block?" a hard failure rather than a hung test.
    const timeout = (ms: number) =>
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`dispatch blocked > ${ms}ms`)), ms),
      );

    await Promise.race([
      runtime.dispatch({ type: "inc", by: 4 }),
      timeout(1000),
    ]);
    await Promise.race([
      runtime.dispatch({ type: "inc", by: 6 }),
      timeout(1000),
    ]);

    // Both base transitions applied AND both base effects ran — the never-
    // resolving telemetry sink did not stall the wrapped machine.
    expect(persisted).toEqual([4, 10]);
    expect(runtime.getState()).toEqual({
      base: { count: 10 },
      $telemetry: { seq: 2 },
    });

    await runtime.stop();
  });

  it("a sink that REJECTS does not crash the machine — the run continues and state advances", async () => {
    const base = makeBase();
    const persisted: number[] = [];
    const runtime = await run(withTelemetry(base), {
      ctx: {
        persist: async (count: number) => {
          persisted.push(count);
        },
        telemetrySink: async () => {
          throw new Error("sink exploded (async reject)");
        },
      },
    }).ready;

    // If the rejection escaped the handler it would propagate out of the
    // dispatch and reject this await; if it became an unhandled rejection it
    // would fail the suite. Neither happens — the dispatch resolves cleanly.
    await runtime.dispatch({ type: "inc", by: 4 });
    await runtime.dispatch({ type: "reset" });
    await runtime.dispatch({ type: "inc", by: 7 });

    expect(persisted).toEqual([4, 7]);
    expect(runtime.getState()).toEqual({
      base: { count: 7 },
      $telemetry: { seq: 3 },
    });

    await runtime.stop();
  });

  it("a sink that THROWS SYNCHRONOUSLY does not crash the machine either", async () => {
    const base = makeBase();
    const persisted: number[] = [];
    const runtime = await run(withTelemetry(base), {
      ctx: {
        persist: async (count: number) => {
          persisted.push(count);
        },
        // Throws before returning a Promise — the synchronous-throw shape.
        telemetrySink: () => {
          throw new Error("sink exploded (sync throw)");
        },
      },
    }).ready;

    await runtime.dispatch({ type: "inc", by: 2 });
    await runtime.dispatch({ type: "inc", by: 3 });

    expect(persisted).toEqual([2, 5]);
    expect(runtime.getState()).toEqual({
      base: { count: 5 },
      $telemetry: { seq: 2 },
    });

    await runtime.stop();
  });

  it("an unhandled-rejection listener stays silent across a rejecting-sink run", async () => {
    // Belt-and-suspenders: a rejecting sink must never surface as a process-
    // level unhandledrejection. We attach a listener for the duration of the run
    // and assert it never fired.
    const base = makeBase();
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const runtime = await run(withTelemetry(base), {
        ctx: {
          persist: async () => {},
          telemetrySink: async () => {
            throw new Error("boom");
          },
        },
      }).ready;
      await runtime.dispatch({ type: "inc", by: 1 });
      await runtime.dispatch({ type: "inc", by: 1 });
      // Give any stray microtask/macrotask a chance to surface a rejection.
      await new Promise((r) => setTimeout(r, 50));
      await runtime.stop();
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

// ===========================================================================
// Property test — immutability of inputs + monotonic, log-determined seq.
// ===========================================================================

describe("withTelemetry — properties", () => {
  const arbMsgs = fc.array(
    fc.oneof(
      fc
        .integer({ min: -100, max: 100 })
        .map((by) => ({ type: "inc", by }) as CounterMsg),
      fc.constant({ type: "reset" } as CounterMsg),
    ),
    { maxLength: 30 },
  );

  it("seq equals the msg count and grows by exactly one per transition", () => {
    const base = makeBase();
    const { ctx } = makeCtx();
    fc.assert(
      fc.property(arbMsgs, (msgs) => {
        const wrapped = withTelemetry(base);
        // seq after N msgs is exactly N.
        const { state } = replay(wrapped, { msgs, ctx });
        expect(state.$telemetry.seq).toBe(msgs.length);
        // And monotonic by exactly one at each prefix.
        for (let n = 0; n <= msgs.length; n++) {
          const prefix = replay(wrapped, { msgs: msgs.slice(0, n), ctx });
          expect(prefix.state.$telemetry.seq).toBe(n);
        }
      }),
    );
  });

  it("never mutates the input state — replay is referentially pure over the log", () => {
    const base = makeBase();
    const { ctx } = makeCtx();
    fc.assert(
      fc.property(arbMsgs, (msgs) => {
        const wrapped = withTelemetry(base);
        // Two independent replays of the same log yield deep-equal results AND
        // the wrapper slice is JSON-round-trip stable (durable, no closure).
        const a = replay(wrapped, { msgs, ctx });
        const b = replay(wrapped, { msgs, ctx });
        expect(b.state).toEqual(a.state);
        expect(JSON.parse(JSON.stringify(a.state.$telemetry))).toEqual(
          a.state.$telemetry,
        );
        // The base slice matches the bare base run for every log.
        const bare = replay(base, { msgs, ctx });
        expect(a.state.base).toEqual(bare.state);
      }),
    );
  });
});
