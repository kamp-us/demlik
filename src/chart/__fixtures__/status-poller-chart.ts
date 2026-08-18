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
import { createPoller, type PollerState } from "../../poller";
import type { Cmd, SubId } from "../../pure/core";
import { compile, initFrom } from "../compile";
import {
  type Cells,
  type CmdOf,
  defineChart,
  type MsgIn,
  type MsgOf,
  type StateOf,
  ty,
} from "../graph";

export type JobStatus = {
  readonly status: "pending" | "ready";
  readonly progress: number;
};

const JOB_ID = "job-7f3a";
const EVERY_MS = 5_000;

const poll = createPoller<{ readonly poll: PollerState<JobStatus> }, JobStatus>(
  {
    everyMs: EVERY_MS,
    until: (s) => s.poll.lastResult?.status === "ready",
    onTick: (): ReadStatus => ({ type: "read_status", jobId: JOB_ID }),
  },
);

// `to` can be no tighter than the battery's own return type — the fan-out the
// chart draws is bounded by the precision of the code it delegates to, and no
// declaration on this side can tighten it. So it was tightened on the OTHER
// side: each poller verb now DECLARES the phases it can actually reach (they
// were always true of the bodies — `start` only ever builds `polling`,
// `tickResult` never builds `gave_up`, `tickErr` never builds `done`, `tick`
// returns its argument), and the four edges below inherit that precision for
// free. `chartMermaid` draws 16 edges where it drew 30.
//
// What is NOT reachable this way is a fork the battery makes internally and
// reports only through the phase — there is no such fork left here, but if
// there were, its range would be exactly what these unions say and no smaller.
const RESULT = ["polling", "done"] as const;
const ERROR = ["polling", "gave_up"] as const;

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
          start_polling: { to: ["polling"], cell: "start" },
          deadline_exceeded: { to: ["polling"], cell: "tick" },
          poll_result: { to: RESULT, cell: "onResult" },
          poll_failed: { to: ERROR, cell: "onError" },
        },
      },
      done: {
        on: {
          start_polling: { to: ["polling"], cell: "start" },
          poll_result: { to: RESULT, cell: "onResult" },
          poll_failed: { to: ERROR, cell: "onError" },
        },
      },
      gave_up: {
        on: {
          start_polling: { to: ["polling"], cell: "start" },
          poll_result: { to: RESULT, cell: "onResult" },
          poll_failed: { to: ERROR, cell: "onError" },
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
  // `tick` is the one verb whose reachable set is not readable off its return
  // type alone: it returns its ARGUMENT (`tick<S>(s: S) => [S, …]`), so the
  // fan-out is whatever the slice's phase already was. The chart routes
  // `deadline_exceeded` only out of `polling`, and every cell here writes
  // `type: slice.phase`, so `s.type === "polling"` implies `s.poll.phase ===
  // "polling"` by construction — but that is a correlation between two
  // properties of one state, which TypeScript cannot carry (#30581). Narrowing
  // the slice locally makes the invariant checkable instead of assumed, and the
  // dead arm is the battery's own `phase !== "polling"` no-op, said once here so
  // the edge can declare the single target it really has.
  tick: (s) => {
    const slice = s.poll;
    if (slice.phase !== "polling") return [s, []];
    // `tick` is the ONE verb that moves neither the phase nor the schedule: it
    // emits the observation Cmd and hands back the slice it was given. Its
    // SIGNATURE cannot say so — a generic identity there would make `Poller`
    // unsatisfiable by any non-generic implementation, so the return type is
    // the full union. The narrow `to: ["polling"]` therefore comes from the
    // slice this cell narrowed ITSELF, which is the same battery-owned value
    // and still the single writer of `type`.
    const [, cs] = poll.tick(slice);
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
