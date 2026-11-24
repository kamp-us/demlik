/**
 * `runStepLoop` runs as a tea machine, so `recorder` attaches to it like to any
 * run. A drive that fails after a retry is recorded, written as JSONL, read
 * back and replayed: the recording carries the values each decision read, so
 * the replay reproduces the transitions with no second model of the loop.
 */

import { describe, expect, it } from "vitest";
import {
  parseJSONL,
  type Recorder,
  recorder,
  replayStoredTrace,
  replayTrace,
  type Trace,
} from "../persistence";
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

const machine = stepLoopMachine<string, Input, Output>();

const step: DeferredStepResponse<Input, Output> = {
  done: false,
  step: { callId: "c1", tool: "alpha", input: { arg: "a" } },
};

type Answer = DeferredStepResponse<Input, Output> | Error;

/** A drive answered from `answers` in order, recorded from before it boots. */
async function drive(
  answers: Answer[],
  config: Partial<RunStepLoopConfig<string, Input, Output>> = {},
) {
  const requests: StepRequest<string>[] = [];
  const sleeps: number[] = [];
  let tick = 0;
  let recording: Recorder<State, Msg> | undefined;

  const outcome = await runStepLoop<string, Input, Output>(
    "token",
    "run-1",
    async (request) => {
      requests.push(request);
      const answer = answers.shift();
      if (answer === undefined) throw new Error("the script ran out");
      if (answer instanceof Error) throw answer;
      return answer;
    },
    (next) => `${next.tool}!`,
    {
      deadlineMs: Number.POSITIVE_INFINITY,
      now: () => tick++,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      ...config,
      attach: (runtime) => {
        recording = recorder(runtime, { captureSteps: true });
      },
    },
  );

  if (recording === undefined) throw new Error("attach was not called");
  return { outcome, requests, sleeps, recording };
}

/** A drive that polls a not-ready host, runs one step, then loses the transport twice. */
const failAfterARetry = () =>
  drive(
    [
      { done: false, working: true, retryAfterMs: 5 },
      step,
      new Error("down"),
      new Error("still down"),
    ],
    {
      retry: {
        baseMs: 10,
        factor: 2,
        capMs: 100,
        maxAttempts: 2,
        jitter: "none",
      },
    },
  );

