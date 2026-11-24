import { afterEach, describe, expect, it, vi } from "vitest";
import { applyCell } from "../index";
import {
  type DeferredStepResponse,
  type RunStepLoopConfig,
  runStepLoop,
  type StepLoopMsg,
  type StepLoopState,
  type StepRequest,
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

interface PendingSleep {
  readonly ms: number;
  readonly signal: AbortSignal;
  readonly wake: () => void;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function clockAndSleeps() {
  let clock = 0;
  const sleeps: PendingSleep[] = [];
  const slept = deferred<PendingSleep>();
  return {
    sleeps,
    firstSleep: slept.promise,
    config: {
      now: () => clock,
      sleep: (ms: number, signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          const pending = {
            ms,
            signal,
            wake: () => {
              clock += ms;
              resolve();
            },
          };
          sleeps.push(pending);
          if (sleeps.length === 2) slept.resolve(pending);
        }),
    } satisfies Partial<RunStepLoopConfig<string, Input, Output>>,
  };
}

const never = <T>(): Promise<T> => new Promise<T>(() => {});

let warn: ReturnType<typeof vi.spyOn>;
afterEach(() => {
  warn?.mockRestore();
  vi.useRealTimers();
});

describe("runStepLoop's deadline", () => {
  it("ends a drive at its deadline while the transport hangs, after three steps ran, and aborts the transport's signal", async () => {
    warn = vi.spyOn(console, "warn");
    const { sleeps, config } = clockAndSleeps();
    const signals: AbortSignal[] = [];
    const hung = deferred();
    const ran: string[] = [];

    const drive = runStepLoop<string, Input, Output>(
      "token",
      "run-hung-post",
      (_request: StepRequest<string>, { signal }) => {
        signals.push(signal);
        if (signals.length <= 3) return Promise.resolve(stepNo(signals.length));
        hung.resolve();
        return never();
      },
      (next) => {
        ran.push(next.callId);
        return `${next.tool}!`;
      },
      { deadlineMs: 1_000, ...config },
    );
    await hung.promise;
    expect(sleeps.map((s) => s.ms)).toEqual([1_000]);
    sleeps[0]?.wake();

    await expect(drive).resolves.toEqual({ kind: "deadline_exceeded" });
    expect(ran).toEqual(["c1", "c2", "c3"]);
    expect(signals).toHaveLength(4);
    expect(signals.at(-1)?.aborted).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("ends a drive at its deadline while execute hangs, and aborts execute's signal", async () => {
    warn = vi.spyOn(console, "warn");
    const { sleeps, config } = clockAndSleeps();
    const running = deferred<AbortSignal>();

    const drive = runStepLoop<string, Input, Output>(
      "token",
      "run-hung-step",
      async () => stepNo(1),
      (_next, { signal }) => {
        running.resolve(signal);
        return never<string>();
      },
      { deadlineMs: 1_000, ...config },
    );
    const signal = await running.promise;
    expect(signal.aborted).toBe(false);
    sleeps[0]?.wake();

    await expect(drive).resolves.toEqual({ kind: "deadline_exceeded" });
    expect(signal.aborted).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not fail a drive whose hung execute rejects once its signal aborts", async () => {
    const { sleeps, config } = clockAndSleeps();
    const running = deferred();
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
            running.resolve();
            signal.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          }),
        { deadlineMs: 1_000, ...config },
      );
      await running.promise;
      sleeps[0]?.wake();
      await expect(drive).resolves.toEqual({ kind: "deadline_exceeded" });
      await new Promise((r) => setTimeout(r, 10));
      expect(errors).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });

  it("ends a drive at its deadline inside a backoff sleep, and aborts that sleep's signal", async () => {
    const { sleeps, firstSleep, config } = clockAndSleeps();
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
        deadlineMs: 1_000,
        retry: {
          baseMs: 400,
          factor: 1,
          capMs: 400,
          unbounded: true,
          jitter: "none",
        },
        ...config,
      },
    );
    const backoff = await firstSleep;
    expect(backoff.ms).toBe(400);
    sleeps[0]?.wake();

    await expect(drive).resolves.toEqual({ kind: "deadline_exceeded" });
    expect(posts).toBe(1);
    expect(backoff.signal.aborted).toBe(true);
  });

  it("ends a drive at its deadline inside a not-ready poll's sleep", async () => {
    const { sleeps, firstSleep, config } = clockAndSleeps();

    const drive = runStepLoop<string, Input, Output>(
      "token",
      "run-polling",
      async () => ({ done: false, working: true, retryAfterMs: 5_000 }),
      () => "never",
      { deadlineMs: 1_000, ...config },
    );
    const poll = await firstSleep;
    expect(poll.ms).toBe(5_000);
    sleeps[0]?.wake();

    await expect(drive).resolves.toEqual({ kind: "deadline_exceeded" });
    expect(poll.signal.aborted).toBe(true);
  });

  it("leaves no timer pending once a drive finishes before its deadline, with the default sleep", async () => {
    vi.useFakeTimers();
    let served = 0;

    const outcome = await runStepLoop<string, Input, Output>(
      "token",
      "run-early",
      async () =>
        ++served > 3 ? { done: true, output: "ok" } : stepNo(served),
      (next) => `${next.tool}!`,
      { deadlineMs: Date.now() + 60_000 },
    );

    expect(outcome).toEqual({ kind: "done", output: "ok" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends a hung drive on the default sleep's timer and leaves no timer pending", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let settled = false;

    const drive = runStepLoop<string, Input, Output>(
      "token",
      "run-real-timer",
      (_request, call) => {
        signal = call.signal;
        return never();
      },
      () => "never",
      { deadlineMs: Date.now() + 60_000 },
    ).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(drive).resolves.toEqual({ kind: "deadline_exceeded" });
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("arms no timer and aborts nothing mid-drive with deadlineMs: Infinity", async () => {
    const { sleeps, config } = clockAndSleeps();
    const answer = deferred<Response>();
    const asked = deferred<AbortSignal>();
    let abortedWhenAnswered: boolean | undefined;

    const drive = runStepLoop<string, Input, Output>(
      "token",
      "run-unbounded",
      (_request, { signal }) => {
        asked.resolve(signal);
        return answer.promise.then((response) => {
          abortedWhenAnswered = signal.aborted;
          return response;
        });
      },
      () => "never",
      { deadlineMs: Number.POSITIVE_INFINITY, ...config },
    );
    await asked.promise;
    await new Promise((r) => setTimeout(r, 10));
    expect(sleeps).toEqual([]);
    answer.resolve({ done: true, output: "ok" });

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
