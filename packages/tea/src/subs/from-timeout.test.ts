import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineMachine, type NoCtx, type Reducer, type Sub } from "../index";
import { run } from "../promise";
import { fromTimeout } from "./from-timeout";

// Lifecycle contract under a real runtime (issue #286): the timer arms when
// the Sub's `deps` turns non-null, fires its Msg exactly once, and a
// reconcile-out before the delay elapses cancels the pending dispatch — the
// "cancel on state exit" pattern the factory's docblock pins.

type ExpireSub = Sub<
  "expire",
  { readonly delayMs: number; readonly ref?: boolean }
>;
type State = { readonly phase: "waiting" | "expired" | "left" };
type Msg = { readonly _tag: "expired" } | { readonly _tag: "leave" };

// `expired` transitions unconditionally so a timer that outlives its cleanup
// is observable: a stray late fire flips a "left" state to "expired" and the
// cancel-on-exit test reds instead of being masked by a defensive guard.
const update: Reducer<State, Msg, never> = {
  expired: () => [{ phase: "expired" }, []],
  leave: () => [{ phase: "left" }, []],
};

function timeoutMachine(delayMs: number, ref?: boolean) {
  return defineMachine({
    types: {
      model: {} as State,
      msg: {} as Msg,
      sub: {} as ExpireSub,
      ctx: {} as NoCtx,
    },
    init: (_loaded) => [{ phase: "waiting" }, []],
    update,
    subs: [
      {
        _tag: "expire",
        deps: (s) =>
          s.phase === "waiting"
            ? { delayMs, ...(ref === undefined ? {} : { ref }) }
            : null,
      },
    ],
  });
}

const subscribe = {
  expire: fromTimeout<ExpireSub, Msg>(() => ({ _tag: "expired" })),
};

describe("fromTimeout — subscribe → deliver → cleanup against a real runtime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires the Msg once after delayMs, and only once — the handle is exhausted", async () => {
    const dispatched: Msg[] = [];
    const rt = await run(timeoutMachine(1_000), { subscribe }).ready;
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
    expect(dispatched.filter((m) => m._tag === "expired")).toHaveLength(1);

    await rt.stop();
  });

  it("cancel on state exit: reconciling out before the delay elapses cancels the pending dispatch", async () => {
    const rt = await run(timeoutMachine(1_000), { subscribe }).ready;

    await rt.dispatch({ _tag: "leave" }); // drops the Sub → cleanup → clearTimeout
    await vi.advanceTimersByTimeAsync(10_000);
    await rt.idle();
    expect(rt.getState().phase).toBe("left"); // never "expired"

    await rt.stop();
  });

  it("runtime.stop() cancels a still-pending timeout", async () => {
    const rt = await run(timeoutMachine(1_000), { subscribe }).ready;
    await rt.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(rt.getState().phase).toBe("waiting"); // the Msg never fired
  });
});

// `ref: false` is `timeout.unref()` on the Sub's own timer: a Node process with
// nothing else pending exits without waiting for it. Real timers, because a
// fake handle cannot say whether Node still counts it.
describe("fromTimeout — ref: false leaves the pending timer unreferenced", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const LONG_DELAY_MS = 60_000;

  /** Boot a run whose timeout is pending; return the handle `setTimeout` gave it. */
  async function armed(ref?: boolean) {
    const timers = vi.spyOn(globalThis, "setTimeout");
    const rt = await run(timeoutMachine(LONG_DELAY_MS, ref), { subscribe })
      .ready;
    const at = timers.mock.calls.findIndex(([, ms]) => ms === LONG_DELAY_MS);
    return { rt, handle: timers.mock.results[at]?.value as NodeJS.Timeout };
  }

  it("unrefs the timer when the deps say ref: false", async () => {
    const { rt, handle } = await armed(false);

    expect(handle.hasRef()).toBe(false);

    await rt.stop();
  });

  it("keeps the timer referenced by default, and when the deps say ref: true", async () => {
    for (const ref of [undefined, true]) {
      const { rt, handle } = await armed(ref);

      expect(handle.hasRef()).toBe(true);

      await rt.stop();
    }
  });

  it("still fires the Msg, and cancels on state exit", async () => {
    const dispatched: Msg[] = [];
    const rt = await run(timeoutMachine(20, false), { subscribe }).ready;
    rt.observe((msg) => dispatched.push(msg));

    await vi.waitFor(() => expect(rt.getState().phase).toBe("expired"));
    expect(dispatched).toEqual([{ _tag: "expired" }]);
    await rt.stop();

    const left = await run(timeoutMachine(20, false), { subscribe }).ready;
    await left.dispatch({ _tag: "leave" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(left.getState().phase).toBe("left");
    await left.stop();
  });
});
