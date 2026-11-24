import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyCell } from "../index";
import {
  type DeferredStepResponse,
  runStepLoop,
  type StepLoopMsg,
  type StepLoopState,
  stepLoopMachine,
} from "./step-host";

type Input = { readonly arg: string };
type Output = string;
type State = StepLoopState<string, Input, Output>;
type Msg = StepLoopMsg<string, Input, Output>;
type Response = DeferredStepResponse<Input, Output>;

const machine = stepLoopMachine<string, Input, Output>();

const stepNo = (n: number): Response => ({
  done: false,
  step: { callId: `c${n}`, tool: "tick", input: { arg: `${n}` } },
});

const never = <T>(): Promise<T> => new Promise<T>(() => {});

const threeStepsThenDone = () => {
  let served = 0;
  return async (): Promise<Response> =>
    ++served > 3 ? { done: true, output: "ok" } : stepNo(served);
};

describe("runStepLoop with a virtual-time clock", () => {
  it("finishes a drive whose sleep moves the clock, as it did before the deadline timer", async () => {
    let at = 0;
    const ran: string[] = [];

    const outcome = await runStepLoop<string, Input, Output>(
      "token",
      "run-virtual",
      threeStepsThenDone(),
      (next) => {
        ran.push(next.callId);
        return `${next.tool}!`;
      },
      {
        deadlineMs: 60_000,
        now: () => at,
        sleep: async (ms) => {
          at += ms;
        },
      },
    );

    expect(outcome).toEqual({ kind: "done", output: "ok" });
    expect(ran).toEqual(["c1", "c2", "c3"]);
  });
});

