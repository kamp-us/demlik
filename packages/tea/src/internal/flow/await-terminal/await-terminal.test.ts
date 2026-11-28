import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DrainTimeoutNotice,
  defineMachine,
  type NoCtx,
  RuntimeDiscardedError,
  type RuntimeErrorContext,
} from "../../../index";
import { run } from "../../../promise";
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
  | { readonly _tag: "start" }
  | { readonly _tag: "finish" }
  | { readonly _tag: "noop" };

const isDone = (s: JobState): boolean => s.phase === "done";

function makeJob(initial: JobState["phase"] = "idle") {
  return defineMachine({
    types: { model: {} as JobState, msg: {} as JobMsg, ctx: {} as NoCtx },
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
    await runtime.dispatch({ _tag: "start" }); // working — not terminal
    await runtime.dispatch({ _tag: "finish" }); // done — terminal

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
    await runtime.dispatch({ _tag: "finish" });
    await terminal;

    const callsAtResolve = calls;
    // Drive two more transitions the detached observer must ignore.
    await runtime.dispatch({ _tag: "noop" });
    await runtime.dispatch({ _tag: "noop" });
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
      await runtime.dispatch({ _tag: "finish" });
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
      { msgs: [{ _tag: "start" }, { _tag: "finish" }] },
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
        { msgs: [{ _tag: "start" }] }, // reaches `working`, never `done`
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

    it("three runs whose Cmd handler never returns each reject at the window", async () => {
      // stop() gives up on the handler at `disposeTimeoutMs` and says so; the
      // default sink warns, which is noise here.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      type StuckMsg = { readonly _tag: "start" };
      type StuckCmd = { readonly _tag: "hang" };
      const stuck = defineMachine({
        types: {
          model: {} as JobState,
          msg: {} as StuckMsg,
          cmd: {} as StuckCmd,
          ctx: {} as NoCtx,
        },
        init: () => [{ phase: "idle" }, []],
        update: { start: () => [{ phase: "working" }, [{ _tag: "hang" }]] },
      });
      const outcomes = [1, 2, 3].map(() =>
        runToTerminal(
          stuck,
          {
            interpret: { hang: () => new Promise<void>(() => {}) },
            msgs: [{ _tag: "start" }],
          },
          isDone,
          { timeoutMs: 100 },
        ).then(
          () => "resolved",
          (error: unknown) => error,
        ),
      );

      // Just short of the window nothing has settled; at it, all three reject.
      // The rejection does not wait out stop()'s 5_000ms default limit.
      let settled = 0;
      for (const outcome of outcomes) void outcome.then(() => settled++);
      await vi.advanceTimersByTimeAsync(99);
      expect(settled).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(3);
      for (const outcome of outcomes) {
        expect(await outcome).toBeInstanceOf(TerminalTimeoutError);
      }

      // The teardown it started finishes on its own, at stop()'s limit.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(vi.getTimerCount()).toBe(0);
      warn.mockRestore();
    });

    it("hands a seed's onError the discard its teardown reports, where the default sink would warn", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const heard: { error: unknown; context: RuntimeErrorContext }[] = [];
      type StuckMsg = { readonly _tag: "start" };
      type StuckCmd = { readonly _tag: "hang" };
      const stuck = defineMachine({
        types: {
          model: {} as JobState,
          msg: {} as StuckMsg,
          cmd: {} as StuckCmd,
          ctx: {} as NoCtx,
        },
        init: () => [{ phase: "idle" }, []],
        update: { start: () => [{ phase: "working" }, [{ _tag: "hang" }]] },
      });
      const outcome = runToTerminal(
        stuck,
        {
          interpret: { hang: () => new Promise<void>(() => {}) },
          onError: (error, context) => void heard.push({ error, context }),
          msgs: [{ _tag: "start" }],
        },
        isDone,
        { timeoutMs: 100 },
      ).catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(100);
      expect(await outcome).toBeInstanceOf(TerminalTimeoutError);

      // The run stopped with the handler in flight: the sink hears the discard,
      // and so does it hear stop() giving up on that handler at its limit.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(heard.map(({ error }) => error)).toEqual([
        expect.any(RuntimeDiscardedError),
        expect.any(DrainTimeoutNotice),
      ]);
      expect(heard.map(({ context }) => context)).toEqual([
        { phase: "discard" },
        { phase: "discard" },
      ]);
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });
});

