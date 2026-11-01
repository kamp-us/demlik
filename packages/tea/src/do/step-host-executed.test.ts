/**
 * `runStepLoop` over a caller's `executed` store: hands that restart mid-run do
 * not run a step twice.
 *
 * A restart is a transport that fails the POST carrying a result, with one retry
 * allowed, so the drive ends with the step run and its result undelivered. The
 * next drive is a new `runStepLoop` call that starts from `posted: null`, exactly
 * like a new process. Only the store carries over.
 */

import { describe, expect, it } from "vitest";
import {
  type ExecutedStep,
  type ExecutedSteps,
  type NextStep,
  type RunStepLoopConfig,
  runStepLoop,
  type StepLoopOutcome,
  type StepRequest,
  type StepResponse,
  type StepTransport,
} from "./step-host";

type Input = { readonly arg: string };

const STEPS = ["a", "b", "c", "d", "e"].map((name) => ({
  callId: `run-1:${name}`,
  tool: name,
  input: { arg: name },
}));

/**
 * A fake host holding a fixed script. It waits on one step at a time, re-hands
 * that step until a result for it arrives, and records every result it absorbs.
 * It only keeps state a real checkpoint would: a restart of the hands changes
 * nothing here.
 */
function fakeHost<R>(script: readonly NextStep<Input>[]) {
  const received: { readonly callId: string; readonly result: R }[] = [];
  const respond = (
    request: StepRequest<R>,
  ): StepResponse<Input, readonly R[]> => {
    const { posted } = request;
    if (posted !== null && posted.callId === script[received.length]?.callId) {
      received.push(posted);
    }
    const waitingOn = script[received.length];
    return waitingOn === undefined
      ? { done: true, output: received.map((entry) => entry.result) }
      : { done: false, step: waitingOn };
  };
  return { received, respond };
}

/** A process-outliving store, as far as the drives under test can tell. */
function sharedStore<R>(): ExecutedSteps<R> {
  const steps = new Map<string, ExecutedStep<R>>();
  return {
    get: (callId) => steps.get(callId),
    set: (callId, step) => {
      steps.set(callId, step);
    },
  };
}

/** One attempt per POST, so one failed POST ends the drive at once. */
const ONE_DRIVE = {
  deadlineMs: Number.POSITIVE_INFINITY,
  now: () => 0,
  retry: {
    baseMs: 1,
    factor: 2,
    capMs: 1,
    maxAttempts: 1,
    jitter: "none",
  },
} as const;

/**
 * Hands that die on the POST of every result they have not delivered yet. Each
 * step costs one drive to run it and part of the next to deliver it.
 */
async function driveWithRestartAfterEveryStep<R>(
  host: ReturnType<typeof fakeHost<R>>,
  execute: (step: NextStep<Input>) => R | Promise<R>,
  executed: ExecutedSteps<R>,
): Promise<{
  readonly outcomes: readonly StepLoopOutcome<readonly R[]>[];
  readonly drives: number;
}> {
  const died = new Set<string>();
  const outcomes: StepLoopOutcome<readonly R[]>[] = [];
  for (;;) {
    const transport: StepTransport<R, Input, readonly R[]> = async (
      request,
    ) => {
      const callId = request.posted?.callId;
      if (callId !== undefined && !died.has(callId)) {
        died.add(callId);
        throw new Error(`hands died before posting ${callId}`);
      }
      return host.respond(request);
    };
    const outcome = await runStepLoop("token", "run-1", transport, execute, {
      ...ONE_DRIVE,
      executed,
    });
    outcomes.push(outcome);
    if (outcome.kind !== "gave_up") {
      return { outcomes, drives: outcomes.length };
    }
    if (outcomes.length > 20) throw new Error("the run never finished");
  }
}

function countingExecute<R>(resultOf: (step: NextStep<Input>) => R) {
  const calls: string[] = [];
  const execute = (step: NextStep<Input>): R => {
    calls.push(step.callId);
    return resultOf(step);
  };
  return { calls, execute };
}

