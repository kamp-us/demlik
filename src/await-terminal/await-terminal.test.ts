import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineMachine, type NoCtx, run } from "../index";
import { awaitTerminal, runToTerminal, TerminalTimeoutError } from "./index";

// ===========================================================================
// A tiny one-shot decision machine: idle → working → done. `done` is the
// caller-named terminal state; `noop` is a non-terminal transition used to
// prove the observer is detached after resolve (the no-leak case).
// ===========================================================================

interface JobState {
  readonly phase: "idle" | "working" | "done";
}

type JobMsg =
  | { readonly type: "start" }
  | { readonly type: "finish" }
  | { readonly type: "noop" };

const isDone = (s: JobState): boolean => s.phase === "done";

function makeJob(initial: JobState["phase"] = "idle") {
  return defineMachine<JobState, JobMsg, never, never, NoCtx>({
    init: (loaded) => [loaded ?? { phase: initial }, []],
    update: {
      start: () => [{ phase: "working" }, []],
      finish: () => [{ phase: "done" }, []],
      noop: (s) => [s, []],
    },
  });
}

describe("awaitTerminal", () => {
  it("resolves immediately when the runtime is already terminal at attach", async () => {
    const runtime = await run(makeJob("done"), {}).ready;

    // No transition will ever arrive on this machine, so this await returning at
    // all is the immediate-terminal path (it would hang otherwise).
    const state = await awaitTerminal(runtime, isDone);
    expect(state).toEqual({ phase: "done" });

    await runtime.stop();
  });

  it("resolves with the terminal state on the first terminal transition", async () => {
    const runtime = await run(makeJob("idle"), {}).ready;

    const terminal = awaitTerminal(runtime, isDone);
    await runtime.dispatch({ type: "start" }); // working — not terminal
    await runtime.dispatch({ type: "finish" }); // done — terminal

    const state = await terminal;
    expect(state).toEqual({ phase: "done" });

    await runtime.stop();
  });

  it("detaches its observe subscription on resolve (no leak, no further callbacks)", async () => {
    const runtime = await run(makeJob("idle"), {}).ready;

    // The predicate counts its own calls; after resolve, further transitions must
    // NOT call it — proving the observer was detached.
    let calls = 0;
    const countingIsDone = (s: JobState): boolean => {
      calls += 1;
      return s.phase === "done";
    };

    const terminal = awaitTerminal(runtime, countingIsDone);
    await runtime.dispatch({ type: "finish" });
    await terminal;

    const callsAtResolve = calls;
    // Drive two more transitions the detached observer must ignore.
    await runtime.dispatch({ type: "noop" });
    await runtime.dispatch({ type: "noop" });
    expect(calls).toBe(callsAtResolve);

    await runtime.stop();
  });

  describe("timeout", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("rejects with an instanceof-checkable TerminalTimeoutError when the deadline elapses", async () => {
      const runtime = await run(makeJob("idle"), {}).ready;

      const terminal = awaitTerminal(runtime, isDone, { timeoutMs: 1000 });
      const assertion =
        expect(terminal).rejects.toBeInstanceOf(TerminalTimeoutError);
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;

      await runtime.stop();
    });

    it("clears the timer on resolve so a resolved await never later rejects or leaves a dangling timer", async () => {
      const runtime = await run(makeJob("idle"), {}).ready;

      const terminal = awaitTerminal(runtime, isDone, { timeoutMs: 1000 });
      await runtime.dispatch({ type: "finish" });
      await expect(terminal).resolves.toEqual({ phase: "done" });

      // The resolve path cleared the timer — no pending timer remains, so
      // advancing past the deadline produces no late rejection.
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(5000);

      await runtime.stop();
    });
  });
});

describe("runToTerminal", () => {
  it("boots, dispatches the seed msgs, and resolves with the terminal state", async () => {
    const state = await runToTerminal(
      makeJob("idle"),
      { msgs: [{ type: "start" }, { type: "finish" }] },
      isDone,
    );
    expect(state).toEqual({ phase: "done" });
  });

  it("resolves immediately for a machine that boots already terminal", async () => {
    const state = await runToTerminal(makeJob("done"), { msgs: [] }, isDone);
    expect(state).toEqual({ phase: "done" });
  });

  describe("timeout", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("rejects with TerminalTimeoutError and tears the runtime down when no terminal is reached", async () => {
      const terminal = runToTerminal(
        makeJob("idle"),
        { msgs: [{ type: "start" }] }, // reaches `working`, never `done`
        isDone,
        { timeoutMs: 1000 },
      );
      const assertion =
        expect(terminal).rejects.toBeInstanceOf(TerminalTimeoutError);
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;

      // The reject path ran runtime.stop(): no timers dangle after teardown.
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
