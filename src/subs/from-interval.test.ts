import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineMachine, type NoCtx, type Reducer, type Sub } from "../index";
import { run } from "../promise";
import { fromInterval } from "./from-interval";

// Lifecycle contract under a real runtime (issue #286): the reconcile pass
// starts the interval when the Sub's `deps` turns non-null, delivered ticks
// fold into State, reconciling the Sub out clears the timer, and a changed
// period is a new id — the engine restarts the interval at the new period.

type TickSub = Sub<"tick", { readonly intervalMs: number }>;
type State = {
  readonly armed: boolean;
  readonly ticks: number;
  readonly periodMs: number;
};
type Msg =
  | { readonly type: "tick" }
  | { readonly type: "disarm" }
  | { readonly type: "retime"; readonly periodMs: number };

const update: Reducer<State, Msg, never> = {
  tick: (s) => [{ ...s, ticks: s.ticks + 1 }, []],
  disarm: (s) => [{ ...s, armed: false }, []],
  retime: (s, m) => [{ ...s, periodMs: m.periodMs }, []],
};

function tickMachine(intervalMs: number) {
  return defineMachine({
    types: {
      model: {} as State,
      msg: {} as Msg,
      sub: {} as TickSub,
      ctx: {} as NoCtx,
    },
    init: () => [{ armed: true, ticks: 0, periodMs: intervalMs }, []],
    update,
    subs: [
      {
        type: "tick",
        deps: (s) => (s.armed ? { intervalMs: s.periodMs } : null),
      },
    ],
  });
}

const subscribe = {
  tick: fromInterval<TickSub, Msg>(() => ({ type: "tick" })),
};

describe("fromInterval — subscribe → deliver → cleanup against a real runtime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers a tick Msg per elapsed period while the Sub is on", async () => {
    const rt = await run(tickMachine(1_000), { subscribe }).ready;
    expect(rt.getState().ticks).toBe(0);

    await vi.advanceTimersByTimeAsync(999);
    await rt.idle();
    expect(rt.getState().ticks).toBe(0); // period not yet elapsed

    await vi.advanceTimersByTimeAsync(1);
    await rt.idle();
    expect(rt.getState().ticks).toBe(1);

    await vi.advanceTimersByTimeAsync(2_000);
    await rt.idle();
    expect(rt.getState().ticks).toBe(3); // recurring, one Msg per period

    await rt.stop();
  });

  it("reconciling the Sub out clears the interval — no tick after disarm", async () => {
    const rt = await run(tickMachine(500), { subscribe }).ready;
    await vi.advanceTimersByTimeAsync(500);
    await rt.idle();
    expect(rt.getState().ticks).toBe(1);

    await rt.dispatch({ type: "disarm" });
    await vi.advanceTimersByTimeAsync(5_000);
    await rt.idle();
    expect(rt.getState().ticks).toBe(1); // cleanup ran; the timer is gone

    await rt.stop();
  });

  it("runtime.stop() tears the interval down (no tick after stop)", async () => {
    const rt = await run(tickMachine(500), { subscribe }).ready;
    await rt.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(rt.getState().ticks).toBe(0);
  });

  it("reads the period off the Sub's deps", async () => {
    const rt = await run(tickMachine(10_000), { subscribe }).ready;
    await vi.advanceTimersByTimeAsync(9_999);
    await rt.idle();
    expect(rt.getState().ticks).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await rt.idle();
    expect(rt.getState().ticks).toBe(1);
    await rt.stop();
  });

  it("a changed period restarts the interval at the new period", async () => {
    const rt = await run(tickMachine(1_000), { subscribe }).ready;
    await vi.advanceTimersByTimeAsync(600);
    await rt.dispatch({ type: "retime", periodMs: 5_000 });

    // The 1s interval is gone: no tick at the old period's boundary.
    await vi.advanceTimersByTimeAsync(4_999);
    await rt.idle();
    expect(rt.getState().ticks).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    await rt.idle();
    expect(rt.getState().ticks).toBe(1);
    await rt.stop();
  });
});
