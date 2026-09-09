import { describe, expect, it } from "vitest";
import {
  type BootingRuntime,
  DriveFailedError,
  DriveStalledError,
  defineMachine,
  driveToDone,
  type Interpret,
  QuiescenceTimeoutError,
  type Reducer,
  type Runtime,
  run,
  type Store,
  type SubId,
  subId,
} from "./index";
import { memoryStore } from "./mem";

// ───────────────────────────────────────────────────────────────────────────
// `driveToDone` (#57): one call from `start` to the terminal State, with the
// runtime stopped on every exit. Replaces the six-step loop — `await ready`,
// `observe`, park a promise, `dispatch`, `getState`, `stop` — whose failure
// modes were an observer left attached and a `stop` never awaited.
// ───────────────────────────────────────────────────────────────────────────

// A job that runs a fixed number of steps, driven by its own interpret
// follow-ups, then lands `done` — or `failed` when told to blow up.
type State = {
  readonly phase: "idle" | "running" | "done" | "failed";
  readonly steps: number;
};
type Msg =
  | { readonly type: "start" }
  | { readonly type: "step" }
  | { readonly type: "blow_up" };
type JobCmd = { readonly type: "next" } | { readonly type: "explode" };

function jobMachine() {
  const update: Reducer<State, Msg, JobCmd> = {
    start: (s) => [{ ...s, phase: "running" }, [{ type: "next" }]],
    step: (s) => {
      const steps = s.steps + 1;
      return steps >= 3
        ? [{ phase: "done", steps }, []]
        : [{ ...s, steps }, [{ type: "next" }]];
    },
    blow_up: (s) => [{ ...s, phase: "failed" }, []],
  };
  const interpret: Interpret<Msg, JobCmd, undefined> = {
    next: async () => ({ type: "step" }),
    explode: async () => ({ type: "blow_up" }),
  };
  return defineMachine<State, Msg, JobCmd, never, undefined>({
    init: (loaded) => [loaded ?? { phase: "idle", steps: 0 }, []],
    update,
    interpret,
  });
}

const isDone = (s: State): boolean => s.phase === "done";
const isFailed = (s: State): boolean => s.phase === "failed";

// Wrap the handle `run()` returns so the test can read what the drive did to
// it: how many observers are attached right now, and whether `stop()` settled.
// Spreading the runtime is sound — its members are closures, not `this` users.
function instrument<S, M extends { type: string }>(
  handle: BootingRuntime<S, M>,
) {
  let attached = 0;
  let stopped = false;
  const observeCounting = (rt: BootingRuntime<S, M>) => ({
    observe(observer: (msg: M, state: S) => void): () => void {
      attached++;
      const off = rt.observe(observer);
      return () => {
        attached--;
        off();
      };
    },
  });
  const wrapped: BootingRuntime<S, M> = {
    ...handle,
    ...observeCounting(handle),
    ready: handle.ready.then(
      (rt): Runtime<S, M> => ({ ...rt, ...observeCounting(rt) }),
    ),
    async stop() {
      await handle.stop();
      stopped = true;
    },
  };
  return {
    handle: wrapped,
    get attached() {
      return attached;
    },
    get stopped() {
      return stopped;
    },
  };
}

describe("driveToDone — resolves with the terminal State (#57)", () => {
  it("against /mem: resolves done, leaves no observer, has awaited stop", async () => {
    const store = memoryStore<State>();
    const probe = instrument(run(jobMachine(), { ctx: undefined, store }));
    const before = probe.attached;

    const final = await driveToDone(probe.handle, { type: "start" }, isDone);

    expect(final).toEqual({ phase: "done", steps: 3 });
    expect(probe.attached).toBe(before);
    expect(probe.stopped).toBe(true);
    // `stop()` flushed the final State — the store read back by the next run is
    // the terminal one, which is only true if stop was awaited to completion.
    expect(await store.load()).toEqual(final);
  });

  it("a machine that boots already terminal resolves on the boot State; start is never dispatched", async () => {
    const store = memoryStore<State>({ phase: "done", steps: 3 });
    const probe = instrument(run(jobMachine(), { ctx: undefined, store }));
    const applied: string[] = [];
    probe.handle.observe((msg) => {
      applied.push(msg.type);
    });

    const final = await driveToDone(probe.handle, { type: "start" }, isDone);

    expect(final).toEqual({ phase: "done", steps: 3 });
    expect(applied).toEqual([]);
    expect(probe.attached).toBe(1); // the test's own observer, nothing else
    expect(probe.stopped).toBe(true);
  });

  it("accepts an already-booted Runtime as the handle", async () => {
    const runtime = await run(jobMachine(), { ctx: undefined }).ready;
    const final = await driveToDone(runtime, { type: "start" }, isDone);
    expect(final.phase).toBe("done");
  });
});

