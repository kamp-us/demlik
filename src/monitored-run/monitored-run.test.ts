import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { defineMachine, type Reducer } from "../index";
import { type SnapshotStore, snapshotSaved } from "../snapshot";
import { bindMachine } from "../testing";
import {
  createMonitoredRun,
  deadlineSub,
  type MonitoredRunState,
  type MonitoredRunTimerMsg,
  type SnapshotSavedMsg,
  type SnapshotWriteCmd,
} from "./index";

// A stage is just a string id here; the checkpoint value is a tiny run-state
// stand-in so the payload threading is observable in the emitted write Cmd.
type Stage = "plan" | "test" | "report";
type Checkpoint = { readonly step: number };

const STAGES: readonly Stage[] = ["plan", "test", "report"];

// Helpers to read pipeline position out of the work-queue-backed stepStates.
function runningStage(s: MonitoredRunState<Stage>): Stage | undefined {
  return s.stepStates.find((i) => i.status === "running")?.input;
}

// Recursively freeze a value and every nested array/object it reaches, so any
// attempt to write through a nested branch throws in strict mode. A shallow
// Object.freeze locks only the top-level record and lets a nested splice slip
// through; this guards the whole reachable graph of a slice.
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      deepFreeze(v);
    }
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

describe("createMonitoredRun — init", () => {
  it("starts running with no runId, empty stages, primed counters", () => {
    const run = createMonitoredRun<Stage, Checkpoint>({ stages: STAGES });
    const s = run.init();
    expect(s.phase).toBe("running");
    expect(s.runId).toBe("");
    expect(s.stepStates).toEqual([]);
    expect(s.startedAt).toBe(0);
    expect(s.lastProgressAt).toBe(0);
    expect(s.progressSeq).toBe(0);
    expect(s.failure).toBeNull();
    // The snapshot slice is always present (uniform shape) even with no brick.
    expect(s.snapshot).toEqual({
      sinceLast: 0,
      seq: 0,
      lastSavedSeq: null,
      lastSavedAt: null,
    });
  });

  it("an empty config is a valid single-shot, unwatched, uncheckpointed run", () => {
    const run = createMonitoredRun();
    const [started, cmds] = run.start(run.init(), "r1", 100);
    expect(started.phase).toBe("running");
    expect(started.stepStates).toEqual([]); // no pipeline
    expect(cmds).toEqual([]);
    // No deadlineMs → no watchdog Sub.
    expect(run.subs(started)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// start — seeds the pipeline position, primes the watchdog
// ---------------------------------------------------------------------------

describe("createMonitoredRun — start", () => {
  it("single-shot: enters running with no stage queue", () => {
    const run = createMonitoredRun<never, Checkpoint>();
    const [s] = run.start(run.init(), "run-1", 500);
    expect(s.runId).toBe("run-1");
    expect(s.startedAt).toBe(500);
    expect(s.lastProgressAt).toBe(500);
    expect(s.stepStates).toEqual([]);
  });

  it("pipeline: seeds every stage and claims the first as the position", () => {
    const run = createMonitoredRun<Stage, Checkpoint>({ stages: STAGES });
    const [s] = run.start(run.init(), "run-1", 0);
    // Three stages enqueued; the first claimed running, rest pending.
    expect(s.stepStates).toHaveLength(3);
    expect(runningStage(s)).toBe("plan");
    expect(
      s.stepStates.filter((i) => i.status === "pending").map((i) => i.input),
    ).toEqual(["test", "report"]);
  });

  it("start clears a prior failure and resets the progress seq", () => {
    const run = createMonitoredRun<Stage, Checkpoint>({ stages: STAGES });
    let [s] = run.start(run.init(), "run-1", 0);
    [s] = run.advance(s, { step: 0 }, { kind: "fail", error: "boom" }, 1);
    expect(s.phase).toBe("failed");
    // Restart wipes the slate.
    const [restarted] = run.start(s, "run-2", 10);
    expect(restarted.phase).toBe("running");
    expect(restarted.failure).toBeNull();
    expect(restarted.progressSeq).toBe(0);
    expect(runningStage(restarted)).toBe("plan");
  });
});

// ---------------------------------------------------------------------------
// advance — single-shot finish + pipeline walk + stage failure
// ---------------------------------------------------------------------------

describe("createMonitoredRun — advance", () => {
  it("single-shot: one ok advance finishes the run to done", () => {
    const run = createMonitoredRun<never, Checkpoint>();
    let [s] = run.start(run.init(), "r", 0);
    const [done, cmds] = run.advance(s, { step: 1 }, { kind: "ok" }, 5);
    s = done;
    expect(s.phase).toBe("done");
    expect(s.lastProgressAt).toBe(5); // advance is a progress event
    expect(cmds).toEqual([]); // no checkpoint brick
  });

  it("pipeline: each ok advance retires the stage and claims the next, finishing on the last", () => {
    const run = createMonitoredRun<Stage, Checkpoint>({ stages: STAGES });
    let [s] = run.start(run.init(), "r", 0);
    expect(runningStage(s)).toBe("plan");

    [s] = run.advance(s, { step: 1 }, { kind: "ok" }, 1);
    expect(s.phase).toBe("running");
    expect(runningStage(s)).toBe("test");

    [s] = run.advance(s, { step: 2 }, { kind: "ok" }, 2);
    expect(s.phase).toBe("running");
    expect(runningStage(s)).toBe("report");

    [s] = run.advance(s, { step: 3 }, { kind: "ok" }, 3);
    expect(s.phase).toBe("done");
    // Pipeline drained — no running stage remains.
    expect(runningStage(s)).toBeUndefined();
  });

  it("a stage failure terminates the run, carrying the failing stage index + error", () => {
    const run = createMonitoredRun<Stage, Checkpoint>({ stages: STAGES });
    let [s] = run.start(run.init(), "r", 0);
    [s] = run.advance(s, { step: 1 }, { kind: "ok" }, 1); // now on "test"
    const boom = new Error("test stage blew up");
    [s] = run.advance(s, { step: 2 }, { kind: "fail", error: boom }, 2);
    expect(s.phase).toBe("failed");
    // Carries the failing stage VALUE (stable across the shrinking queue), not
    // a positional index.
    expect(s.failure).toEqual({ reason: "stage", stage: "test", error: boom });
  });

  it("advance on a settled run is a no-op (identity preserved)", () => {
    const run = createMonitoredRun<never, Checkpoint>();
    let [s] = run.start(run.init(), "r", 0);
    [s] = run.advance(s, { step: 1 }, { kind: "ok" }, 1); // done
    const before = s;
    const [after, cmds] = run.advance(before, { step: 2 }, { kind: "ok" }, 2);
    expect(after).toBe(before);
    expect(cmds).toEqual([]);
  });

  it("each advance bumps the progress seq (re-arming the watchdog)", () => {
    const run = createMonitoredRun<Stage, Checkpoint>({
      stages: STAGES,
      deadlineMs: 1000,
    });
    let [s] = run.start(run.init(), "r", 0);
    expect(s.progressSeq).toBe(0);
    [s] = run.advance(s, { step: 1 }, { kind: "ok" }, 10);
    expect(s.progressSeq).toBe(1);
    [s] = run.advance(s, { step: 2 }, { kind: "ok" }, 20);
    expect(s.progressSeq).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// progress + markStale — the anti-stale bump
// ---------------------------------------------------------------------------

describe("createMonitoredRun — progress / markStale", () => {
  it("progress bumps the watchdog clock + seq without moving the pipeline", () => {
    const run = createMonitoredRun<Stage, Checkpoint>({ stages: STAGES });
    let [s] = run.start(run.init(), "r", 0);
    const stageBefore = runningStage(s);
    [s] = run.progress(s, { step: 1 }, 42);
    expect(s.lastProgressAt).toBe(42);
    expect(s.progressSeq).toBe(1);
    expect(runningStage(s)).toBe(stageBefore); // pipeline position unchanged
  });

  it("markStale flips running → stale; the next progress recovers it", () => {
    const run = createMonitoredRun<Stage, Checkpoint>({
      stages: STAGES,
      deadlineMs: 1000,
    });
    let [s] = run.start(run.init(), "r", 0);
    [s] = run.markStale(s);
    expect(s.phase).toBe("stale");
    // Stale does not bump the seq — the armed deadline keeps counting.
    expect(s.progressSeq).toBe(0);
    [s] = run.progress(s, { step: 1 }, 50);
    expect(s.phase).toBe("running");
    expect(s.progressSeq).toBe(1);
  });

  it("markStale is a no-op unless the run is running", () => {
    const run = createMonitoredRun<never, Checkpoint>();
    let [s] = run.start(run.init(), "r", 0);
    [s] = run.advance(s, { step: 1 }, { kind: "ok" }, 1); // done
    const [after] = run.markStale(s);
    expect(after).toBe(s);
  });

  it("progress on a settled run is ignored", () => {
    const run = createMonitoredRun<never, Checkpoint>();
    let [s] = run.start(run.init(), "r", 0);
    [s] = run.advance(s, { step: 1 }, { kind: "ok" }, 1); // done
    const [after, cmds] = run.progress(s, { step: 9 }, 99);
    expect(after).toBe(s);
    expect(cmds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// subs — the no-progress safety alarm keyed on progressSeq
// ---------------------------------------------------------------------------

describe("createMonitoredRun — subs (the watchdog)", () => {
  it("arms a deadline at lastProgressAt + deadlineMs, keyed on runId + progressSeq", () => {
    const run = createMonitoredRun<Stage, Checkpoint>({
      stages: STAGES,
      deadlineMs: 600,
    });
    const [s] = run.start(run.init(), "run-x", 100);
    expect(run.subs(s)).toEqual([deadlineSub("monitored:safety:run-x:0", 700)]);
  });

  it("a progress event retires the old alarm id and arms a new one", () => {
    const run = createMonitoredRun<Stage, Checkpoint>({
      stages: STAGES,
      deadlineMs: 600,
    });
    let [s] = run.start(run.init(), "run-x", 100);
    expect(run.subs(s)[0]?.id).toBe("monitored:safety:run-x:0");
    [s] = run.progress(s, { step: 1 }, 250);
    // New id (seq bumped) + new target (lastProgressAt moved).
    expect(run.subs(s)).toEqual([deadlineSub("monitored:safety:run-x:1", 850)]);
  });

  it("a stale run still arms the watchdog (it is still resumable, still being timed)", () => {
    const run = createMonitoredRun<Stage, Checkpoint>({
      stages: STAGES,
      deadlineMs: 600,
    });
    let [s] = run.start(run.init(), "run-x", 100);
    [s] = run.markStale(s);
    expect(run.subs(s)).toEqual([deadlineSub("monitored:safety:run-x:0", 700)]);
  });

  it("a settled run desires no watchdog", () => {
    const run = createMonitoredRun<never, Checkpoint>({ deadlineMs: 600 });
    let [s] = run.start(run.init(), "r", 0);
    [s] = run.advance(s, { step: 1 }, { kind: "ok" }, 1); // done
    expect(run.subs(s)).toEqual([]);
  });

  it("omitting deadlineMs arms no watchdog at all", () => {
    const run = createMonitoredRun<Stage, Checkpoint>({ stages: STAGES });
    const [s] = run.start(run.init(), "r", 0);
    expect(run.subs(s)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// onDeadline — auto-fail at T, but only the live alarm
// ---------------------------------------------------------------------------

describe("createMonitoredRun — onDeadline", () => {
  it("the live alarm (matching current progressSeq) auto-fails the run", () => {
    const run = createMonitoredRun<Stage, Checkpoint>({
      stages: STAGES,
      deadlineMs: 600,
    });
    const [s] = run.start(run.init(), "run-x", 100);
    const msg: MonitoredRunTimerMsg = {
      type: "deadline_exceeded",
      id: "monitored:safety:run-x:0",
      atMs: 700,
    };
    const [failed, cmds] = run.onDeadline(s, msg);
    expect(failed.phase).toBe("failed");
    expect(failed.failure).toEqual({ reason: "deadline", at: 700 });
    expect(cmds).toEqual([]);
  });

  it("a stale alarm (older seq, progress already re-armed) is a no-op", () => {
    const run = createMonitoredRun<Stage, Checkpoint>({
      stages: STAGES,
      deadlineMs: 600,
    });
    let [s] = run.start(run.init(), "run-x", 100);
    [s] = run.progress(s, { step: 1 }, 250); // seq -> 1, retires seq 0's alarm
    // The seq-0 alarm fires late, racing the just-armed seq-1 alarm.
    const stale: MonitoredRunTimerMsg = {
      type: "deadline_exceeded",
      id: "monitored:safety:run-x:0",
      atMs: 700,
    };
    const [after, cmds] = run.onDeadline(s, stale);
    expect(after).toBe(s); // ignored — pure no-op
    expect(cmds).toEqual([]);
  });

  it("a deadline fire on a settled run is tolerated as a no-op", () => {
    const run = createMonitoredRun<never, Checkpoint>({ deadlineMs: 600 });
    let [s] = run.start(run.init(), "r", 0);
    [s] = run.advance(s, { step: 1 }, { kind: "ok" }, 1); // done
    const [after] = run.onDeadline(s, {
      type: "deadline_exceeded",
      id: "monitored:safety:r:1",
      atMs: 999,
    });
    expect(after).toBe(s);
  });
});

// ---------------------------------------------------------------------------
// boot — resume mid-pipeline (position survives eviction)
// ---------------------------------------------------------------------------

describe("createMonitoredRun — boot", () => {
  it("preserves the pipeline position but re-seeds the watchdog from now", () => {
    const run = createMonitoredRun<Stage, Checkpoint>({
      stages: STAGES,
      deadlineMs: 600,
    });
    let [s] = run.start(run.init(), "run-x", 100);
    [s] = run.advance(s, { step: 1 }, { kind: "ok" }, 200); // now on "test", seq 1
    expect(runningStage(s)).toBe("test");

    // Cold wake long after the crash.
    const [booted] = run.boot(s, 999_999);
    // Position survives.
    expect(runningStage(booted)).toBe("test");
    // Watchdog re-armed from NOW (not the pre-crash lastProgressAt).
    expect(booted.lastProgressAt).toBe(999_999);
    expect(booted.progressSeq).toBe(2); // bumped → fresh alarm id
    expect(run.subs(booted)).toEqual([
      deadlineSub("monitored:safety:run-x:2", 999_999 + 600),
    ]);
  });

  it("boot flips a stale run back to running (a cold wake is not a wedge)", () => {
    const run = createMonitoredRun<Stage, Checkpoint>({
      stages: STAGES,
      deadlineMs: 600,
    });
    let [s] = run.start(run.init(), "r", 0);
    [s] = run.markStale(s);
    const [booted] = run.boot(s, 1000);
    expect(booted.phase).toBe("running");
  });

  it("boot resets the snapshot cadence counter (un-checkpointed progress is moot)", () => {
    const run = createMonitoredRun<Stage, Checkpoint>({
      stages: STAGES,
      snapshotEvery: 10,
    });
    let [s] = run.start(run.init(), "r", 0);
    [s] = run.progress(s, { step: 1 }, 1); // sinceLast -> 1
    expect(s.snapshot.sinceLast).toBe(1);
    const [booted] = run.boot(s, 5);
    expect(booted.snapshot.sinceLast).toBe(0);
  });

  it("boot is a no-op on a settled run, emitting no Cmd", () => {
    const run = createMonitoredRun<never, Checkpoint>();
    let [s] = run.start(run.init(), "r", 0);
    [s] = run.advance(s, { step: 1 }, { kind: "ok" }, 1); // done
    const [after, cmds] = run.boot(s, 100);
    expect(after).toBe(s);
    expect(cmds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// snapshot composition — progress accounts a unit, cadence emits a write
// ---------------------------------------------------------------------------

describe("createMonitoredRun — snapshot composition", () => {
  it("progress below the cadence emits no write, at the cadence emits one", () => {
    const run = createMonitoredRun<Stage, Checkpoint>({
      stages: STAGES,
      snapshotEvery: 2,
      snapshotKey: "run/cp",
    });
    let [s] = run.start(run.init(), "r", 0);

    let [next, cmds] = run.progress(s, { step: 1 }, 1);
    s = next;
    expect(cmds).toEqual([]); // sinceLast 1 < 2

    [next, cmds] = run.progress(s, { step: 2 }, 2);
    s = next;
    expect(cmds).toEqual([
      {
        type: "snapshot_write",
        key: "run/cp",
        seq: 1,
        at: 2,
        payload: { step: 2 },
      },
    ]);
  });

  it("finishing forces a terminal checkpoint so the durable snapshot is the final state", () => {
    const run = createMonitoredRun<never, Checkpoint>({ snapshotEvery: 100 });
    let [s] = run.start(run.init(), "r", 0);
    // Far below cadence — only force-on-finish would write.
    const [done, cmds] = run.advance(s, { step: 7 }, { kind: "ok" }, 9);
    s = done;
    expect(s.phase).toBe("done");
    expect(cmds).toEqual([
      {
        type: "snapshot_write",
        key: "@@snapshot",
        seq: 1,
        at: 9,
        payload: { step: 7 },
      },
    ]);
  });

  it("without the snapshot brick, no progress ever emits a write", () => {
    const run = createMonitoredRun<Stage, Checkpoint>({ stages: STAGES });
    let [s] = run.start(run.init(), "r", 0);
    for (let i = 0; i < 50; i++) {
      const [next, cmds] = run.progress(s, { step: i }, i);
      s = next;
      expect(cmds).toEqual([]);
    }
  });

  it("confirmSnapshot advances the durable watermark", () => {
    const run = createMonitoredRun<Stage, Checkpoint>({
      stages: STAGES,
      snapshotEvery: 1,
    });
    let [s] = run.start(run.init(), "r", 0);
    [s] = run.progress(s, { step: 1 }, 1); // seq -> 1 write emitted
    const confirmed = run.confirmSnapshot(s, snapshotSaved(1, 5));
    expect(confirmed.snapshot.lastSavedSeq).toBe(1);
    expect(confirmed.snapshot.lastSavedAt).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// handlers — the checkpoint write boundary
// ---------------------------------------------------------------------------

describe("createMonitoredRun — handlers", () => {
  function fakeStore<Vv>(): SnapshotStore<Vv> & {
    puts: { key: string; value: Vv }[];
  } {
    const cell = new Map<string, Vv>();
    const puts: { key: string; value: Vv }[] = [];
    return {
      puts,
      async get(key) {
        return cell.has(key) ? (cell.get(key) as Vv) : null;
      },
      async put(key, value) {
        cell.set(key, value);
        puts.push({ key, value });
      },
    };
  }

  it("puts the payload and routes success to snapshot_saved", async () => {
    const run = createMonitoredRun<Stage, Checkpoint>({
      stages: STAGES,
      snapshotEvery: 1,
      snapshotKey: "run/cp",
    });
    const store = fakeStore<Checkpoint>();
    const handlers = run.handlers({ store });
    const follow = await handlers.snapshot_write(
      {
        type: "snapshot_write",
        key: "run/cp",
        seq: 3,
        at: 12,
        payload: { step: 4 },
      },
      {} as never,
    );
    expect(store.puts).toEqual([{ key: "run/cp", value: { step: 4 } }]);
    expect(follow).toEqual(snapshotSaved(3, 12));
  });

  it("routes a rejecting put to snapshot_failed (Railway — never throws)", async () => {
    const boom = new Error("R2 down");
    const store: SnapshotStore<Checkpoint> = {
      async get() {
        return null;
      },
      async put() {
        throw boom;
      },
    };
    const run = createMonitoredRun<Stage, Checkpoint>({
      stages: STAGES,
      snapshotEvery: 1,
    });
    const handlers = run.handlers({ store });
    const follow = await handlers.snapshot_write(
      {
        type: "snapshot_write",
        key: "@@snapshot",
        seq: 1,
        at: 1,
        payload: { step: 1 },
      },
      {} as never,
    );
    expect(follow).toEqual({ type: "snapshot_failed", seq: 1, error: boom });
  });
});

// ---------------------------------------------------------------------------
// Machine-level: splice the knob into a real machine, drive via replay.
// ---------------------------------------------------------------------------

type HostState = { readonly run: MonitoredRunState<Stage> };
type HostMsg =
  | { readonly type: "begin"; readonly runId: string; readonly at: number }
  | {
      readonly type: "step";
      readonly result: { kind: "ok" } | { kind: "fail"; error: unknown };
      readonly at: number;
    }
  | { readonly type: "tick"; readonly at: number }
  | { readonly type: "boot"; readonly at: number }
  | MonitoredRunTimerMsg
  | SnapshotSavedMsg
  | {
      readonly type: "snapshot_failed";
      readonly seq: number;
      readonly error: unknown;
    };
type HostCmd = SnapshotWriteCmd<Checkpoint>;

const fakeStore: SnapshotStore<Checkpoint> = {
  async get() {
    return null;
  },
  async put() {},
};

function makeMachine(
  config: Parameters<typeof createMonitoredRun<Stage, Checkpoint>>[0],
) {
  const run = createMonitoredRun<Stage, Checkpoint>(config);
  const checkpoint = (s: HostState): Checkpoint => ({
    step: s.run.progressSeq,
  });
  const update: Reducer<HostState, HostMsg, HostCmd> = {
    begin: (s, m) => {
      const [slice, cmds] = run.start(s.run, m.runId, m.at);
      return [{ run: slice }, cmds];
    },
    step: (s, m) => {
      const [slice, cmds] = run.advance(s.run, checkpoint(s), m.result, m.at);
      return [{ run: slice }, cmds];
    },
    tick: (s, m) => {
      const [slice, cmds] = run.progress(s.run, checkpoint(s), m.at);
      return [{ run: slice }, cmds];
    },
    boot: (s, m) => {
      const [slice, cmds] = run.boot(s.run, m.at);
      return [{ run: slice }, cmds];
    },
    deadline_exceeded: (s, m) => {
      const [slice, cmds] = run.onDeadline(s.run, m);
      return [{ run: slice }, cmds];
    },
    snapshot_saved: (s, m) => [{ run: run.confirmSnapshot(s.run, m) }, []],
    snapshot_failed: (s) => [s, []],
  };
  const machine = defineMachine<
    HostState,
    HostMsg,
    HostCmd,
    ReturnType<typeof run.subs>[number],
    object
  >({
    init: (loaded) =>
      loaded !== null ? [loaded, []] : [{ run: run.init() }, []],
    update,
    subscriptions: (s) => run.subs(s.run),
    subscribe: { deadline: () => () => {} },
    interpret: run.handlers({ store: fakeStore }),
  });
  return { run, machine };
}

const ctx = {} as object;

describe("createMonitoredRun — wired in a machine (replay)", () => {
  it("walks the pipeline to done over a begin + 3 steps", () => {
    const { machine } = makeMachine({ stages: STAGES, deadlineMs: 1000 });
    const bound = bindMachine(machine, ctx);
    const { state, subs } = bound.replay({
      msgs: [
        { type: "begin", runId: "r", at: 0 },
        { type: "step", result: { kind: "ok" }, at: 1 },
        { type: "step", result: { kind: "ok" }, at: 2 },
        { type: "step", result: { kind: "ok" }, at: 3 },
      ],
    });
    expect(state.run.phase).toBe("done");
    expect(subs).toEqual([]); // settled → no watchdog
  });

  it("the watchdog Sub is desired while running and tracks the latest progress seq", () => {
    const { machine } = makeMachine({ stages: STAGES, deadlineMs: 1000 });
    const bound = bindMachine(machine, ctx);
    bound.expectActiveSubs(
      {
        msgs: [
          { type: "begin", runId: "r", at: 0 },
          { type: "step", result: { kind: "ok" }, at: 100 },
        ],
      },
      [deadlineSub("monitored:safety:r:1", 1100)],
    );
  });

  it("a fired deadline Msg drives the run to failed through the reducer", () => {
    const { machine } = makeMachine({ stages: STAGES, deadlineMs: 1000 });
    const bound = bindMachine(machine, ctx);
    const { state } = bound.replay({
      msgs: [
        { type: "begin", runId: "r", at: 0 },
        { type: "deadline_exceeded", id: "monitored:safety:r:0", atMs: 1000 },
      ],
    });
    expect(state.run.phase).toBe("failed");
    expect(state.run.failure).toEqual({ reason: "deadline", at: 1000 });
  });

  it("a checkpoint write Cmd flows through the cmd stream on a cadence hit", () => {
    const { machine } = makeMachine({
      stages: STAGES,
      snapshotEvery: 1,
      snapshotKey: "k",
    });
    const bound = bindMachine(machine, ctx);
    bound.expectCmdEmitted(
      {
        msgs: [
          { type: "begin", runId: "r", at: 0 },
          { type: "tick", at: 5 },
        ],
      },
      // payload is the checkpoint the consumer hands in — snapshotted from the
      // PRE-bump state (progressSeq is still 0 when `tick` reads it).
      { type: "snapshot_write", key: "k", seq: 1, at: 5, payload: { step: 0 } },
    );
  });

  // -------------------------------------------------------------------------
  // BORN-LIVE regression — the systemic wired-machine test.
  //
  // The defect: `init()` returns phase "running" with an EMPTY runId and a zero
  // `lastProgressAt`. With `deadlineMs` configured, the old `subs` armed a
  // watchdog at `0 + deadlineMs` straight off the freshly-booted slice — a
  // deadline already in the PAST. The substrate fires it on the next tick, the
  // alarm Msg (keyed on the empty runId + seq 0) re-enters the reducer, and
  // `onDeadline` auto-fails a run that was never started.
  //
  // This is driven END-TO-END through the REAL machine: boot from `init()`
  // (loaded: null, NO `begin` Msg), read the watchdog the machine actually
  // desires off the booted slice, then dispatch the exact alarm that watchdog
  // would fire back THROUGH the bound machine — the same path the live runtime
  // takes when the subscribe cell's `setTimeout(fn, 0)` lands. We assert the
  // END STATE, not the hand-fed Msg. Pre-fix: subs arms the born-live deadline
  // and the run lands `failed`. Post-fix: the unstarted slice arms nothing and
  // a stray alarm cannot un-start the run.
  // -------------------------------------------------------------------------
  describe("born-live regression — a never-started run is not watched", () => {
    it("the booted (never-started) slice desires NO watchdog", () => {
      const { machine } = makeMachine({ stages: STAGES, deadlineMs: 1000 });
      const bound = bindMachine(machine, ctx);
      // Fresh boot, no `begin` — exactly `subs(init())`.
      const { state, subs } = bound.replay({ msgs: [] });
      expect(state.run.phase).toBe("running");
      expect(state.run.runId).toBe(""); // never started → no host-minted id
      expect(subs).toEqual([]); // <- pre-fix this is the born-live deadline
    });

    it("a born-live alarm fired off the booted slice cannot auto-fail the unstarted run", () => {
      const { machine } = makeMachine({ stages: STAGES, deadlineMs: 1000 });
      const bound = bindMachine(machine, ctx);

      // 1. Boot the machine with NO start Msg — the runtime computes the subs
      //    the booted slice desires. Pre-fix, this is the born-live watchdog;
      //    that watchdog's `atMs` (0 + 1000) is already past, so the live
      //    runtime arms `setTimeout(fn, 0)` and the alarm fires on the next
      //    tick. We synthesize that alarm from whatever the machine ACTUALLY
      //    desired (not a hard-coded id) so this test tracks the real wiring.
      const booted = bound.replay({ msgs: [] });
      const armed = booted.subs[0]; // pre-fix: born-live deadline; post-fix: undefined

      // 2. Build the alarm Msg the armed watchdog would dispatch and RE-ENTER
      //    it through the bound machine, the same dispatch the subscribe cell
      //    performs. If nothing was armed there is no alarm to fire — synthesize
      //    the worst-case stray fire against the empty-runId/seq-0 slice to
      //    prove even a rogue alarm cannot un-start the run.
      const alarm: MonitoredRunTimerMsg = armed
        ? { type: "deadline_exceeded", id: armed.id, atMs: armed.atMs }
        : { type: "deadline_exceeded", id: "monitored:safety::0", atMs: 1000 };

      const { state } = bound.replay({ msgs: [alarm] });

      // 3. END STATE: a never-started run must NOT be `failed`. Pre-fix this is
      //    `failed { reason: "deadline" }` because the born-live watchdog armed
      //    and its alarm matched `safetyTimerId("", 0)`.
      expect(state.run.phase).toBe("running");
      expect(state.run.failure).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Properties — invariants over arbitrary verb sequences.
// ---------------------------------------------------------------------------

describe("createMonitoredRun — properties", () => {
  it("verbs never mutate their input slice (immutability, nested)", () => {
    const run = createMonitoredRun<Stage, Checkpoint>({
      stages: STAGES,
      deadlineMs: 1000,
      snapshotEvery: 3,
    });
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100_000 }), (at) => {
        // Deep-freeze the input slice: the slice carries NESTED structure — the
        // `stepStates` stage queue (an array of QueueItem objects) and the
        // `snapshot` sub-slice. A shallow Object.freeze only locks the top-level
        // record; a verb that spliced an item in place (`stepStates[i].status =
        // …`) or reached into `snapshot` would slip past it. A recursive freeze
        // makes ANY nested write throw in strict mode, and the deep-equal guard
        // below catches a mutation that somehow lands on an unfrozen branch.
        const started = run.start(run.init(), "r", at)[0];
        const frozen = deepFreeze(started);
        // A pristine deep copy of the input, captured BEFORE any verb runs.
        const inputSnapshot: MonitoredRunState<Stage> =
          structuredClone(started);

        const [s1] = run.progress(frozen, { step: 1 }, at + 1);
        const [s2] = run.advance(frozen, { step: 1 }, { kind: "ok" }, at + 1);
        const [s3] = run.markStale(frozen);
        const [s4] = run.boot(frozen, at + 2);
        const [s5] = run.onDeadline(frozen, {
          type: "deadline_exceeded",
          id: "monitored:safety:r:0",
          atMs: at + 3,
        });

        // Every verb returns a NEW top-level reference.
        expect(s1).not.toBe(frozen);
        expect(s2).not.toBe(frozen);
        expect(s3).not.toBe(frozen);
        expect(s4).not.toBe(frozen);
        // onDeadline at seq 0 matches the live alarm → fails → new reference.
        expect(s5).not.toBe(frozen);

        // The input slice — including every nested array/object — is byte-for-byte
        // unchanged after all five verbs ran against it.
        expect(frozen).toEqual(inputSnapshot);
        // The nested stage queue identity is preserved too (no in-place splice).
        expect(frozen.stepStates).toEqual(inputSnapshot.stepStates);
        expect(frozen.snapshot).toEqual(inputSnapshot.snapshot);
        return true;
      }),
    );
  });

  it("progressSeq is monotonically non-decreasing across any verb sequence", () => {
    const run = createMonitoredRun<Stage, Checkpoint>({
      stages: STAGES,
      deadlineMs: 1000,
    });
    type Action =
      | { kind: "progress"; at: number }
      | { kind: "advance"; at: number }
      | { kind: "stale" }
      | { kind: "boot"; at: number };
    const action = fc.oneof(
      fc.record({ kind: fc.constant("progress" as const), at: fc.nat(50_000) }),
      fc.record({ kind: fc.constant("advance" as const), at: fc.nat(50_000) }),
      fc.record({ kind: fc.constant("stale" as const) }),
      fc.record({ kind: fc.constant("boot" as const), at: fc.nat(50_000) }),
    );
    fc.assert(
      fc.property(fc.array(action, { maxLength: 40 }), (actions: Action[]) => {
        let s = run.start(run.init(), "r", 0)[0];
        let prevSeq = s.progressSeq;
        for (const a of actions) {
          switch (a.kind) {
            case "progress":
              [s] = run.progress(s, { step: 0 }, a.at);
              break;
            case "advance":
              [s] = run.advance(s, { step: 0 }, { kind: "ok" }, a.at);
              break;
            case "stale":
              [s] = run.markStale(s);
              break;
            case "boot":
              [s] = run.boot(s, a.at);
              break;
          }
          if (s.progressSeq < prevSeq) return false;
          prevSeq = s.progressSeq;
        }
        return true;
      }),
    );
  });

  it("at most one running stage exists at any point in the pipeline", () => {
    const run = createMonitoredRun<Stage, Checkpoint>({ stages: STAGES });
    fc.assert(
      fc.property(fc.array(fc.nat(1000), { maxLength: 20 }), (ats) => {
        let s = run.start(run.init(), "r", 0)[0];
        const running0 = s.stepStates.filter(
          (i) => i.status === "running",
        ).length;
        if (running0 > 1) return false;
        for (const at of ats) {
          [s] = run.advance(s, { step: 0 }, { kind: "ok" }, at);
          const running = s.stepStates.filter(
            (i) => i.status === "running",
          ).length;
          if (running > 1) return false;
        }
        return true;
      }),
    );
  });

  // -------------------------------------------------------------------------
  // DURABILITY GUARD — the package-wide invariant. Every reachable TERMINAL
  // slice of this module must round-trip through JSON unchanged: a DO eviction +
  // reload must resurrect the exact slice that was saved, never a lossy or
  // mutated one. `readonly` fields type-enforce immutability; this property
  // enforces serializability. The slice is plain data end to end — the stage
  // queue is `QueueItem<Stage>[]` (plain records), the snapshot sub-slice is
  // plain numbers, and the `failure` reason carries a plain-data `{_tag}`-style
  // error sentinel (the canon: errors are data, never `Error` objects whose
  // `JSON.stringify` collapses to `{}`). If any verb ever introduced a Date, a
  // Map, or an Error into the slice, this property fails.
  //
  // We drive arbitrary verb sequences (every verb, including a stage-fail that
  // settles `failed { reason: "stage" }` and a live deadline that settles
  // `failed { reason: "deadline" }`), then — if still live — DRAIN to a genuine
  // terminal: advance-ok until the pipeline finishes to `done`. We assert the
  // round-trip on every intermediate slice (each is a persisted boundary value)
  // AND on the final terminal fixpoint.
  // -------------------------------------------------------------------------
  it("every reachable TERMINAL slice round-trips through JSON unchanged (durable)", () => {
    const run = createMonitoredRun<Stage, Checkpoint>({
      stages: STAGES,
      deadlineMs: 500,
      snapshotEvery: 2,
      snapshotKey: "run/cp",
    });
    type Action =
      | { kind: "progress"; at: number }
      | { kind: "advance"; ok: boolean; at: number }
      | { kind: "deadline"; at: number }
      | { kind: "boot"; at: number }
      | { kind: "stale" }
      | { kind: "confirm"; seq: number; at: number };
    // A plain-data error sentinel — the canon shape a consumer hands `advance`.
    const errorArb = fc.record({
      _tag: fc.constant("stage_error" as const),
      detail: fc.string(),
    });
    const action = fc.oneof(
      fc.record({ kind: fc.constant("progress" as const), at: fc.nat(10_000) }),
      fc.record({
        kind: fc.constant("advance" as const),
        ok: fc.boolean(),
        at: fc.nat(10_000),
      }),
      fc.record({ kind: fc.constant("deadline" as const), at: fc.nat(10_000) }),
      fc.record({ kind: fc.constant("boot" as const), at: fc.nat(10_000) }),
      fc.record({ kind: fc.constant("stale" as const) }),
      fc.record({
        kind: fc.constant("confirm" as const),
        seq: fc.nat(20),
        at: fc.nat(10_000),
      }),
    );
    fc.assert(
      fc.property(
        fc.array(action, { maxLength: 40 }),
        errorArb,
        (actions: Action[], stageError) => {
          let s = run.start(run.init(), "r", 0)[0];
          const roundTrips = (slice: MonitoredRunState<Stage>) => {
            const back: MonitoredRunState<Stage> = JSON.parse(
              JSON.stringify(slice),
            );
            expect(back).toEqual(slice);
          };
          roundTrips(s); // the started slice is itself a persisted boundary

          for (const a of actions) {
            switch (a.kind) {
              case "progress":
                [s] = run.progress(s, { step: 0 }, a.at);
                break;
              case "advance":
                [s] = run.advance(
                  s,
                  { step: 0 },
                  a.ok ? { kind: "ok" } : { kind: "fail", error: stageError },
                  a.at,
                );
                break;
              case "deadline":
                [s] = run.onDeadline(s, {
                  type: "deadline_exceeded",
                  id: `monitored:safety:r:${s.progressSeq}`,
                  atMs: a.at,
                });
                break;
              case "boot":
                [s] = run.boot(s, a.at);
                break;
              case "stale":
                [s] = run.markStale(s);
                break;
              case "confirm":
                s = run.confirmSnapshot(s, snapshotSaved(a.seq, a.at));
                break;
            }
            // Every intermediate slice is a save/reload boundary.
            roundTrips(s);
          }

          // Drain to a genuine terminal: advance-ok until the run finishes.
          for (let guard = 0; guard < 10; guard++) {
            if (s.phase === "done" || s.phase === "failed") break;
            [s] = run.advance(s, { step: 0 }, { kind: "ok" }, 9_000 + guard);
          }
          // The drained slice IS terminal (the pipeline has at most 3 stages, so
          // 10 ok-advances always finish a live run).
          expect(s.phase === "done" || s.phase === "failed").toBe(true);
          // The terminal fixpoint round-trips equal.
          roundTrips(s);
          return true;
        },
      ),
    );
  });

  it("once settled (done/failed), no verb un-settles the run", () => {
    const run = createMonitoredRun<Stage, Checkpoint>({
      stages: STAGES,
      deadlineMs: 500,
    });
    type Action =
      | { kind: "progress"; at: number }
      | { kind: "advance"; ok: boolean; at: number }
      | { kind: "deadline"; at: number }
      | { kind: "boot"; at: number }
      | { kind: "stale" };
    const action = fc.oneof(
      fc.record({ kind: fc.constant("progress" as const), at: fc.nat(10_000) }),
      fc.record({
        kind: fc.constant("advance" as const),
        ok: fc.boolean(),
        at: fc.nat(10_000),
      }),
      fc.record({ kind: fc.constant("deadline" as const), at: fc.nat(10_000) }),
      fc.record({ kind: fc.constant("boot" as const), at: fc.nat(10_000) }),
      fc.record({ kind: fc.constant("stale" as const) }),
    );
    fc.assert(
      fc.property(fc.array(action, { maxLength: 40 }), (actions: Action[]) => {
        let s = run.start(run.init(), "r", 0)[0];
        let settled = false;
        for (const a of actions) {
          switch (a.kind) {
            case "progress":
              [s] = run.progress(s, { step: 0 }, a.at);
              break;
            case "advance":
              [s] = run.advance(
                s,
                { step: 0 },
                a.ok ? { kind: "ok" } : { kind: "fail", error: "e" },
                a.at,
              );
              break;
            case "deadline":
              [s] = run.onDeadline(s, {
                type: "deadline_exceeded",
                id: `monitored:safety:r:${s.progressSeq}`,
                atMs: a.at,
              });
              break;
            case "boot":
              [s] = run.boot(s, a.at);
              break;
            case "stale":
              [s] = run.markStale(s);
              break;
          }
          const isSettled = s.phase === "done" || s.phase === "failed";
          // Once settled, it must stay settled forever.
          if (settled && !isSettled) return false;
          if (isSettled) settled = true;
        }
        return true;
      }),
    );
  });
});
