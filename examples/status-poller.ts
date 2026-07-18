import { type Cmd, defineMachine, run, type Sub } from "@demlik/tea";
import type { DeadlineExceeded } from "@demlik/tea/deadline";
import { createPoller, type PollerState } from "@demlik/tea/poller";
import { Result } from "better-result";

type JobStatus = {
  readonly status: "pending" | "ready";
  readonly progress: number;
};

interface State {
  readonly jobId: string;
  readonly poll: PollerState<JobStatus>;
}

type ReadStatus = Cmd<"read_status"> & { readonly jobId: string };

type Msg =
  | { type: "start_polling"; at: number }
  | { type: "poll_result"; result: JobStatus; at: number }
  | { type: "poll_failed"; error: string; at: number }
  | DeadlineExceeded;

interface Ctx {
  readStatus: (jobId: string) => Promise<JobStatus>;
  clock: () => number;
}

const JOB_ID = "job-7f3a";
const EVERY_MS = 5_000;

const poll = createPoller<State, JobStatus>({
  everyMs: EVERY_MS,
  until: (s) => s.poll.lastResult?.status === "ready",
  onTick: (): ReadStatus => ({ type: "read_status", jobId: JOB_ID }),
});

function readStatusCmds(cmds: readonly Cmd[]): readonly ReadStatus[] {
  return cmds.filter((c): c is ReadStatus => c.type === "read_status");
}

export const statusPoller = defineMachine<State, Msg, ReadStatus, Sub, Ctx>({
  init: (loaded) =>
    loaded !== null ? [loaded, []] : [{ jobId: JOB_ID, poll: poll.init() }, []],

  update: {
    start_polling: (s, m) => {
      const [slice, cmds] = poll.start(s.poll, m.at);
      return [{ ...s, poll: slice }, readStatusCmds(cmds)];
    },

    deadline_exceeded: (s) => {
      const [slice, cmds] = poll.tick(s.poll);
      return [{ ...s, poll: slice }, readStatusCmds(cmds)];
    },

    poll_result: (s, m) => {
      const folded: State = { ...s, poll: { ...s.poll, lastResult: m.result } };
      const untilHeld = folded.poll.lastResult?.status === "ready";
      const [slice, cmds] = poll.tickResult(s.poll, m.result, m.at, untilHeld);
      return [{ ...s, poll: slice }, readStatusCmds(cmds)];
    },

    poll_failed: (s, m) => {
      const [slice, cmds] = poll.tickErr(s.poll, m.error, m.at);
      return [{ ...s, poll: slice }, readStatusCmds(cmds)];
    },
  },

  subscriptions: (s) => poll.subs(s.poll),

  interpret: {
    read_status: async (cmd, ctx): Promise<Msg> => {
      const observed = await Result.tryPromise({
        try: () => ctx.readStatus(cmd.jobId),
        catch: (error: unknown): unknown => error,
      });
      const at = ctx.clock();
      return observed.match({
        ok: (result): Msg => ({ type: "poll_result", result, at }),
        err: (error): Msg => ({
          type: "poll_failed",
          error: String(error),
          at,
        }),
      });
    },
  },
});

function fakeSource(): (jobId: string) => Promise<JobStatus> {
  const script: readonly [JobStatus, ...JobStatus[]] = [
    { status: "pending", progress: 25 },
    { status: "pending", progress: 70 },
    { status: "ready", progress: 100 },
  ];
  let i = 0;
  return () => {
    const reply = script[Math.min(i, script.length - 1)] ?? script[0];
    i += 1;
    return Promise.resolve(reply);
  };
}

async function main() {
  let now = 1_000_000;
  const clock = () => now;

  const runtime = await run(statusPoller, {
    ctx: { readStatus: fakeSource(), clock },
  }).ready;

  let polls = 0;
  runtime.observe((msg) => {
    if (msg?.type === "poll_result") {
      polls += 1;
      const r = msg.result;
      const tail =
        r.status === "ready" ? "  <- until() holds, poller is done" : "";
      console.log(
        `poll #${polls}: status=${r.status} progress=${r.progress}%${tail}`,
      );
    }
  });

  console.log(
    `starting poll of ${runtime.getState().jobId} at t=${now}, everyMs=${EVERY_MS}`,
  );
  await runtime.dispatch({ type: "start_polling", at: now });

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const before = runtime.getState().poll;
    if (before.phase !== "polling" || before.nextAtMs === null) break;
    now = before.nextAtMs;
    await runtime.dispatch({
      type: "deadline_exceeded",
      id: `poller:tick:${now}`,
      atMs: now,
    });
    if (runtime.getState().poll.phase !== "polling") break;
  }

  const final = runtime.getState().poll;
  const finalTarget = final.phase === "polling" ? final.nextAtMs : null;
  console.log(
    `\nphase=${final.phase}  ticks=${final.tick}  nextAtMs=${finalTarget}`,
  );
  console.log(`final result: ${JSON.stringify(final.lastResult)}`);
  console.log(`total polls fired: ${polls}`);

  const stillArmed = poll.subs(final).length;
  console.log(
    `timer subs armed now: ${stillArmed}  (0 => no further polls fire)`,
  );

  await runtime.stop();
}

main();
