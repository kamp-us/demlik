import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defineMachine,
  type NoCtx,
  type Reducer,
  run,
  type Sub,
  subId,
} from "../index";
import { fromInterval } from "./from-interval";

// Lifecycle contract under a real runtime (issue #286): the reconcile pass
// starts the interval when the Sub enters `subscriptions(state)`, delivered
// ticks fold into State, and reconciling the Sub out clears the timer.

type TickSub = Sub<"tick"> & { intervalMs: number };
type State = { readonly armed: boolean; readonly ticks: number };
type Msg = { readonly type: "tick" } | { readonly type: "disarm" };

const update: Reducer<State, Msg, never> = {
  tick: (s) => [{ ...s, ticks: s.ticks + 1 }, []],
  disarm: (s) => [{ ...s, armed: false }, []],
};

function tickMachine(intervalMs: number) {
  return defineMachine<State, Msg, never, TickSub, NoCtx>({
    init: () => [{ armed: true, ticks: 0 }, []],
    update,
    subscriptions: (s) =>
      s.armed ? [{ id: subId("tick"), type: "tick", intervalMs }] : [],
    subscribe: {
      tick: fromInterval<TickSub, Msg>(() => ({ type: "tick" })),
    },
  });
}

describe("fromInterval — subscribe → deliver → cleanup against a real runtime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers a tick Msg per elapsed period while the Sub is in the desired set", async () => {
    const rt = await run(tickMachine(1_000), {}).ready;
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
    const rt = await run(tickMachine(500), {}).ready;
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
    const rt = await run(tickMachine(500), {}).ready;
    await rt.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(rt.getState().ticks).toBe(0);
  });

  it("reads the period off the Sub itself", async () => {
    const rt = await run(tickMachine(10_000), {}).ready;
    await vi.advanceTimersByTimeAsync(9_999);
    await rt.idle();
    expect(rt.getState().ticks).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await rt.idle();
    expect(rt.getState().ticks).toBe(1);
    await rt.stop();
  });
});
