// ═══════════════════════════════════════════════════════════════════════════
// PORT — `examples/status-poller.ts` in the config form, via CELL EDGES.
//
// This is the canonical BATTERY machine: `State = { jobId, poll }`, and every
// fork the machine makes is made INSIDE `poll` by code the consumer does not
// own (`recordFailure`/`shouldRetry` against a policy closed over in
// `createPoller`). The chart cannot declare those forks — but it can declare
// their RANGE. Each edge below says which states the battery may land on; the
// cell says which one it did, by reading the battery's own answer.
//
// Nothing here re-runs a verb to ask where it went, and nothing duplicates a
// decision the library already makes.
// ═══════════════════════════════════════════════════════════════════════════
import { createPoller, type PollerState } from "../poller";
import type { Cmd, SubId } from "../pure/core";
import { compile, initFrom } from "./compile";
import {
  type Cells,
  type CmdOf,
  type MsgOf,
  type MsgIn,
  type StateOf,
  defineChart,
  ty,
} from "./graph";

export type JobStatus = {
  readonly status: "pending" | "ready";
  readonly progress: number;
};

const JOB_ID = "job-7f3a";
const EVERY_MS = 5_000;

const poll = createPoller<{ readonly poll: PollerState<JobStatus> }, JobStatus>({
  everyMs: EVERY_MS,
  until: (s) => s.poll.lastResult?.status === "ready",
  onTick: (): ReadStatus => ({ type: "read_status", jobId: JOB_ID }),
});

// FINDING — `to` can be no tighter than the battery's own return type. Every
// poller verb is declared `PollerState<R>`, the WHOLE phase union, so
// `slice.phase` is the whole union at every site and a narrower `to` (say
// `["polling"]` on `start`) is a claim the compiler cannot check and correctly
// rejects. The precision of the declared fan-out is bounded by the precision of
// the code it delegates to — which is the honest answer, not a gap in `to`.
const ALL = ["polling", "done", "gave_up"] as const;

export const pollerChart = defineChart({
  ctx: ty<{
    readonly jobId: string;
    readonly poll: PollerState<JobStatus>;
  }>(),
  cmds: {
    // declared so the Cmd union is derived here as usual — but never named by
    // an edge, because the BATTERY emits it. `Cmds` is keyed by the cmds edges
    // fire, so no builder is owed for one only a cell ever produces.
    read_status: ty<{ readonly jobId: string }>(),
  },
  events: {
    start_polling: { data: ty<{ readonly at: number }>(), scope: "live" },
    // routed only from `polling` — `tick`'s own `phase !== "polling"` guard is
    // exactly a scoped-out self-loop, so `done`/`gave_up` need no `ignore`.
    deadline_exceeded: {
      data: ty<{ readonly id: SubId; readonly atMs: number }>(),
      scope: "edges",
    },
    poll_result: {
      data: ty<{ readonly result: JobStatus; readonly at: number }>(),
      scope: "live",
    },
    poll_failed: {
      data: ty<{ readonly error: string; readonly at: number }>(),
      scope: "live",
    },
  },
  states: {
    // NOT `end: true` on done/gave_up: the original's msg-keyed reducer lets a
    // late result resurrect a finished poller, and the chart says so.
    live: {
      polling: {
        initial: true,
        on: {
          start_polling: { to: ALL, cell: "start" },
          deadline_exceeded: { to: ALL, cell: "tick" },
          poll_result: { to: ALL, cell: "onResult" },
          poll_failed: { to: ALL, cell: "onError" },
        },
      },
      done: {
        on: {
          start_polling: { to: ALL, cell: "start" },
          poll_result: { to: ALL, cell: "onResult" },
          poll_failed: { to: ALL, cell: "onError" },
        },
      },
      gave_up: {
        on: {
          start_polling: { to: ALL, cell: "start" },
          poll_result: { to: ALL, cell: "onResult" },
          poll_failed: { to: ALL, cell: "onError" },
        },
      },
    },
  },
});

export type PollerG = typeof pollerChart;
export type PollState = StateOf<PollerG>;
export type PollMsg = MsgOf<PollerG>;
export type PollMsgIn<NS extends string> = MsgIn<PollerG, NS>;
export type ReadStatus = CmdOf<PollerG>;

const reads = (cs: readonly Cmd[]): readonly ReadStatus[] =>
  cs.filter((c): c is ReadStatus => c.type === "read_status");

/**
 * The four cells. Each is the ORIGINAL's cell body, verbatim, plus the one
 * thing a `Transitions` needs that a `Reducer` did not: the phase the battery
 * moved to, lifted to `type` IN THE SAME EXPRESSION that produced it. That is
 * not a duplicated fact — `type` has exactly one writer, and `to` is what the
 * compiler checks that writer against.
 */
export const cells: Cells<PollerG, PollState, PollMsg> = {
  start: (s, m, _at) => {
    const [slice, cs] = poll.start(s.poll, m.at);
    return [{ ...s, poll: slice, type: slice.phase }, reads(cs)];
  },
  tick: (s) => {
    const [slice, cs] = poll.tick(s.poll);
    return [{ ...s, poll: slice, type: slice.phase }, reads(cs)];
  },
  onResult: (s, m, _at) => {
    const untilHeld = m.result.status === "ready";
    const [slice, cs] = poll.tickResult(s.poll, m.result, m.at, untilHeld);
    return [{ ...s, poll: slice, type: slice.phase }, reads(cs)];
  },
  onError: (s, m, _at) => {
    const [slice, cs] = poll.tickErr(s.poll, m.error, m.at);
    return [{ ...s, poll: slice, type: slice.phase }, reads(cs)];
  },
};

export function pollerRegion<const NS extends string>(ns: NS) {
  return compile<PollerG, PollState, PollMsg, ReadStatus, NS>(
    pollerChart,
    { assign: {}, cells },
    ns,
  );
}

export const pollerInit = initFrom<PollerG, PollState, ReadStatus>(
  pollerChart,
  () => ({ jobId: JOB_ID, poll: poll.init() }),
);
export const pollerUpdate = pollerRegion("POLL");
export const pollerSubs = (s: PollState) => poll.subs(s.poll);