describe("runToTerminal with cancellation", () => {
  interface CancelState {
    readonly phase: "idle" | "working" | "done" | "halted";
  }
  type CancelMsg =
    | { readonly _tag: "start" }
    | { readonly _tag: "worked" }
    | { readonly _tag: "halt" }
    | { readonly _tag: "pause" };
  type CancelCmd = { readonly _tag: "work" };

  const ended = (s: CancelState): boolean =>
    s.phase === "done" || s.phase === "halted";
  const halt = (): CancelMsg => ({ _tag: "halt" });

  const cancellable = defineMachine({
    types: {
      model: {} as CancelState,
      msg: {} as CancelMsg,
      cmd: {} as CancelCmd,
      ctx: {} as NoCtx,
    },
    init: (loaded) => [loaded ?? { phase: "idle" }, []],
    update: {
      start: () => [{ phase: "working" }, [{ _tag: "work" }]],
      worked: () => [{ phase: "done" }, []],
      halt: (s) => (s.phase === "done" ? [s, []] : [{ phase: "halted" }, []]),
      pause: (s) => [s, []],
    },
  });

  const hung = () => {
    const calls: string[] = [];
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const interpret = {
      work: (): Promise<CancelMsg> => {
        calls.push("work");
        entered();
        return new Promise<CancelMsg>(() => {});
      },
    };
    return { calls, started, interpret };
  };

  it("three runs aborted while their Cmd handler hangs each resolve halted without waiting on it", async () => {
    const outcomes = [1, 2, 3].map(async () => {
      const controller = new AbortController();
      const { calls, started, interpret } = hung();
      const t0 = Date.now();
      const terminal = runToTerminal(
        cancellable,
        {
          interpret,
          cancellation: { signal: controller.signal, cancel: halt },
          msgs: [{ _tag: "start" }],
        },
        ended,
      );
      await started;
      controller.abort();
      const state = await terminal;
      return { state, calls, elapsed: Date.now() - t0 };
    });

    for (const { state, calls, elapsed } of await Promise.all(outcomes)) {
      expect(state).toEqual({ phase: "halted" });
      expect(calls).toEqual(["work"]);
      expect(elapsed).toBeLessThan(1_000);
    }
  });

  it("a signal already aborted before the call resolves halted and starts no Cmd", async () => {
    const controller = new AbortController();
    controller.abort();
    const { calls, interpret } = hung();

    const state = await runToTerminal(
      cancellable,
      {
        interpret,
        cancellation: { signal: controller.signal, cancel: halt },
        msgs: [{ _tag: "start" }],
      },
      ended,
    );

    expect(state).toEqual({ phase: "halted" });
    expect(calls).toEqual([]);
  });

  it("a seed without cancellation runs to the handler's answer as before", async () => {
    const state = await runToTerminal(
      cancellable,
      {
        interpret: {
          work: async (): Promise<CancelMsg> => ({ _tag: "worked" }),
        },
        msgs: [{ _tag: "start" }],
      },
      ended,
    );
    expect(state).toEqual({ phase: "done" });
  });

  it("a cancel that lands a State isTerminal rejects leaves the await to its timeout", async () => {
    const controller = new AbortController();
    controller.abort();
    const { interpret } = hung();

    await expect(
      runToTerminal(
        cancellable,
        {
          interpret,
          cancellation: {
            signal: controller.signal,
            cancel: (): CancelMsg => ({ _tag: "pause" }),
          },
          msgs: [],
        },
        ended,
        { timeoutMs: 50 },
      ),
    ).rejects.toBeInstanceOf(TerminalTimeoutError);
  });
});