describe("driveToDone — typed rejections (#57)", () => {
  it("a failed phase rejects with DriveFailedError carrying the final State", async () => {
    const probe = instrument(run(jobMachine(), { ctx: undefined }));

    const drive = driveToDone(probe.handle, { type: "blow_up" }, isDone, {
      failed: isFailed,
    });

    await expect(drive).rejects.toBeInstanceOf(DriveFailedError);
    await drive.catch((err: unknown) => {
      expect((err as DriveFailedError<State>).state).toEqual({
        phase: "failed",
        steps: 0,
      });
      expect((err as DriveFailedError<State>)._tag).toBe("DriveFailedError");
    });
    expect(probe.attached).toBe(0);
    expect(probe.stopped).toBe(true);
  });

  it("a machine that never settles rejects on the existing quiescence cap", async () => {
    // A livelock: `start` emits `loop`, whose interpret follow-up `tick`
    // re-emits `loop`. No State is ever terminal, so the only way out is the
    // cap `dispatch` already rejects on — no second clock.
    type S2 = { readonly ticks: number };
    type M2 = { readonly type: "start" } | { readonly type: "tick" };
    type C2 = { readonly type: "loop" };
    const update: Reducer<S2, M2, C2> = {
      start: (s) => [s, [{ type: "loop" }]],
      tick: (s) => [{ ticks: s.ticks + 1 }, [{ type: "loop" }]],
    };
    const interpret: Interpret<M2, C2, undefined> = {
      loop: async () => ({ type: "tick" }),
    };
    const livelock = defineMachine<S2, M2, C2, never, undefined>({
      init: () => [{ ticks: 0 }, []],
      update,
      interpret,
    });
    // The no-op `onError` absorbs the "runtime stopped" follow-up rejection the
    // in-flight loop produces once the drive tears the runtime down.
    const probe = instrument(
      run(livelock, { ctx: undefined, __idleCap: 25, onError: () => {} }),
    );

    await expect(
      driveToDone(probe.handle, { type: "start" }, () => false),
    ).rejects.toBeInstanceOf(QuiescenceTimeoutError);
    expect(probe.attached).toBe(0);
    expect(probe.stopped).toBe(true);
  });

  it("a start chain that quiesces on a non-terminal State with nothing live rejects with DriveStalledError (#68)", async () => {
    // `start` parks the machine in `waiting` with no Cmd and no Sub: the chain
    // is quiescent, nothing inside the runtime can move it, and before #68 the
    // drive waited on that forever with `stop()` never reached.
    type S3 = { readonly phase: "idle" | "waiting" | "done" };
    type M3 = { readonly type: "start" } | { readonly type: "finish" };
    const update: Reducer<S3, M3, never> = {
      start: () => [{ phase: "waiting" }, []],
      finish: () => [{ phase: "done" }, []],
    };
    const parker = defineMachine<S3, M3, never, never, undefined>({
      init: () => [{ phase: "idle" }, []],
      update,
    });
    const probe = instrument(run(parker, { ctx: undefined }));

    const drive = driveToDone(
      probe.handle,
      { type: "start" },
      (s) => s.phase === "done",
    );

    await expect(drive).rejects.toBeInstanceOf(DriveStalledError);
    await drive.catch((err: unknown) => {
      expect((err as DriveStalledError<S3>).state).toEqual({
        phase: "waiting",
      });
      expect((err as DriveStalledError<S3>)._tag).toBe("DriveStalledError");
    });
    expect(probe.attached).toBe(0);
    expect(probe.stopped).toBe(true);
  });

  it("a boot failure rejects with the boot error and still stops", async () => {
    // A store whose `load` throws is the boot failure that surfaces on `ready`.
    const boom = new Error("boot exploded");
    const store: Store<State> = {
      load: async () => {
        throw boom;
      },
      save: async () => {},
      migrate: () => null,
    };
    const probe = instrument(
      run(jobMachine(), { ctx: undefined, store, onError: () => {} }),
    );

    await expect(
      driveToDone(probe.handle, { type: "start" }, isDone),
    ).rejects.toBe(boom);
    expect(probe.stopped).toBe(true);
  });
});