describe("runStepLoop's deadline", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers();
    warn = vi.spyOn(console, "warn");
  });
  afterEach(() => {
    warn.mockRestore();
    vi.useRealTimers();
  });

  it("ends a drive at its deadline while the transport hangs, after three steps ran, and aborts the transport's signal", async () => {
    const signals: AbortSignal[] = [];
    const ran: string[] = [];
    let settled = false;

    const drive = runStepLoop<string, Input, Output>(
      "token",
      "run-hung-post",
      (_request, { signal }) => {
        signals.push(signal);
        return signals.length <= 3
          ? Promise.resolve(stepNo(signals.length))
          : never();
      },
      (next) => {
        ran.push(next.callId);
        return `${next.tool}!`;
      },
      { deadlineMs: Date.now() + 1_000 },
    ).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    expect(signals).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);

    await expect(drive).resolves.toEqual({ kind: "deadline_exceeded" });
    expect(ran).toEqual(["c1", "c2", "c3"]);
    expect(signals.at(-1)?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("ends a drive at its deadline while execute hangs, and aborts execute's signal", async () => {
    let signal: AbortSignal | undefined;

    const drive = runStepLoop<string, Input, Output>(
      "token",
      "run-hung-step",
      async () => stepNo(1),
      (_next, call) => {
        signal = call.signal;
        return never<string>();
      },
      { deadlineMs: Date.now() + 1_000 },
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(500);

    await expect(drive).resolves.toEqual({ kind: "deadline_exceeded" });
    expect(signal?.aborted).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not fail a drive whose hung execute rejects once its signal aborts", async () => {
    const errors: unknown[] = [];
    const onUncaught = (error: unknown) => errors.push(error);
    process.on("uncaughtException", onUncaught);
    try {
      const drive = runStepLoop<string, Input, Output>(
        "token",
        "run-aborting-step",
        async () => stepNo(1),
        (_next, { signal }) =>
          new Promise<string>((_resolve, reject) => {
            signal.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          }),
        { deadlineMs: Date.now() + 1_000 },
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(drive).resolves.toEqual({ kind: "deadline_exceeded" });
      await vi.runAllTimersAsync();
      expect(errors).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

  it("does not start execute when the deadline fell due while the store was read", async () => {
    let started = 0;

    const drive = runStepLoop<string, Input, Output>(
      "token",
      "run-late-get",
      async () => stepNo(1),
      () => {
        started += 1;
        return "ran";
      },
      {
        deadlineMs: Date.now() + 1_000,
        executed: {
          get: () =>
            new Promise((resolve) =>
              setTimeout(() => resolve(undefined), 2_000),
            ),
          set: () => {},
        },
      },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(drive).resolves.toEqual({ kind: "deadline_exceeded" });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(started).toBe(0);
  });

  it("ends a drive at its deadline inside a backoff sleep, and aborts that sleep's signal", async () => {
    const sleeps: { ms: number; signal: AbortSignal }[] = [];
    let posts = 0;

    const drive = runStepLoop<string, Input, Output>(
      "token",
      "run-backing-off",
      async () => {
        posts += 1;
        throw new Error("down");
      },
      () => "never",
      {
        deadlineMs: Date.now() + 1_000,
        retry: {
          baseMs: 400,
          factor: 1,
          capMs: 400,
          unbounded: true,
          jitter: "none",
        },
        sleep: (ms, signal) => {
          sleeps.push({ ms, signal });
          return new Promise((resolve) => setTimeout(resolve, ms));
        },
      },
    );
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(drive).resolves.toEqual({ kind: "deadline_exceeded" });
    expect(posts).toBe(3);
    expect(sleeps.map((s) => s.ms)).toEqual([400, 400, 400]);
    expect(sleeps.at(-1)?.signal.aborted).toBe(true);
  });

  it("ends a drive at its deadline inside a not-ready poll's sleep", async () => {
    let poll: AbortSignal | undefined;

    const drive = runStepLoop<string, Input, Output>(
      "token",
      "run-polling",
      async () => ({ done: false, working: true, retryAfterMs: 5_000 }),
      () => "never",
      {
        deadlineMs: Date.now() + 1_000,
        sleep: (ms, signal) => {
          poll = signal;
          return new Promise((resolve) => setTimeout(resolve, ms));
        },
      },
    );
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(drive).resolves.toEqual({ kind: "deadline_exceeded" });
    expect(poll?.aborted).toBe(true);
  });

  it("leaves no timer pending once a drive finishes before its deadline, with the default sleep", async () => {
    const outcome = await runStepLoop<string, Input, Output>(
      "token",
      "run-early",
      threeStepsThenDone(),
      (next) => `${next.tool}!`,
      { deadlineMs: Date.now() + 60_000 },
    );

    expect(outcome).toEqual({ kind: "done", output: "ok" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves no timer pending once a drive finishes, with a sleep that ignores its signal", async () => {
    const outcome = await runStepLoop<string, Input, Output>(
      "token",
      "run-ignoring-sleep",
      threeStepsThenDone(),
      (next) => `${next.tool}!`,
      { deadlineMs: Date.now() + 60_000, sleep: async () => {} },
    );

    expect(outcome).toEqual({ kind: "done", output: "ok" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("holds a deadline longer than a timer can, by arming it again for what is left", async () => {
    const longest = 2 ** 31 - 1;
    const emitted = vi.spyOn(process, "emitWarning");
    let settled = false;
    try {
      const drive = runStepLoop<string, Input, Output>(
        "token",
        "run-far",
        () => never(),
        () => "never",
        { deadlineMs: Date.now() + longest + 5_000 },
      ).finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(longest);
      expect(settled).toBe(false);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      await expect(drive).resolves.toEqual({ kind: "deadline_exceeded" });
      expect(vi.getTimerCount()).toBe(0);
      expect(emitted).not.toHaveBeenCalled();
    } finally {
      emitted.mockRestore();
    }
  });

  it("rejects the drive with what now throws when the deadline timer reads it", async () => {
    const broken = new Error("clock broke");
    let reads = 0;

    const drive = runStepLoop<string, Input, Output>(
      "token",
      "run-broken-clock",
      () => never(),
      () => "never",
      {
        deadlineMs: 1_000,
        now: () => {
          reads += 1;
          if (reads > 1) throw broken;
          return 0;
        },
      },
    );
    const settled = expect(drive).rejects.toBe(broken);
    await vi.advanceTimersByTimeAsync(1_000);

    await settled;
  });

  it("arms no timer and aborts nothing mid-drive with deadlineMs: Infinity", async () => {
    let answer: ((response: Response) => void) | undefined;
    let abortedWhenAnswered: boolean | undefined;

    const drive = runStepLoop<string, Input, Output>(
      "token",
      "run-unbounded",
      (_request, { signal }) =>
        new Promise<Response>((resolve) => {
          answer = (response) => {
            abortedWhenAnswered = signal.aborted;
            resolve(response);
          };
        }),
      () => "never",
      { deadlineMs: Number.POSITIVE_INFINITY },
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(vi.getTimerCount()).toBe(0);
    answer?.({ done: true, output: "ok" });

    await expect(drive).resolves.toEqual({ kind: "done", output: "ok" });
    expect(abortedWhenAnswered).toBe(false);
  });

  it("keeps a finished State when the deadline falls due after it", () => {
    const finished: State = {
      _tag: "finished",
      outcome: { kind: "done", output: "ok" },
    };
    const [next, cmds] = applyCell<State, Msg, never>(machine, finished, {
      _tag: "deadline_passed",
    });
    expect(next).toBe(finished);
    expect(cmds).toEqual([]);
  });
});
