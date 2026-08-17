// Runtime proof for PER-EVENT namespacing, on a REAL machine.
//
// Three things get proved, in this order:
//   1. two instances' OWN events are disjoint — `JOB_A.START` is not a key of
//      instance B's table at all, and dispatching it there is a `NoCellError`;
//   2. the LIBRARY's Msg arrives under its BARE name at BOTH instances, minted
//      by `@demlik/tea/deadline`'s own subscribe cell (`deadlineSub` +
//      `subscribeDeadline` through the real reconcile pass) — nothing here
//      builds a `deadline_exceeded` literal;
//   3. the un-namespaced compile is keyed bare, end to end.
import { applyCell } from "../pure/core";
import { run } from "../run";
import {
  type WMsgIn,
  type WState,
  jobWatcher,
  solo,
  watchdog,
} from "./watchdog";

const eq = (label: string, got: unknown, want: unknown): void => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  console.log(`${g === w ? "ok  " : "FAIL"} ${label}  got=${g} want=${w}`);
};

/**
 * The sorted event keys of one state's row in a compiled `Transitions` table.
 * A typed lookup rather than a cast: the row genuinely may be absent, so say so
 * once, here, instead of teaching every call site to ignore it.
 */
const rowKeys = (update: object, state: string): readonly string[] => {
  const row = (update as Record<string, object | undefined>)[state];
  if (row === undefined) {
    throw new Error(`smoke-foreign: compiled table has no row for "${state}"`);
  }
  return Object.keys(row).sort();
};

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  // ── the emitted key sets, side by side ───────────────────────────────────
  const a = jobWatcher("JOB_A");
  const b = jobWatcher("JOB_B");
  const keysA = rowKeys(a.update, "working");
  const keysB = rowKeys(b.update, "working");
  eq("A's `working` row is keyed per-event", keysA, [
    "JOB_A.FINISHED",
    "JOB_A.START",
    "deadline_exceeded",
  ]);
  eq("B's `working` row is keyed per-event", keysB, [
    "JOB_B.FINISHED",
    "JOB_B.START",
    "deadline_exceeded",
  ]);
  eq(
    "the ONLY key the two instances share is the library's",
    keysA.filter((k) => keysB.includes(k)),
    ["deadline_exceeded"],
  );
  eq(
    "…and the un-namespaced compile is keyed bare",
    rowKeys(solo, "working"),
    ["FINISHED", "START", "deadline_exceeded"],
  );

  // ── 1. the instances' own events are disjoint, at RUNTIME too ────────────
  const rtA = await run(a, {}).ready;
  const rtB = await run(b, {}).ready;
  const now = Date.now();

  await rtA.dispatch({
    type: "JOB_A.START",
    jobId: "a",
    deadlineAtMs: now + 60,
  });
  await rtB.dispatch({
    type: "JOB_B.START",
    jobId: "b",
    deadlineAtMs: now + 60,
  });
  eq("A started", rtA.getState().type, "working");
  eq("B started", rtB.getState().type, "working");

  // the cast is the point: the TYPE layer already refuses this line. Removing
  // the cast is a compile error, which is what probe e22 pins down.
  let crossTalk = "accepted (WRONG)";
  try {
    applyCell<WState, WMsgIn<"JOB_B">, never>(
      { update: b.update as object, __form: "transitions" },
      rtB.getState(),
      {
        type: "JOB_A.START",
        jobId: "x",
        deadlineAtMs: 0,
      } as unknown as WMsgIn<"JOB_B">,
    );
  } catch (err) {
    crossTalk = (err as { name: string }).name;
  }
  eq("A's START is not addressable on B", crossTalk, "NoCellError");

  // ── 2. the library's Msg, bare, at BOTH instances ────────────────────────
  // Nobody dispatches it. `subscriptions(state)` armed a real `deadlineSub`
  // when each machine entered `working`; `subscribeDeadline` fires it.
  await sleep(200);
  await rtA.idle();
  await rtB.idle();
  eq(
    "A expired via the LIBRARY's deadline sub",
    rtA.getState().type,
    "expired",
  );
  eq(
    "B expired via the LIBRARY's deadline sub",
    rtB.getState().type,
    "expired",
  );
  eq(
    "…and the library's payload landed in A's state",
    rtA.getState().jobId,
    "a",
  );
  await rtA.stop();
  await rtB.stop();

  // ── the sub is DISARMED when the job settles in time ─────────────────────
  const c = jobWatcher("JOB_C");
  const rtC = await run(c, {}).ready;
  await rtC.dispatch({
    type: "JOB_C.START",
    jobId: "c",
    deadlineAtMs: Date.now() + 60,
  });
  await rtC.dispatch({ type: "JOB_C.FINISHED", at: Date.now() });
  eq("C settled before its deadline", rtC.getState().type, "settled");
  await sleep(200);
  await rtC.idle();
  eq("…and the deadline never re-fired it", rtC.getState().type, "settled");
  await rtC.stop();

  // ── 3. the un-namespaced table, driven with BARE keys ────────────────────
  const soloMachine = {
    update: solo as object,
    __form: "transitions" as const,
  };
  const step = (s: WState, m: WMsgIn): WState =>
    applyCell<WState, WMsgIn, never>(soloMachine, s, m)[0];
  const started = step(
    { type: "idle", jobId: "", deadlineAtMs: 0 },
    { type: "START", jobId: "solo", deadlineAtMs: 7 },
  );
  eq("solo: idle -START-> working", started, {
    jobId: "solo",
    deadlineAtMs: 7,
    type: "working",
  });
  eq(
    "solo: working -deadline_exceeded-> expired",
    step(started, { type: "deadline_exceeded", id: "d", atMs: 9 }),
    { jobId: "solo", deadlineAtMs: 9, type: "expired" },
  );
  // totality survives for a foreign event: `idle` REFUSED it by `ignore`, so
  // the cell is a self-loop rather than a throw.
  eq(
    "solo: idle ignores the foreign event (refusal, not a throw)",
    step(
      { type: "idle", jobId: "", deadlineAtMs: 0 },
      {
        type: "deadline_exceeded",
        id: "d",
        atMs: 1,
      },
    ).type,
    "idle",
  );

  // the chart still draws — `foreign` is inert to every other derivation.
  eq("chart still has one entry state", Object.keys(watchdog.states).length, 2);
}

void main();