// A Sub-driven machine is NOT stalled: the start dispatch quiesces on `waiting`,
// and the terminal Msg arrives later from the Sub the machine armed there. The
// stall gate (#68) must keep waiting for exactly this shape, on both Sub paths.
describe("driveToDone — terminal arrives via a Sub after quiescence (#68)", () => {
  type S4 = { readonly phase: "idle" | "waiting" | "done" };
  type M4 = { readonly type: "start" } | { readonly type: "finish" };
  const update: Reducer<S4, M4, never> = {
    start: () => [{ phase: "waiting" }, []],
    finish: () => [{ phase: "done" }, []],
  };
  const isDone4 = (s: S4): boolean => s.phase === "done";
  // A one-shot timer that delivers `finish` on a later macrotask — after the
  // quiescent drain has already returned.
  const finishLater = (dispatch: (msg: M4) => void): (() => void) => {
    const timer = setTimeout(() => dispatch({ type: "finish" }), 5);
    return () => clearTimeout(timer);
  };

  it("dep-keyed Sub (`machine.subs`): resolves with the State the Sub delivered", async () => {
    const machine = defineMachine<S4, M4, never, never, undefined>({
      init: () => [{ phase: "idle" }, []],
      update,
      subs: [
        {
          deps: (s) => (s.phase === "waiting" ? { armed: true } : null),
          source: (_s, dispatch) => finishLater(dispatch),
        },
      ],
    });
    const probe = instrument(run(machine, { ctx: undefined }));

    const final = await driveToDone(probe.handle, { type: "start" }, isDone4);

    expect(final).toEqual({ phase: "done" });
    expect(probe.attached).toBe(0);
    expect(probe.stopped).toBe(true);
  });

  it("manual Sub (`subscriptions` + `subscribe`): resolves with the State the Sub delivered", async () => {
    type U4 = { readonly type: "timer"; readonly id: SubId };
    const machine = defineMachine<S4, M4, never, U4, undefined>({
      init: () => [{ phase: "idle" }, []],
      update,
      subscriptions: (s) =>
        s.phase === "waiting" ? [{ type: "timer", id: subId("finish") }] : [],
      subscribe: {
        timer: (_sub, _ctx, dispatch) => finishLater(dispatch),
      },
    });
    const probe = instrument(run(machine, { ctx: undefined }));

    const final = await driveToDone(probe.handle, { type: "start" }, isDone4);

    expect(final).toEqual({ phase: "done" });
    expect(probe.attached).toBe(0);
    expect(probe.stopped).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// #147 — `{ signal, cancel }`: the outside-in stop. Cancellation is a
// TRANSITION, so the drive resolves on the State the cancel Msg lands rather
// than throwing past a runtime nobody stopped.
// ───────────────────────────────────────────────────────────────────────────

describe("driveToDone — cancellation via an AbortSignal", () => {
  type S5 = { readonly phase: "idle" | "running" | "done" | "halted" };
  type M5 =
    | { readonly type: "start" }
    | { readonly type: "halt" }
    | { readonly type: "boom" };
  type C5 = { readonly type: "loop" };

  // A machine that never finishes on its own: every `start` re-enters itself
  // through an interpret follow-up, so only a cancel can end the drive.
  function looper(onLoop: () => void) {
    const update: Reducer<S5, M5, C5> = {
      start: (s) =>
        s.phase === "halted"
          ? [s, []]
          : [{ phase: "running" }, [{ type: "loop" }]],
      halt: () => [{ phase: "halted" }, []],
      // A cancel fold that throws instead of landing a State — the shape a
      // direct kernel consumer can hand `driveToDone` (#170).
      boom: () => {
        throw new Error("cancel fold blew up");
      },
    };
    const interpret: Interpret<M5, C5, undefined> = {
      loop: async () => {
        onLoop();
        return { type: "start" };
      },
    };
    return defineMachine<S5, M5, C5, never, undefined>({
      init: () => [{ phase: "idle" }, []],
      update,
      interpret,
    });
  }

  const isEnded5 = (s: S5): boolean =>
    s.phase === "done" || s.phase === "halted";
  const cancel5 = () => ({ type: "halt" }) as const;

  it("an already-aborted signal cancels in place of `start`, so its effects never fire", async () => {
    let loops = 0;
    const controller = new AbortController();
    controller.abort();
    const probe = instrument(
      run(
        looper(() => {
          loops++;
        }),
        { ctx: undefined },
      ),
    );

    const final = await driveToDone(probe.handle, { type: "start" }, isEnded5, {
      signal: controller.signal,
      cancel: cancel5,
    });

    expect(final).toEqual({ phase: "halted" });
    expect(loops).toBe(0);
    expect(probe.attached).toBe(0);
    expect(probe.stopped).toBe(true);
  });

  it("an abort mid-run resolves on the cancelled State and stops the loop", async () => {
    let loops = 0;
    const controller = new AbortController();
    const probe = instrument(
      run(
        looper(() => {
          loops++;
          if (loops === 2) controller.abort();
        }),
        { ctx: undefined },
      ),
    );

    const final = await driveToDone(probe.handle, { type: "start" }, isEnded5, {
      signal: controller.signal,
      cancel: cancel5,
    });

    expect(final).toEqual({ phase: "halted" });
    // The cancel Msg is enqueued on the same serial tail every dispatch uses, so
    // it lands between transitions: the work already queued folds, and nothing
    // the machine would have queued after it does. An unbounded loop is the
    // sharpest way to say that — without the stop this drive never returns.
    expect(loops).toBeLessThan(5);
    expect(probe.attached).toBe(0);
    expect(probe.stopped).toBe(true);
  });

  it("resolves the cancellation even with a `failed` predicate wired", async () => {
    const controller = new AbortController();
    controller.abort();
    const probe = instrument(
      run(
        looper(() => {}),
        { ctx: undefined },
      ),
    );

    const final = await driveToDone(probe.handle, { type: "start" }, isEnded5, {
      // The drive does not add the cancelled State to the failure set behind the
      // caller's back: only a State THIS predicate marks rejects, and it does not
      // mark `halted`.
      failed: (s) => s.phase === "done",
      signal: controller.signal,
      cancel: cancel5,
    });

    expect(final).toEqual({ phase: "halted" });
  });

  // #170 — the cancel fold is the only thing that can land the terminal State
  // on an abort, so a throw there used to leave the drive awaiting a promise
  // nothing could resolve: no rejection, no `DriveStalledError`, a hang.
  const boom5 = () => ({ type: "boom" }) as const;

  it("an already-aborted signal whose cancel Msg throws rejects instead of hanging", async () => {
    const controller = new AbortController();
    controller.abort();
    const probe = instrument(
      run(
        looper(() => {}),
        // The reduce throw reaches the sink too (invariant 6); the drive's
        // rejection is the claim under test, not the report.
        { ctx: undefined, onError: () => {} },
      ),
    );

    await expect(
      driveToDone(probe.handle, { type: "start" }, isEnded5, {
        signal: controller.signal,
        cancel: boom5,
      }),
    ).rejects.toThrow("cancel fold blew up");
    expect(probe.attached).toBe(0);
    expect(probe.stopped).toBe(true);
  });

  it("an abort mid-run whose cancel Msg throws rejects too, `started` long since resolved", async () => {
    const controller = new AbortController();
    let loops = 0;
    const probe = instrument(
      run(
        looper(() => {
          loops++;
          if (loops === 2) controller.abort();
        }),
        { ctx: undefined, onError: () => {} },
      ),
    );

    await expect(
      driveToDone(probe.handle, { type: "start" }, isEnded5, {
        signal: controller.signal,
        cancel: boom5,
      }),
    ).rejects.toThrow("cancel fold blew up");
    expect(probe.attached).toBe(0);
    expect(probe.stopped).toBe(true);
  });

  it("an already-aborted signal whose cancel lands a `failed` State rejects with DriveFailedError", async () => {
    const controller = new AbortController();
    controller.abort();
    const probe = instrument(
      run(
        looper(() => {}),
        { ctx: undefined },
      ),
    );

    // The already-aborted exit runs the same `failed` check every other exit
    // does: same inputs, one answer, whichever path reached the State.
    await expect(
      driveToDone(probe.handle, { type: "start" }, isEnded5, {
        failed: (s) => s.phase === "halted",
        signal: controller.signal,
        cancel: cancel5,
      }),
    ).rejects.toThrow(DriveFailedError);
    expect(probe.stopped).toBe(true);
  });
});
