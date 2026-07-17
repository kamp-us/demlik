import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defineMachine,
  type NoCtx,
  type Reducer,
  run,
  type Sub,
  subId,
} from "../index";
import { fromTimeout } from "./from-timeout";

// Lifecycle contract under a real runtime (issue #286): the timer arms when
// the Sub enters `subscriptions(state)`, fires its Msg exactly once, and a
// reconcile-out before the delay elapses cancels the pending dispatch — the
// "cancel on state exit" pattern the factory's docblock pins.

type ExpireSub = Sub<"expire"> & { delayMs: number };
type State = { readonly phase: "waiting" | "expired" | "left" };
type Msg = { readonly type: "expired" } | { readonly type: "leave" };

// `expired` transitions unconditionally so a timer that outlives its cleanup
// is observable: a stray late fire flips a "left" state to "expired" and the
// cancel-on-exit test reds instead of being masked by a defensive guard.
const update: Reducer<State, Msg, never> = {
  expired: () => [{ phase: "expired" }, []],
  leave: () => [{ phase: "left" }, []],
};

function timeoutMachine(delayMs: number) {
  return defineMachine<State, Msg, never, ExpireSub, NoCtx>({
    init: () => [{ phase: "waiting" }, []],
    update,
    subscriptions: (s) =>
      s.phase === "waiting"
        ? [{ id: subId("expire"), type: "expire", delayMs }]
        : [],
    subscribe: {
      expire: fromTimeout<ExpireSub, Msg>(() => ({ type: "expired" })),
    },
  });
}

describe("fromTimeout — subscribe → deliver → cleanup against a real runtime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires the Msg once after delayMs, and only once — the handle is exhausted", async () => {
    const dispatched: Msg[] = [];
    const rt = await run(timeoutMachine(1_000), {}).ready;
    rt.observe((msg) => dispatched.push(msg));

    await vi.advanceTimersByTimeAsync(999);
    await rt.idle();
    expect(rt.getState().phase).toBe("waiting");

    await vi.advanceTimersByTimeAsync(1);
    await rt.idle();
    expect(rt.getState().phase).toBe("expired");

    // The expired state drops the Sub from the desired set; even a long wait
    // delivers no second Msg (setTimeout, not setInterval).
    await vi.advanceTimersByTimeAsync(10_000);
    await rt.idle();
    expect(dispatched.filter((m) => m.type === "expired")).toHaveLength(1);

    await rt.stop();
  });

  it("cancel on state exit: reconciling out before the delay elapses cancels the pending dispatch", async () => {
    const rt = await run(timeoutMachine(1_000), {}).ready;

    await rt.dispatch({ type: "leave" }); // drops the Sub → cleanup → clearTimeout
    await vi.advanceTimersByTimeAsync(10_000);
    await rt.idle();
    expect(rt.getState().phase).toBe("left"); // never "expired"

    await rt.stop();
  });

  it("runtime.stop() cancels a still-pending timeout", async () => {
    const rt = await run(timeoutMachine(1_000), {}).ready;
    await rt.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(rt.getState().phase).toBe("waiting"); // the Msg never fired
  });
});