describe("runStepLoop — executed store across restarts", () => {
  it("runs each of five steps once when the hands restart after every step", async () => {
    const host = fakeHost<string>(STEPS);
    const { calls, execute } = countingExecute((step) => `${step.tool}!`);

    const { outcomes, drives } = await driveWithRestartAfterEveryStep(
      host,
      execute,
      sharedStore<string>(),
    );

    // One drive died per step, then one finished the run.
    expect(drives).toBe(STEPS.length + 1);
    expect(outcomes.at(-1)).toEqual({
      kind: "done",
      output: ["a!", "b!", "c!", "d!", "e!"],
    });
    expect(calls).toEqual(STEPS.map((step) => step.callId));
    expect(host.received).toEqual(
      STEPS.map((step) => ({
        callId: step.callId,
        result: `${step.tool}!`,
      })),
    );
  });

  it("re-POSTs the saved result without executing when hands died before the POST", async () => {
    const [first, second] = STEPS;
    if (first === undefined || second === undefined) throw new Error("script");
    const host = fakeHost<string>([first, second]);
    const executed = sharedStore<string>();
    const { calls, execute } = countingExecute((step) => `${step.tool}!`);

    const dying: StepTransport<string, Input, readonly string[]> = async (
      request,
    ) => {
      if (request.posted !== null) throw new Error("hands died");
      return host.respond(request);
    };
    const died = await runStepLoop("token", "run-1", dying, execute, {
      ...ONE_DRIVE,
      executed,
    });
    expect(died.kind).toBe("gave_up");
    expect(calls).toEqual([first.callId]);
    expect(host.received).toEqual([]);

    const posts: (string | null)[] = [];
    const alive: StepTransport<string, Input, readonly string[]> = async (
      request,
    ) => {
      posts.push(request.posted?.result ?? null);
      return host.respond(request);
    };
    const outcome = await runStepLoop("token", "run-1", alive, execute, {
      ...ONE_DRIVE,
      executed,
    });

    expect(outcome).toEqual({ kind: "done", output: ["a!", "b!"] });
    // The second drive's first real POST is the first step's saved result.
    expect(posts).toEqual([null, "a!", "b!"]);
    expect(calls).toEqual([first.callId, second.callId]);
  });

  it("does not run a saved step again when the host re-hands it after the POST landed", async () => {
    const [only] = STEPS;
    if (only === undefined) throw new Error("script");
    const executed = sharedStore<string>();
    const { calls, execute } = countingExecute(() => "once");

    // The host answers with the same step twice, then finishes.
    let answers = 0;
    const rehands: StepTransport<string, Input, string> = async () => {
      answers += 1;
      return answers <= 2
        ? { done: false, step: only }
        : { done: true, output: "finished" };
    };

    const outcome = await runStepLoop("token", "run-1", rehands, execute, {
      ...ONE_DRIVE,
      executed,
    });

    expect(outcome).toEqual({ kind: "done", output: "finished" });
    expect(calls).toEqual([only.callId]);
  });

  it("runs a step whose result is undefined once across restarts", async () => {
    const host = fakeHost<undefined>(STEPS);
    const { calls, execute } = countingExecute(() => undefined);

    const { outcomes } = await driveWithRestartAfterEveryStep(
      host,
      execute,
      sharedStore<undefined>(),
    );

    expect(outcomes.at(-1)?.kind).toBe("done");
    expect(calls).toEqual(STEPS.map((step) => step.callId));
  });

  it("runs an undefined result once over a store that writes JSON text", async () => {
    // A file-backed store's shape: nothing survives but the serialized text.
    const lines = new Map<string, string>();
    const onDisk: ExecutedSteps<undefined> = {
      get: (callId) => {
        const line = lines.get(callId);
        return line === undefined ? undefined : JSON.parse(line);
      },
      set: (callId, step) => {
        lines.set(callId, JSON.stringify(step));
      },
    };
    const host = fakeHost<undefined>(STEPS);
    const { calls, execute } = countingExecute(() => undefined);

    const { outcomes } = await driveWithRestartAfterEveryStep(
      host,
      execute,
      onDisk,
    );

    expect(outcomes.at(-1)?.kind).toBe("done");
    expect(calls).toEqual(STEPS.map((step) => step.callId));
  });
});