describe("runStepLoop as a machine", () => {
  it("records a drive that fails after a retry, with the posted result and the response in its Msgs", async () => {
    const { outcome, requests, sleeps, recording } = await failAfterARetry();
    const trace = recording.dump();

    expect(outcome).toEqual({
      kind: "gave_up",
      error: new Error("still down"),
    });
    expect(requests.map((r) => r.posted)).toEqual([
      null,
      null,
      { callId: "c1", result: "alpha!" },
      { callId: "c1", result: "alpha!" },
    ]);
    expect(sleeps).toEqual([5, 20]);

    expect(trace.msgs.map((m) => m._tag)).toEqual([
      "start",
      "clock_read",
      "responded",
      "clock_read",
      "slept",
      "clock_read",
      "responded",
      "step_ran",
      "clock_read",
      "post_failed",
      "clock_read",
      "slept",
      "post_failed",
      "clock_read",
    ]);
    expect(trace.msgs).toContainEqual({ _tag: "responded", response: step });
    expect(trace.msgs).toContainEqual({
      _tag: "step_ran",
      callId: "c1",
      result: "alpha!",
    });
    expect(trace.steps?.flatMap((s) => s.cmds ?? [])).toContainEqual({
      _tag: "post",
      posted: { callId: "c1", result: "alpha!" },
    });
    expect(trace.finalState).toEqual({
      _tag: "finished",
      outcome: { kind: "gave_up", error: new Error("still down") },
    });
  });

  it("replays the recording as it was made, and from the text it was written to", async () => {
    const { recording } = await failAfterARetry();
    const trace: Trace<State, Msg> = recording.dump();
    const written = recording.toJSONL();

    const replayed = replayTrace(machine, trace);
    const stored = replayStoredTrace(
      machine,
      parseJSONL<unknown, { readonly _tag: string }>(written),
    );
    const typed = replayTrace(machine, parseJSONL<State, Msg>(written));

    expect(replayed.matches).toBe(true);
    expect(stored.matches).toBe(true);
    expect(typed.matches).toBe(true);
    expect(stored.states).toHaveLength(trace.msgs.length);
  });

  it("rejects with what a hook throws, not with the failure it was asked about", async () => {
    const down = async (): Promise<DeferredStepResponse<Input, Output>> => {
      throw new Error("down");
    };
    const refusal = new Error("retryable threw");
    const outage = new Error("sleep threw");
    const drive = (config: Partial<RunStepLoopConfig<string, Input, Output>>) =>
      runStepLoop<string, Input, Output>("token", "run-2", down, () => "r", {
        deadlineMs: Number.POSITIVE_INFINITY,
        now: () => 0,
        ...config,
      });

    await expect(
      drive({
        retryable: () => {
          throw refusal;
        },
      }),
    ).rejects.toBe(refusal);
    await expect(
      drive({
        sleep: async () => {
          throw outage;
        },
      }),
    ).rejects.toBe(outage);
  });

  it("gives up at the first failure when retry.maxElapsedMs is NaN, with no sleep, as the loop it replaced did", async () => {
    const { outcome, requests, sleeps } = await drive(
      [new Error("down"), { done: true, output: "ok" }],
      {
        retry: {
          baseMs: 1,
          factor: 1,
          capMs: 5,
          maxElapsedMs: Number.NaN,
          jitter: "none",
        },
      },
    );

    expect(outcome).toEqual({ kind: "gave_up", error: new Error("down") });
    expect(requests).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it.each([
    {
      input: "retry.maxElapsedMs: NaN",
      config: {
        retry: {
          baseMs: 1,
          factor: 1,
          capMs: 5,
          maxElapsedMs: Number.NaN,
          jitter: "none",
        },
      },
      answers: [new Error("down")] satisfies Answer[],
    },
    {
      input: "retry.maxElapsedMs: Infinity",
      config: {
        retry: {
          baseMs: 1,
          factor: 1,
          capMs: 5,
          maxElapsedMs: Number.POSITIVE_INFINITY,
          jitter: "none",
        },
      },
      answers: [
        new Error("a"),
        new Error("b"),
        { done: true, output: "ok" },
      ] satisfies Answer[],
    },
    {
      input: "deadlineMs: -Infinity",
      config: { deadlineMs: Number.NEGATIVE_INFINITY },
      answers: [] satisfies Answer[],
    },
  ] as const)("replays the dumped trace of a drive with $input", async ({
    config,
    answers,
  }) => {
    const { recording } = await drive([...answers], config);

    const replayed = replayTrace(machine, recording.dump());

    expect(replayed.matches).toBe(true);
    expect(replayed.refusal).toBeUndefined();
  });

  it("freezes the results it was handed in a dev build, so a mutated step result throws", async () => {
    const stepsThenDone =
      (steps: number) =>
      async (): Promise<DeferredStepResponse<Input, Output>> =>
        ++served > steps
          ? { done: true, output: "ok" }
          : {
              done: false,
              step: { callId: `c${served}`, tool: "t", input: { arg: "a" } },
            };
    let served = 0;
    const shared = { n: 0 };

    await expect(
      runStepLoop<{ n: number }, Input, Output>(
        "token",
        "run-3",
        stepsThenDone(3),
        () => {
          shared.n += 1;
          return shared;
        },
        { deadlineMs: Number.POSITIVE_INFINITY, now: () => 0 },
      ),
    ).rejects.toBeInstanceOf(TypeError);
    expect(shared.n).toBe(1);

    served = 0;
    const kept = { log: [] as string[] };
    await runStepLoop<{ log: string[] }, Input, Output>(
      "token",
      "run-4",
      stepsThenDone(1),
      () => kept,
      { deadlineMs: Number.POSITIVE_INFINITY, now: () => 0 },
    );
    expect(() => kept.log.push("after")).toThrow(TypeError);
  });

  it("records a deadline that fell due during a step as a Msg, so the replay ends where the drive did", async () => {
    let clock = 0;
    let wakeDeadline: (() => void) | undefined;
    let running: (() => void) | undefined;
    const stepStarted = new Promise<void>((resolve) => {
      running = resolve;
    });
    let recording: Recorder<State, Msg> | undefined;

    const drive = runStepLoop<string, Input, Output>(
      "token",
      "run-deadline",
      async () => step,
      () => {
        running?.();
        return new Promise<string>(() => {});
      },
      {
        deadlineMs: 1_000,
        now: () => clock,
        sleep: (ms) =>
          new Promise<void>((resolve) => {
            wakeDeadline = () => {
              clock += ms;
              resolve();
            };
          }),
        attach: (runtime) => {
          recording = recorder(runtime, { captureSteps: true });
        },
      },
    );
    await stepStarted;
    wakeDeadline?.();

    await expect(drive).resolves.toEqual({ kind: "deadline_exceeded" });
    if (recording === undefined) throw new Error("attach was not called");
    const trace = recording.dump();
    expect(trace.msgs.map((m) => m._tag)).toEqual([
      "start",
      "clock_read",
      "responded",
      "deadline_passed",
    ]);
    expect(trace.finalState).toEqual({
      _tag: "finished",
      outcome: { kind: "deadline_exceeded" },
    });
    expect(replayTrace(machine, trace).matches).toBe(true);
    expect(
      replayStoredTrace(
        machine,
        parseJSONL<unknown, { readonly _tag: string }>(recording.toJSONL()),
      ).matches,
    ).toBe(true);
  });

  it("stops where a recorded Msg no longer says what the drive saw", async () => {
    const { recording } = await failAfterARetry();
    const read = parseJSONL<State, Msg>(recording.toJSONL());
    const index = read.msgs.findIndex((m) => m._tag === "post_failed");
    const edited: Trace<State, Msg> = {
      ...read,
      msgs: read.msgs.map((m, i) =>
        i === index && m._tag === "post_failed"
          ? { ...m, retryable: false }
          : m,
      ),
      steps: read.steps?.map((s, i) =>
        i === index && s.msg._tag === "post_failed"
          ? { ...s, msg: { ...s.msg, retryable: false } }
          : s,
      ),
    };

    const result = replayTrace(machine, edited);

    expect(result.matches).toBe(false);
    expect(result.refusal).toMatchObject({
      index: index + 1,
      stateName: "finished",
    });
  });
});