describe("runStepLoop — async and failing stores", () => {
  it("works the same over a store that answers with Promises", async () => {
    const steps = new Map<string, ExecutedStep<string>>();
    const asyncStore: ExecutedSteps<string> = {
      get: async (callId) => {
        await Promise.resolve();
        return steps.get(callId);
      },
      set: async (callId, step) => {
        await Promise.resolve();
        steps.set(callId, step);
      },
    };
    const host = fakeHost<string>(STEPS);
    const { calls, execute } = countingExecute((step) => `${step.tool}!`);

    const { outcomes, drives } = await driveWithRestartAfterEveryStep(
      host,
      execute,
      asyncStore,
    );

    expect(drives).toBe(STEPS.length + 1);
    expect(outcomes.at(-1)).toEqual({
      kind: "done",
      output: ["a!", "b!", "c!", "d!", "e!"],
    });
    expect(calls).toEqual(STEPS.map((step) => step.callId));
  });

  it("ends the drive gave_up when set rejects, posting nothing and running nothing more", async () => {
    const boom = new Error("disk full");
    const host = fakeHost<string>(STEPS);
    const posts: (string | null)[] = [];
    const transport: StepTransport<string, Input, readonly string[]> = async (
      request,
    ) => {
      posts.push(request.posted?.callId ?? null);
      return host.respond(request);
    };
    const { calls, execute } = countingExecute((step) => `${step.tool}!`);

    const outcome = await runStepLoop("token", "run-1", transport, execute, {
      ...ONE_DRIVE,
      executed: {
        get: () => undefined,
        set: () => Promise.reject(boom),
      },
    });

    expect(outcome).toEqual({ kind: "gave_up", error: boom });
    expect(calls).toHaveLength(1);
    expect(posts).toEqual([null]);
    expect(host.received).toEqual([]);
  });

  it("ends the drive gave_up when a plain set throws", async () => {
    const boom = new Error("read-only");
    const host = fakeHost<string>(STEPS);
    const { calls, execute } = countingExecute((step) => `${step.tool}!`);

    const outcome = await runStepLoop(
      "token",
      "run-1",
      async (request: StepRequest<string>) => host.respond(request),
      execute,
      {
        ...ONE_DRIVE,
        executed: {
          get: () => undefined,
          set: () => {
            throw boom;
          },
        },
      },
    );

    expect(outcome).toEqual({ kind: "gave_up", error: boom });
    expect(calls).toHaveLength(1);
  });

  it("ends the drive gave_up without executing when get rejects", async () => {
    const boom = new Error("store offline");
    const host = fakeHost<string>(STEPS);
    const { calls, execute } = countingExecute((step) => `${step.tool}!`);

    const outcome = await runStepLoop(
      "token",
      "run-1",
      async (request: StepRequest<string>) => host.respond(request),
      execute,
      {
        ...ONE_DRIVE,
        executed: {
          get: () => Promise.reject(boom),
          set: () => undefined,
        },
      },
    );

    expect(outcome).toEqual({ kind: "gave_up", error: boom });
    expect(calls).toEqual([]);
  });

  it("still rejects the drive when execute throws, saving nothing", async () => {
    const boom = new Error("step failed");
    const host = fakeHost<string>(STEPS);
    const executed = sharedStore<string>();
    const [first] = STEPS;
    if (first === undefined) throw new Error("script");

    await expect(
      runStepLoop(
        "token",
        "run-1",
        async (request: StepRequest<string>) => host.respond(request),
        () => {
          throw boom;
        },
        { ...ONE_DRIVE, executed },
      ),
    ).rejects.toBe(boom);
    expect(await executed.get(first.callId)).toBeUndefined();
  });
});

describe("runStepLoop — with no executed store", () => {
  it("remembers a step inside one drive, even one whose result is undefined", async () => {
    const [only] = STEPS;
    if (only === undefined) throw new Error("script");
    const { calls, execute } = countingExecute(() => undefined);

    let answers = 0;
    const rehands: StepTransport<undefined, Input, string> = async () => {
      answers += 1;
      return answers <= 2
        ? { done: false, step: only }
        : { done: true, output: "finished" };
    };

    await runStepLoop("token", "run-1", rehands, execute, ONE_DRIVE);

    expect(calls).toEqual([only.callId]);
  });

  it("forgets across a restart, because the memory lived in that drive", async () => {
    const [only] = STEPS;
    if (only === undefined) throw new Error("script");
    const { calls, execute } = countingExecute(() => "again");

    const dying: StepTransport<string, Input, string> = async (request) => {
      if (request.posted !== null) throw new Error("hands died");
      return { done: false, step: only };
    };
    await runStepLoop("token", "run-1", dying, execute, ONE_DRIVE);
    await runStepLoop("token", "run-1", dying, execute, ONE_DRIVE);

    expect(calls).toEqual([only.callId, only.callId]);
  });

  it("takes a config typed with no type argument in a drive of any result type", async () => {
    // Compile-time as much as runtime: a bare `RunStepLoopConfig` has to stay
    // assignable where the drive's own `R` is concrete.
    const bare: RunStepLoopConfig = {
      deadlineMs: Number.POSITIVE_INFINITY,
      now: () => 0,
    };
    const transport: StepTransport<string, Input, string> = async () => ({
      done: true,
      output: "finished",
    });

    const outcome = await runStepLoop<string, Input, string>(
      "token",
      "run-1",
      transport,
      (step) => step.tool,
      bare,
    );

    expect(outcome).toEqual({ kind: "done", output: "finished" });
  });
});
